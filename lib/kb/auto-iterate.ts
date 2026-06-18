import { promises as fs } from "node:fs"
import path from "node:path"
import type { AutoIterateTask, KbLibrary } from "./types"
import { getLibrary, patchLibrary } from "./library"
import { readIndex, writeIndex, updateSource } from "./store"
import { geminiText, geminiSearch } from "./gemini"
import { embedSegments } from "./embed"

// 默认配置
export const DEFAULT_AUTO_ITERATE = {
  enabled: false,
  tasks: ["notes", "gaps", "reindex"] as AutoIterateTask[],
  intervalMinutes: 60,
  idleMinutes: 15,
}

// 每次迭代处理的来源/片段上限（控制 token 消耗）
const BATCH = 3

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

// 写一篇笔记到知识库 notes/ 目录
async function writeNote(lib: KbLibrary, name: string, body: string): Promise<string> {
  const dir = path.join(lib.rootDir, "notes")
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.writeFile(file, body, "utf8")
  return file
}

// ===== 任务一：为缺少摘要的来源生成笔记 =====
async function taskNotes(lib: KbLibrary): Promise<string> {
  const index = await readIndex(lib.id)
  // 已入库但还没有 note 的来源
  const targets = index.sources
    .filter((s) => s.status === "embedded" && !s.note)
    .slice(0, BATCH)
  if (targets.length === 0) return "笔记：所有来源均已有摘要，无需补全"

  let done = 0
  for (const src of targets) {
    const chunks = index.chunks
      .filter((c) => c.sourceId === src.id)
      .slice(0, 12)
      .map((c) => c.text)
      .join("\n\n")
    if (!chunks.trim()) continue
    const summary = await geminiText(
      `你在维护一个知识库（面向：${lib.audience || "通用"}）。请为以下资料生成一份简洁的中文笔记，` +
        `包含：一句话概述、3-6 个要点、与其它主题的关联线索。资料名：${src.name}\n\n内容：\n"""${chunks.slice(0, 12000)}"""`,
      { thinking: "adaptive" },
    )
    await writeNote(
      lib,
      `summary-${src.name.replace(/[^\w.-]+/g, "_")}.md`,
      `# ${src.name} · 摘要笔记\n\n> 自动生成于 ${new Date().toLocaleString()}\n\n${summary}\n`,
    )
    // 把一句话概述写回 source.note
    const firstLine = summary.split("\n").find((l) => l.trim())?.slice(0, 200) ?? ""
    await updateSource(lib.id, src.id, { note: firstLine })
    done++
  }
  return `笔记：为 ${done} 个来源生成摘要笔记`
}

// ===== 任务二：分析知识缺口并联网补充 =====
async function taskGaps(lib: KbLibrary): Promise<string> {
  const index = await readIndex(lib.id)
  if (index.sources.length === 0) return "缺口：暂无来源，跳过"
  // 用现有来源标题 + 分类，让模型找出明显缺口
  const inventory = index.sources.map((s) => `- ${s.name}（${s.category}）`).join("\n")
  const cats = index.workflow.categories.map((c) => c.name).join("、") || "（未分类）"
  const gapJson = await geminiText(
    `这是一个知识库（面向：${lib.audience || "通用"}），现有资料清单：\n${inventory}\n\n` +
      `现有分类：${cats}\n\n请指出最重要的 1 个知识缺口（现有资料明显缺失、但对该知识库目标很关键的主题），` +
      `只回复这个缺口的简短主题词（一行，不超过 30 字）。`,
    { thinking: "adaptive" },
  )
  const gap = gapJson.split("\n").find((l) => l.trim())?.trim().slice(0, 60)
  if (!gap) return "缺口：未识别到明显缺口"

  // 联网检索补充
  const supplement = await geminiSearch(
    `围绕「${gap}」，面向「${lib.audience || "通用"}」整理一份准确、可引用的中文资料综述，` +
      `包含关键概念、要点与权威来源链接。`,
  )
  const file = await writeNote(
    lib,
    `gap-${nowStamp()}.md`,
    `# 知识缺口补充：${gap}\n\n> 自动联网补充于 ${new Date().toLocaleString()}\n\n${supplement}\n`,
  )
  return `缺口：补充了「${gap}」→ ${path.basename(file)}`
}

// ===== 任务三：重建索引 / 去重 =====
async function taskReindex(lib: KbLibrary): Promise<string> {
  const index = await readIndex(lib.id)

  // 1) 补嵌入：为缺失 embedding 的片段重新嵌入
  const missing = index.chunks.filter((c) => !c.embedding || c.embedding.length === 0).slice(0, 30)
  let embedded = 0
  if (missing.length > 0) {
    const segs = missing.map((c) => ({ text: c.text, loc: c.loc }))
    const vectors = await embedSegments(segs)
    for (let i = 0; i < missing.length; i++) {
      if (vectors[i]?.embedding?.length) {
        missing[i].embedding = vectors[i].embedding
        embedded++
      }
    }
  }

  // 2) 去重：移除完全重复（文本一致）的片段
  const seen = new Set<string>()
  const before = index.chunks.length
  index.chunks = index.chunks.filter((c) => {
    const key = `${c.sourceId}::${c.text.trim()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const removed = before - index.chunks.length

  if (embedded > 0 || removed > 0) {
    await writeIndex(lib.id, index)
  }
  return `重建索引：补嵌入 ${embedded} 片段，去重 ${removed} 片段`
}

const TASK_FN: Record<AutoIterateTask, (lib: KbLibrary) => Promise<string>> = {
  notes: taskNotes,
  gaps: taskGaps,
  reindex: taskReindex,
}

// 执行一次迭代：按轮转选下一个启用的任务并运行，记录结果
export async function runIteration(libId: string): Promise<string | null> {
  const lib = await getLibrary(libId)
  if (!lib?.autoIterate?.enabled) return null
  const cfg = lib.autoIterate
  const tasks = cfg.tasks.length ? cfg.tasks : DEFAULT_AUTO_ITERATE.tasks
  if (cfg.running) return null // 防重入

  // 轮转选任务
  const startIdx = ((cfg.lastTaskIndex ?? -1) + 1) % tasks.length
  const task = tasks[startIdx]

  await patchLibrary(libId, { autoIterate: { ...cfg, running: true } })
  let result = ""
  try {
    result = await TASK_FN[task](lib)
  } catch (e) {
    result = `任务「${task}」失败：${e instanceof Error ? e.message : "未知错误"}`
  }
  // 记录结果（重新读取以避免覆盖期间的其它变更）
  const fresh = await getLibrary(libId)
  const freshCfg = fresh?.autoIterate ?? cfg
  await patchLibrary(libId, {
    autoIterate: {
      ...freshCfg,
      running: false,
      lastRunAt: Date.now(),
      lastTaskIndex: startIdx,
      lastResult: `[${new Date().toLocaleTimeString()}] ${result}`,
    },
  })
  return result
}
