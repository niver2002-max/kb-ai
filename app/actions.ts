"use server"

import { scanDirectory, scanSingleFile, makeWebSource } from "@/lib/kb/scan"
import { parseFile, fetchWeb, chunkSegments } from "@/lib/kb/parse"
import { embedSegments, visionExtract } from "@/lib/kb/embed"
import { geminiJson, geminiContents } from "@/lib/kb/gemini"
import { mapLimit } from "@/lib/kb/concurrency"
import {
  classifySite,
  enumerateSite,
  selectLinks,
  downloadToProject,
  fetchLinkContent,
} from "@/lib/kb/crawl"
import {
  readIndex,
  upsertSources,
  updateSource,
  replaceChunks,
  removeSource as removeSourceFromStore,
  setRootDir,
  resetIndex,
  patchWorkflow,
  readWorkflow,
  upsertCrawl,
  patchCrawl,
  patchCrawlLinks,
  readCrawl,
} from "@/lib/kb/store"
import {
  listLibraries,
  getLibrary,
  createLibrary,
  patchLibrary,
  deleteLibrary,
  initLibraryDir,
} from "@/lib/kb/library"
import {
  readSession,
  appendMessage,
  clearSession,
} from "@/lib/kb/session"
import { getSettings, updateSettings, type ApiSettings } from "@/lib/kb/settings"
import {
  testEndpoint as probeEndpoint,
  listModels as probeListModels,
  pingModel as probePingModel,
  type EndpointTestResult,
  type ModelInfo,
  type ModelLiveResult,
} from "@/lib/kb/api-probe"
import { startInspection, stopInspection, readInspection } from "@/lib/kb/inspection"
import type { KbSource, KbQuestion, KbCategory, KbLibrary, InspectionState } from "@/lib/kb/types"

// ===================================================================
// 多知识库管理
// ===================================================================

export async function getLibraries(): Promise<KbLibrary[]> {
  return listLibraries()
}

export async function getLibraryById(id: string): Promise<KbLibrary | null> {
  return getLibrary(id)
}

// 新建知识库：登记元信息 → 初始化目录分层 + git
export async function createKbLibrary(input: {
  title: string
  audience: string
  rootDir: string
  sourceMode: KbLibrary["sourceMode"]
}) {
  const lib = await createLibrary(input)
  try {
    const { hasGit } = await initLibraryDir(lib)
    const updated = await patchLibrary(lib.id, { hasGit, initialized: true })
    // 同步根目录到该库索引
    await setRootDir(lib.id, lib.rootDir)
    return updated ?? lib
  } catch (err) {
    await patchLibrary(lib.id, {
      initialized: false,
    })
    throw err
  }
}

export async function deleteKbLibrary(id: string) {
  await deleteLibrary(id)
  return listLibraries()
}

// ===================================================================
// API 设置 + 智能测试（测端点 / 列模型 / 测活模型）
// ===================================================================

export async function getApiSettings(): Promise<ApiSettings> {
  return getSettings()
}

export async function saveApiSettings(partial: Partial<ApiSettings>): Promise<ApiSettings> {
  return updateSettings(partial)
}

// 智能测端点：自动尝试多种端点路径变体，返回可用地址
export async function testApiEndpoint(baseUrl: string, apiKey: string): Promise<EndpointTestResult> {
  return probeEndpoint(baseUrl, apiKey)
}

// 智能列模型：列出端点下全部模型并标注可对话/可嵌入
export async function listApiModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; baseUrl: string; models: ModelInfo[]; message: string }> {
  return probeListModels(baseUrl, apiKey)
}

// 智能测活：对一批模型并发发最小请求，返回存活与延迟
export async function pingApiModels(
  baseUrl: string,
  apiKey: string,
  models: Array<{ id: string; kind: "generate" | "embed" }>,
): Promise<ModelLiveResult[]> {
  return mapLimit(models, 4, (m) => probePingModel(baseUrl, apiKey, m.id, m.kind))
}

// ===================================================================
// 高级模型巡检（goal 驱动自迭代；gemini-3.1-pro 决策，服务端常驻、关窗不停）
// ===================================================================

