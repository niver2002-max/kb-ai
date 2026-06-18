"use server"

import { scanDirectory, makeWebSource } from "@/lib/kb/scan"
import { parseFile, fetchWeb, chunkSegments } from "@/lib/kb/parse"
import { embedSegments, visionExtract } from "@/lib/kb/embed"
import { geminiJson } from "@/lib/kb/gemini"
import {
  readIndex,
  upsertSources,
  updateSource,
  replaceChunks,
  removeSource as removeSourceFromStore,
  setRootDir,
  resetIndex,
} from "@/lib/kb/store"
import type { KbSource } from "@/lib/kb/types"

// 返回给前端的精简状态（不含 embedding，避免传输过大）
export async function getKbState() {
  const index = await readIndex()
  return {
    rootDir: index.rootDir,
    updatedAt: index.updatedAt,
    sources: index.sources,
    chunkCount: index.chunks.length,
  }
}

// 1. 扫描本地目录
export async function scanDir(rootDir: string) {
  if (!rootDir?.trim()) throw new Error("请输入目录路径")
  const result = await scanDirectory(rootDir.trim())
  await setRootDir(result.rootDir)
  await upsertSources(result.sources)
  return getKbState()
}

// 添加网页来源
export async function addWebSources(urlsText: string) {
  const urls = urlsText
    .split(/[\n,;]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u))
  if (urls.length === 0) throw new Error("未发现有效的 http(s) 链接")
  const sources = urls.map(makeWebSource)
  await upsertSources(sources)
  return getKbState()
}

export async function removeSource(id: string) {
  await removeSourceFromStore(id)
  return getKbState()
}

export async function resetKb() {
  await resetIndex()
  return getKbState()
}

// 2. LLM 初筛：根据 prompt 给每个来源打相关性分并给出一句话说明
export async function screenSources(userPrompt: string) {
  const index = await readIndex()
  const candidates = index.sources.filter(
    (s) => s.category !== "binary" && s.status !== "embedded",
  )
  if (candidates.length === 0) return getKbState()

  // 批量交给模型，控制单批数量
  const batchSize = 40
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    const listing = batch
      .map(
        (s, idx) =>
          `${idx}. [${s.category}] ${s.name} (${formatSize(s.sizeBytes)})`,
      )
      .join("\n")

    const output = await geminiJson<{
      items: Array<{ index: number; relevance: number; note: string }>
    }>(
      `用户的知识库目标是：「${userPrompt || "通用知识整理"}」。\n` +
        `下面是扫描到的文件列表（仅文件名与类型，无内容）。\n` +
        `请基于文件名和类型，判断每个文件与目标的相关性(0-1)，并用一句中文说明理由。\n` +
        `只依据已知信息，不要臆测。按下列编号返回：\n\n${listing}`,
      {
        type: "OBJECT",
        properties: {
          items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                index: { type: "INTEGER" },
                relevance: { type: "NUMBER" },
                note: { type: "STRING" },
              },
              required: ["index", "relevance", "note"],
            },
          },
        },
        required: ["items"],
      },
      { thinking: "adaptive" },
    )

    for (const item of output.items) {
      const src = batch[item.index]
      if (!src) continue
      await updateSource(src.id, {
        relevance: item.relevance,
        note: item.note,
      })
    }
  }
  return getKbState()
}

// 3. 构建知识库：解析 + 切块 + 嵌入。可选只处理相关性达标的来源。
export async function buildKb(opts?: {
  minRelevance?: number
  includeIds?: string[]
}) {
  const index = await readIndex()
  let targets = index.sources.filter((s) => s.category !== "binary")

  if (opts?.includeIds && opts.includeIds.length > 0) {
    const set = new Set(opts.includeIds)
    targets = targets.filter((s) => set.has(s.id))
  } else if (typeof opts?.minRelevance === "number") {
    targets = targets.filter(
      (s) => (s.relevance ?? 1) >= (opts.minRelevance as number),
    )
  }

  let processed = 0
  let failed = 0
  for (const source of targets) {
    try {
      await updateSource(source.id, { status: "parsing" })
      const segments = await parseOne(source)
      if (segments.length === 0) {
        await updateSource(source.id, {
          status: "skipped",
          note: source.note ?? "无可提取文本",
        })
        continue
      }
      const chunks = chunkSegments(segments)
      const embedded = await embedSegments(source.id, chunks)
      await replaceChunks(source.id, embedded)
      await updateSource(source.id, {
        status: "embedded",
        charCount: segments.reduce((n, s) => n + s.text.length, 0),
        chunkCount: embedded.length,
        error: undefined,
      })
      processed++
    } catch (err) {
      failed++
      await updateSource(source.id, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const state = await getKbState()
  return { ...state, processed, failed }
}

async function parseOne(source: KbSource) {
  if (source.kind === "web") {
    const r = await fetchWeb(source.location)
    return r.segments
  }
  const result = await parseFile(source)
  if (result.needsVision) {
    // 图片型/扫描件走视觉模型
    return visionExtract(source)
  }
  return result.segments
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