// 读取某库巡检状态（前端轮询展示用；会顺带触发服务器重启后的续跑）
export async function getInspectionState(libId: string): Promise<InspectionState> {
  return readInspection(libId)
}

// 开启巡检（进入巡检态，对话框置灰；引擎在服务端持续跑直到 done 或手动结束）
export async function startInspectionAction(libId: string): Promise<InspectionState> {
  return startInspection(libId)
}

// 手动结束巡检（下一轮边界处停止，随后恢复对话模式）
export async function stopInspectionAction(libId: string): Promise<InspectionState> {
  return stopInspection(libId)
}

// ===================================================================
// 文件系统浏览（应用内目录/文件选择弹窗用）
// ===================================================================

export interface FsEntry {
  name: string
  path: string
  isDir: boolean
}

export interface BrowseResult {
  cwd: string // 当前目录绝对路径
  parent: string | null // 上级目录（根目录为 null）
  entries: FsEntry[]
}

// 列出某目录下的子目录与文件。dirPath 为空时从用户主目录开始。
// onlyDirs=true 仅返回目录（选目录场景）。
export async function browseFs(
  dirPath?: string,
  opts?: { onlyDirs?: boolean },
): Promise<BrowseResult> {
  const os = await import("node:os")
  const fsmod = await import("node:fs/promises")
  const pathmod = await import("node:path")

  const base = dirPath?.trim() ? pathmod.resolve(dirPath.trim()) : os.homedir()
  // 校验目录存在且可读；不可读时回退主目录
  let cwd = base
  try {
    const stat = await fsmod.stat(cwd)
    if (!stat.isDirectory()) cwd = pathmod.dirname(cwd)
  } catch {
    cwd = os.homedir()
  }

  let dirents: import("node:fs").Dirent[] = []
  try {
    dirents = await fsmod.readdir(cwd, { withFileTypes: true })
  } catch {
    throw new Error(`无法读取目录：${cwd}`)
  }

  const onlyDirs = opts?.onlyDirs ?? false
  const entries: FsEntry[] = dirents
    .filter((d) => !d.name.startsWith(".")) // 隐藏点文件/点目录
    .filter((d) => {
      const isDir = d.isDirectory()
      return onlyDirs ? isDir : isDir || d.isFile()
    })
    .map((d) => ({
      name: d.name,
      path: pathmod.join(cwd, d.name),
      isDir: d.isDirectory(),
    }))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1 // 目录在前
      return a.name.localeCompare(b.name)
    })

  const parent = pathmod.dirname(cwd)
  return {
    cwd,
    parent: parent === cwd ? null : parent,
    entries,
  }
}

// 新建子目录（选目录弹窗里"新建文件夹"用）
export async function makeDir(parentDir: string, name: string): Promise<string> {
  const pathmod = await import("node:path")
  const fsmod = await import("node:fs/promises")
  const safe = name.trim().replace(/[/\\]/g, "")
  if (!safe) throw new Error("请输入文件夹名称")
  const target = pathmod.join(pathmod.resolve(parentDir), safe)
  await fsmod.mkdir(target, { recursive: true })
  return target
}

// ===================================================================
// 会话持久化（resume / 读取 / 清空）
// ===================================================================

export async function getSession(libId: string) {
  return readSession(libId)
}

export async function clearKbSession(libId: string) {
  await clearSession(libId)
  return readSession(libId)
}

// 写入一条用户消息（前端发起对话前调用，便于乐观更新与持久化解耦时使用）
export async function appendUserMessage(
  libId: string,
  content: string,
  scope?: { type: "category" | "source"; id: string; label: string } | null,
) {
  return appendMessage(libId, { role: "user", content, scope: scope ?? null })
}

// ===================================================================
// 知识库状态
// ===================================================================

// 返回给前端的精简状态（不含 embedding，避免传输过大）
export async function getKbState(libId: string) {
  const index = await readIndex(libId)
  return {
    libId,
    rootDir: index.rootDir,
    updatedAt: index.updatedAt,
    sources: index.sources,
    chunkCount: index.chunks.length,
    workflow: index.workflow,
  }
}

// 1. 扫描本地目录
export async function scanDir(libId: string, rootDir: string) {
  if (!rootDir?.trim()) throw new Error("请输入目录路径")
  const result = await scanDirectory(rootDir.trim())
  await setRootDir(libId, result.rootDir)
  await upsertSources(libId, result.sources)
  return getKbState(libId)
}

// 导入单个文件：扫描 → 自动归类 → 登记为来源（待构建入库）
export async function importSingleFile(libId: string, filePath: string) {
  if (!filePath?.trim()) throw new Error("请输入文件路径")
  const source = await scanSingleFile(filePath.trim())
  await upsertSources(libId, [source])
  return { source, state: await getKbState(libId) }
}

// 添加网页来源
export async function addWebSources(libId: string, urlsText: string) {
  const urls = urlsText
    .split(/[\n,;]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u))
  if (urls.length === 0) throw new Error("未发现有效的 http(s) 链接")
  const sources = urls.map(makeWebSource)
  await upsertSources(libId, sources)
  return getKbState(libId)
}

export async function removeSource(libId: string, id: string) {
  await removeSourceFromStore(libId, id)
  return getKbState(libId)
}

export async function resetKb(libId: string) {
  await resetIndex(libId)
  return getKbState(libId)
}

// 2. LLM 初筛：根据 prompt 给每个来源打相关性分并给出一句话说明
export async function screenSources(libId: string, userPrompt: string) {
  const index = await readIndex(libId)
  const candidates = index.sources.filter(
    (s) => s.category !== "binary" && s.status !== "embedded",
  )
  if (candidates.length === 0) return getKbState(libId)

  const batchSize = 40
  const batches: KbSource[][] = []
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize))
  }

  await mapLimit(batches, 4, async (batch) => {
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
      await updateSource(libId, src.id, {
        relevance: item.relevance,
        note: item.note,
      })
    }
  })
  return getKbState(libId)
}

// 3. 构建知识库：解析 + 切块 + 嵌入。可选只处理相关性达标的来源。
export async function buildKb(
  libId: string,
  opts?: {
    minRelevance?: number
    includeIds?: string[]
  },
) {
  const index = await readIndex(libId)
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
  const concurrency = Number(process.env.KB_BUILD_CONCURRENCY ?? 4) || 4
  await mapLimit(targets, concurrency, async (source) => {
    try {
      await updateSource(libId, source.id, { status: "parsing" })
      const segments = await parseOne(source)
      if (segments.length === 0) {
        await updateSource(libId, source.id, {
          status: "skipped",
          note: source.note ?? "无可提取文本",
        })
        return
      }
      const chunks = chunkSegments(segments)
      const embedded = await embedSegments(source.id, chunks)
      await replaceChunks(libId, source.id, embedded)
      await updateSource(libId, source.id, {
        status: "embedded",
        charCount: segments.reduce((n, s) => n + s.text.length, 0),
        chunkCount: embedded.length,
        error: undefined,
      })
      processed++
    } catch (err) {
      failed++
      await updateSource(libId, source.id, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  const state = await getKbState(libId)
  return { ...state, processed, failed }
}

async function parseOne(source: KbSource) {
  if (source.kind === "web") {
    const r = await fetchWeb(source.location)
    return r.segments
  }
  const result = await parseFile(source)
  if (result.needsVision) {
    return visionExtract(source)
  }
  return result.segments
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ===================================================================
// 多阶段自适应构建流程（human-in-the-loop）
// ===================================================================

const QUESTIONS_SCHEMA = {
  type: "OBJECT",
  properties: {
    intro: { type: "STRING" },
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          question: { type: "STRING" },
          options: { type: "ARRAY", items: { type: "STRING" } },
          multiSelect: { type: "BOOLEAN" },
        },
        required: ["question", "options", "multiSelect"],
      },
    },
  },
  required: ["intro", "questions"],
} as const

function listCandidates(sources: KbSource[]): string {
  return sources
    .map(
      (s, i) =>
        `${i}. [${s.category}] ${s.name} ` +
        `(${s.kind === "web" ? s.location : formatSize(s.sizeBytes)})` +
        (typeof s.relevance === "number"
          ? ` 相关性${s.relevance.toFixed(2)}`
          : "") +
        (s.note ? ` — ${s.note}` : ""),
    )
    .join("\n")
}

// 阶段一：扫描结果已就绪 → 初筛 + 生成第一批澄清选择题
export async function startBuild(libId: string, userPrompt: string) {
  const prompt = (userPrompt || "").trim()
  await patchWorkflow(libId, { stage: "idle", userPrompt: prompt, busy: "初筛中" })

  await screenSources(libId, prompt)

  const index = await readIndex(libId)
  const candidates = index.sources.filter((s) => s.category !== "binary")
  if (candidates.length === 0) {
    await patchWorkflow(libId, { busy: undefined })
    throw new Error("没有可用于构建��来源，请先扫描目录或添加网址")
  }

  const out = await geminiJson<{
    intro: string
    questions: Array<{ question: string; options: string[]; multiSelect: boolean }>
  }>(
    `你是知识库构建助手。用户目标：「${prompt || "通用知识整理"}」。\n` +
      `下面是初筛后的候选资料（含类型、相关性、说明）：\n\n${listCandidates(candidates)}\n\n` +
      `请基于这些资料，向用户提出 3-5 道**选择题**来澄清构建偏好，` +
      `例如：聚焦哪些主题/子系统、是否纳入低相关资料、知识库用途（速查/学习/问答）、` +
      `详略程度、是否需要联网补充背景等。每题给出 2-5 个可选项，合适的设为多选。` +
      `intro 用一句话概述初筛发现（共多少份、主要类型、初步判断）。用中文。`,
    QUESTIONS_SCHEMA,
    { thinking: "adaptive" },
  )

  const questions: KbQuestion[] = out.questions.map((q, i) => ({
    id: `r1-q${i}`,
    question: q.question,
    options: q.options,
    multiSelect: !!q.multiSelect,
  }))

  await patchWorkflow(libId, {
    stage: "scanned",
    userPrompt: prompt,
    rounds: [{ round: 1, intro: out.intro, questions }],
    reports: [],
    categories: [],
    busy: undefined,
  })
  return getKbState(libId)
}

type AnswerInput = { id: string; answer: string[]; freeText?: string }

function applyAnswers(
  questions: KbQuestion[],
  answers: AnswerInput[],
): KbQuestion[] {
  const byId = new Map(answers.map((a) => [a.id, a]))
  return questions.map((q) => {
    const a = byId.get(q.id)
    return a ? { ...q, answer: a.answer, freeText: a.freeText } : q
  })
}

function answersDigest(questions: KbQuestion[]): string {
  return questions
    .map((q) => {
      const ans = [
        (q.answer ?? []).join("、"),
        q.freeText ? `补充：${q.freeText}` : "",
      ]
        .filter(Boolean)
        .join("；")
      return `· ${q.question}\n  答：${ans || "（未答）"}`
    })
    .join("\n")
}

// 阶段二：提交第一批答案 → 二筛 + 建目录 + 精细化构建 + 报告1 + 第二批问题
export async function submitRound1(libId: string, answers: AnswerInput[]) {
  const wf = await readWorkflow(libId)
  const round1 = wf.rounds.find((r) => r.round === 1)
  if (!round1) throw new Error("流程状态异常：缺少第一轮问题")

  const answered = applyAnswers(round1.questions, answers)
  const digest = answersDigest(answered)
  await patchWorkflow(libId, {
    rounds: wf.rounds.map((r) =>
      r.round === 1 ? { ...r, questions: answered, answeredAt: Date.now() } : r,
    ),
    busy: "二筛与目录规划中",
  })

  const index = await readIndex(libId)
  const candidates = index.sources.filter((s) => s.category !== "binary")

  const decision = await geminiJson<{
    categories: Array<{ name: string; description: string; indexes: number[] }>
    excluded: number[]
  }>(
    `用户目标：「${wf.userPrompt || "通用知识整理"}」。\n` +
      `用户对第一批问题的回答：\n${digest}\n\n` +
      `候选资料（编号从0开始）：\n${listCandidates(candidates)}\n\n` +
      `请据此做二次筛选并规划知识库目录：\n` +
      `1) categories：3-8 个主题分类，每个含 name、description，` +
      `indexes 为归入该类的资料编号；\n` +
      `2) excluded：与目标无关、应排除的资料编号数组。\n` +
      `每份纳入资料应归入恰好一个分类。用中文命名分类。`,
    {
      type: "OBJECT",
      properties: {
        categories: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING" },
              description: { type: "STRING" },
              indexes: { type: "ARRAY", items: { type: "INTEGER" } },
            },
            required: ["name", "description", "indexes"],
          },
        },
        excluded: { type: "ARRAY", items: { type: "INTEGER" } },
      },
      required: ["categories", "excluded"],
    },
    { thinking: "adaptive" },
  )

  const categories: KbCategory[] = decision.categories.map((c, i) => ({
    id: `cat-${i}`,
    name: c.name,
    description: c.description,
    sourceIds: c.indexes.map((n) => candidates[n]?.id).filter(Boolean) as string[],
  }))
  const excludedIds = new Set(
    decision.excluded.map((n) => candidates[n]?.id).filter(Boolean) as string[],
  )

  for (const id of excludedIds) {
    await updateSource(libId, id, { status: "skipped", note: "二筛排除：与目标关联较弱" })
  }
  await patchWorkflow(libId, { categories, busy: "精细化解析与入库中" })

  const includeIds = categories.flatMap((c) => c.sourceIds)
  const buildResult = await buildKb(libId, { includeIds })

  const built = (await readIndex(libId)).sources.filter((s) => s.status === "embedded")
  const builtSummary = built
    .map((s) => `- ${s.name}（${s.chunkCount ?? 0} 块）`)
    .join("\n")
  const catSummary = categories
    .map((c) => `### ${c.name}\n${c.description}\n含 ${c.sourceIds.length} 份资料`)
    .join("\n\n")

  const out = await geminiJson<{
    report: string
    intro: string
    questions: Array<{ question: string; options: string[]; multiSelect: boolean }>
  }>(
    `用户目标：「${wf.userPrompt}」。已完成知识库首次构建。\n` +
      `分类目录：\n${catSummary}\n\n已入库资料：\n${builtSummary}\n\n` +
      `处理统计：成功 ${buildResult.processed} 份，失败 ${buildResult.failed} 份。\n\n` +
      `请输出：\n` +
      `1) report：一份结构化的 Markdown「第一次构建报告」，包含知识库概览、目录结构、` +
      `覆盖与亮点、发现的缺口/低质量内容、改进建议；\n` +
      `2) intro：一句话引出第二批问题；\n` +
      `3) questions：2-4 道选择题，用于进一步优化（如是否补充缺口、是否调整分类粒度、` +
      `是否需要联网补全背景、重点深化哪个主题）。用中文。`,
    {
      type: "OBJECT",
      properties: {
        report: { type: "STRING" },
        intro: { type: "STRING" },
        questions: QUESTIONS_SCHEMA.properties.questions,
      },
      required: ["report", "intro", "questions"],
    },
    { thinking: "adaptive" },
  )

  const round2Questions: KbQuestion[] = out.questions.map((q, i) => ({
    id: `r2-q${i}`,
    question: q.question,
    options: q.options,
    multiSelect: !!q.multiSelect,
  }))

  const wf2 = await readWorkflow(libId)
  await patchWorkflow(libId, {
    stage: "built",
    reports: [...wf2.reports, { round: 1, markdown: out.report, createdAt: Date.now() }],
    rounds: [
      ...wf2.rounds,
      { round: 2, intro: out.intro, questions: round2Questions },
    ],
    busy: undefined,
  })
  return getKbState(libId)
}

// 阶段三：提交第二批答案 → 生成第二次（验收）报告
export async function submitRound2(libId: string, answers: AnswerInput[]) {
  const wf = await readWorkflow(libId)
  const round2 = wf.rounds.find((r) => r.round === 2)
  if (!round2) throw new Error("流程状态异常：缺少第二轮问题")

  const answered = applyAnswers(round2.questions, answers)
  const digest = answersDigest(answered)
  await patchWorkflow(libId, {
    rounds: wf.rounds.map((r) =>
      r.round === 2 ? { ...r, questions: answered, answeredAt: Date.now() } : r,
    ),
    busy: "生成验收报告中",
  })

  const index = await readIndex(libId)
  const built = index.sources.filter((s) => s.status === "embedded")
  const catSummary = wf.categories
    .map((c) => `### ${c.name}\n${c.description}\n含 ${c.sourceIds.length} 份资料`)
    .join("\n\n")

  const report2 = await geminiContents(
    [
      {
        role: "user",
        parts: [
          {
            text:
              `用户目标：「${wf.userPrompt}」。\n` +
              `知识库目录：\n${catSummary}\n\n` +
              `已入库资料 ${built.length} 份，共 ${index.chunks.length} 个知识块。\n` +
              `用户对第二批优化问题的回答：\n${digest}\n\n` +
              `请输出一份最终的 Markdown「验收报告」：总结知识库最终形态、目录与覆盖范围、` +
              `已根据用户反馈做出的优化、当前可支持的问答类型、使用建议与已知局限。` +
              `语气专业、面向交付验收。用中文。`,
          },
        ],
      },
    ],
    { thinking: "adaptive" },
  )

  const wf2 = await readWorkflow(libId)
  await patchWorkflow(libId, {
    stage: "reviewing",
    reports: [...wf2.reports, { round: 2, markdown: report2, createdAt: Date.now() }],
    busy: undefined,
  })
  return getKbState(libId)
}

// 阶段四：验收通过 → 进入对话提升模式
export async function acceptBuild(libId: string) {
  await patchWorkflow(libId, { stage: "ready", busy: undefined })
  return getKbState(libId)
}

// 退回上一阶段 / 重做（不清空已入库数据，仅回退工作流）
export async function restartWorkflow(libId: string) {
  await patchWorkflow(libId, {
    stage: "idle",
    rounds: [],
    reports: [],
    categories: [],
    busy: undefined,
  })
  return getKbState(libId)
}

// ===================================================================
// 站点智能抓取编排（运行时由 Gemini 分诊，绝不按 URL 写死）
// ===================================================================

export async function getCrawlState(libId: string, crawlId: string) {
  return readCrawl(libId, crawlId)
}

// 步骤一：仅分诊（快速返回）。
export async function classifyOnly(libId: string, rootUrl: string) {
  const url = (rootUrl || "").trim()
  if (!/^https?:\/\//i.test(url)) throw new Error("请输入有效的 http(s) 网址")
  const site = await classifySite(url)
  await upsertCrawl(libId, site)
  return site
}

// 步骤二：枚举 + 按目标选取（较慢，单独触发）。
export async function enumerateAndSelect(
  libId: string,
  crawlId: string,
  userPrompt: string,
  opts?: { maxLinks?: number; maxPick?: number },
) {
  const site = await readCrawl(libId, crawlId)
  if (!site) throw new Error("抓取会话不存在")

  await patchCrawl(libId, site.id, { busy: "遍历站点中" })
  const enumerated = await enumerateSite(site, {
    maxLinks: opts?.maxLinks ?? 2000,
    maxDepth: site.siteKind === "wiki" ? 0 : 2,
  })

  await patchCrawl(libId, site.id, { busy: "AI 按目标筛选链接中" })
  const picked = await selectLinks(site, enumerated, userPrompt, opts?.maxPick ?? 60)
  const links = picked.map((l) => ({
    ...l,
    picked:
      l.action === "fetch" ||
      l.action === "server_download" ||
      l.action === "manual_download",
  }))

  const updated = await patchCrawl(libId, site.id, { links, busy: undefined })
  return updated
}

// 一键抓取（兼容旧调用）：分诊 → 枚举 → 选取。
export async function crawlSite(
  libId: string,
  rootUrl: string,
  userPrompt: string,
  opts?: { maxLinks?: number; maxPick?: number },
) {
  const site = await classifyOnly(libId, rootUrl)
  return enumerateAndSelect(libId, site.id, userPrompt, opts)
}

// 把勾选的可在线识别链接（action=fetch）抓取并入库为知识库来源。
export async function ingestFetchable(libId: string, crawlId: string) {
  const site = await readCrawl(libId, crawlId)
  if (!site) throw new Error("抓取会话不存在")
  const targets = site.links.filter(
    (l) => l.picked && l.action === "fetch" && !l.ingested,
  )
  if (targets.length === 0) return { ingested: 0, failed: 0, site }

  let ingested = 0
  let failed = 0
  const concurrency = Number(process.env.KB_BUILD_CONCURRENCY ?? 4) || 4
  await mapLimit(targets, concurrency, async (link) => {
    try {
      const md = await fetchLinkContent(link.url)
      if (!md) throw new Error("正文为空")
      const source: KbSource = {
        id: `web-${link.id}`,
        kind: "web",
        location: link.url,
        name: link.title || link.url,
        category: "webpage",
        ext: "",
        sizeBytes: md.length,
        status: "parsing",
        updatedAt: Date.now(),
      }
      await upsertSources(libId, [source])
      const chunks = chunkSegments([{ text: md, loc: link.url }])
      const embedded = await embedSegments(source.id, chunks)
      await replaceChunks(libId, source.id, embedded)
      await updateSource(libId, source.id, {
        status: "embedded",
        charCount: md.length,
        chunkCount: embedded.length,
      })
      await patchCrawlLinks(libId, crawlId, [{ id: link.id, ingested: true }])
      ingested++
    } catch (err) {
      await patchCrawlLinks(libId, crawlId, [
        { id: link.id, note: `抓取失败：${err instanceof Error ? err.message : String(err)}` },
      ])
      failed++
    }
  })

  const updatedSite = await readCrawl(libId, crawlId)
  return { ingested, failed, site: updatedSite }
}

// 把勾选的开放可下载文件（action=server_download）下载到项目 downloads/，并尝试解析入库。
export async function serverDownload(libId: string, crawlId: string) {
  const site = await readCrawl(libId, crawlId)
  if (!site) throw new Error("抓取会话不存在")
  const targets = site.links.filter(
    (l) => l.picked && l.action === "server_download" && !l.downloaded,
  )
  if (targets.length === 0) return { downloaded: 0, failed: 0, site }

  let downloaded = 0
  let failed = 0
  const host = (() => {
    try {
      return new URL(site.rootUrl).hostname
    } catch {
      return "site"
    }
  })()

  await mapLimit(targets, 3, async (link) => {
    try {
      await downloadToProject(link.url, host)
      await patchCrawlLinks(libId, crawlId, [{ id: link.id, downloaded: true }])
      downloaded++
    } catch (err) {
      await patchCrawlLinks(libId, crawlId, [
        { id: link.id, note: `下载失败：${err instanceof Error ? err.message : String(err)}` },
      ])
      failed++
    }
  })

  const updatedSite = await readCrawl(libId, crawlId)
  return { downloaded, failed, site: updatedSite }
}

// 导出"需用户在浏览器端下载"的链接清单（action=manual_download 且已勾选）。
export async function getDownloadManifest(libId: string, crawlId: string) {
  const site = await readCrawl(libId, crawlId)
  if (!site) return { rootUrl: "", host: "", items: [] as Array<{ url: string; name: string; note?: string }> }
  const host = (() => {
    try {
      return new URL(site.rootUrl).hostname
    } catch {
      return "site"
    }
  })()
  const items = site.links
    .filter((l) => l.picked && l.action === "manual_download")
    .map((l) => ({
      url: l.url,
      name: (decodeURIComponent(l.url.split("?")[0].split("/").pop() || "") || l.title || "file").replace(
        /[^\w.\-]+/g,
        "_",
      ),
      note: l.note,
    }))
  return { rootUrl: site.rootUrl, host, items }
}

// 更新链接勾选状态（前端勾选/取消）
export async function setCrawlLinkPicked(
  libId: string,
  crawlId: string,
  linkId: string,
  picked: boolean,
) {
  return patchCrawlLinks(libId, crawlId, [{ id: linkId, picked }])
}

// 触发一次目录重扫（用户把手动下载的文件放进 downloads/ 后调用）
export async function rescanDownloads(libId: string) {
  const { DOWNLOADS_DIR } = await import("@/lib/kb/crawl")
  const fs = await import("node:fs/promises")
  try {
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true })
  } catch {
    // 忽略
  }
  const result = await scanDirectory(DOWNLOADS_DIR)
  await upsertSources(libId, result.sources)
  return getKbState(libId)
}
