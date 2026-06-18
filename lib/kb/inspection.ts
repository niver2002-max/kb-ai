// 高级模型巡检引擎（goal 驱动的自迭代）
//
// 设计要点：
//   · 模型分工：活动对话固定用 gemini-3.5-flash（设置里的 model）；巡检用高级模型
//     gemini-3.1-pro（设置里的 inspectModel），均用自适应思考、最低温度（温度由全局设置控制）。
//   · 服务端常驻：巡检循环跑在 Node 进程内的模块级单例里，不依赖前台窗口。
//     关闭前台、切换知识库都不会停；服务器重启后，首次调用任一巡检 action 会自动续跑
//     磁盘上仍处于 active 的库。
//   · goal 循环：每一轮先由 pro 读取知识库最新全貌做决策（完整度评分 + 是否 done + 下一步动作），
//     再执行该动作（笔记补全 / 缺口联网 / 抓取网页 / 重建索引）。直到 pro 判定 done
//     或用户手动结束，或达到硬性轮次上限兜底。
import { promises as fs } from "node:fs"
import path from "node:path"
import type { InspectionState, InspectionRound, InspectionAction, KbLibrary } from "./types"
import { getLibrary, patchLibrary, listLibraries } from "./library"
import { readIndex, writeIndex, updateSource } from "./store"
import { geminiJson, geminiText, geminiSearch, geminiUrlContext, geminiEmbedBatch } from "./gemini"
import { getSettings } from "./settings"

// 硬性轮次上限（兜底，防极端死循环；正常由 pro 判定 done 停止）
const MAX_ROUNDS = 50
// 两轮之间的间隔（给停止信号留出观察窗口，也避免过密请求）
const ROUND_GAP_MS = 1500
// history 保留条数
const HISTORY_KEEP = 30

export function defaultInspection(): InspectionState {
  return {
    active: false,
    round: 0,
    completeness: 0,
    currentAction: "",
    lastReport: "",
    history: [],
    done: false,
    stopRequested: false,
    running: false,
  }
}

export async function getInspection(libId: string): Promise<InspectionState> {
  const lib = await getLibrary(libId)
  return lib?.inspection ?? defaultInspection()
}

// 巡检模型
function inspectModel(): string {
  return getSettings().inspectModel
}

// ===== 持久化 helper =====

async function patchInspection(
  libId: string,
  patch: Partial<InspectionState>,
): Promise<InspectionState> {
  const lib = await getLibrary(libId)
  const cur = lib?.inspection ?? defaultInspection()
  const next: InspectionState = { ...cur, ...patch }
  await patchLibrary(libId, { inspection: next })
  return next
}

async function writeNote(lib: KbLibrary, name: string, body: string): Promise<string> {
  const dir = path.join(lib.rootDir, "notes")
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.writeFile(file, body, "utf8")
  return file
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

function safeName(s: string): string {
  return s.replace(/[^\w\u4e00-\u9fa5.-]+/g, "_").slice(0, 40)
}

// ===== 知识库快照（供 pro 决策）=====

async function buildSnapshot(lib: KbLibrary): Promise<string> {
  const index = await readIndex(lib.id)
  const sources = index.sources
  const embedded = sources.filter((s) => s.status === "embedded")
  const withNote = embedded.filter((s) => s.note).length
  const cats = index.workflow.categories.map((c) => c.name).join("、") || "（未分类）"
  const missingEmbed = index.chunks.filter((c) => !c.embedding || c.embedding.length === 0).length

  // 已有笔记文件（含已填补的缺口）
  let notesList: string[] = []
  try {
    notesList = (await fs.readdir(path.join(lib.rootDir, "notes"))).filter((f) => f.endsWith(".md"))
  } catch {
    notesList = []
  }

  const inv = sources
    .slice(0, 200)
    .map((s) => `- ${s.name}（${s.category}/${s.status}${s.note ? "/有摘要" : "/无摘要"}）`)
    .join("\n")

  const insp = lib.inspection ?? defaultInspection()
  const recent = insp.history
    .slice(-5)
    .map((h) => `· 第${h.round}轮 [${h.action}] 完整度${h.completeness} — ${h.result}`)
    .join("\n")

  return [
    `知识库标题：${lib.title}`,
    `面向/用途：${lib.audience || "（未填写）"}`,
    `来源总数：${sources.length}，已入库：${embedded.length}，有摘要：${withNote}`,
    `片段总数：${index.chunks.length}，缺向量片段：${missingEmbed}`,
    `分类：${cats}`,
    `已有笔记文件（${notesList.length}）：${notesList.slice(0, 60).join("、") || "（无）"}`,
    `资料清单：\n${inv || "（暂无来源）"}`,
    recent ? `最近巡检动作：\n${recent}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

// ===== pro 决策 =====

interface Decision {
  completeness: number
  done: boolean
  action: InspectionAction
  target?: string
  reason: string
}

const DECISION_SCHEMA = {
  type: "OBJECT",
  properties: {
    completeness: { type: "INTEGER", description: "知识库完整度评分 0-100" },
    done: { type: "BOOLEAN", description: "是否已无明显可迭代之处" },
    action: {
      type: "STRING",
      enum: ["notes", "gaps", "crawl", "reindex", "none"],
      description: "本轮应执行的动作",
    },
    target: { type: "STRING", description: "动作目标：缺口主题词或要抓取的网址（可空）" },
    reason: { type: "STRING", description: "决策理由（简述）" },
  },
  required: ["completeness", "done", "action", "reason"],
}

async function decide(lib: KbLibrary): Promise<Decision> {
  const snapshot = await buildSnapshot(lib)
  const prompt =
    `你是知识库的高级巡检官（goal：把这个知识库迭代到尽可能完整、准确、结构清晰，直到没有明显可改进之处）。\n` +
    `请基于下面的知识库现状，结合你对该主题领域应有内容的判断，评估其完整度并决定下一步：\n\n` +
    `${snapshot}\n\n` +
    `可选动作：\n` +
    `- notes：为缺少摘要的来源生成/补全笔记（先把已有资料吃透）\n` +
    `- gaps：找出知识缺口并联网检索补充（target 填最该补的主题词）\n` +
    `- crawl：抓取某个具体网页/在线资料入库（target 填网址或精确资料主题）\n` +
    `- reindex：重建索引/去重/补嵌入（资料动过后整理）\n` +
    `- none：本轮无需动作（通常 done=true 时）\n\n` +
    `判断原则：优先把已有资料的摘要补全，再补缺口，再抓取外部资料，最后整理索引。\n` +
    `当知识库对其目标用途已足够完整、再迭代收益很低时，done=true。`
  return geminiJson<Decision>(prompt, DECISION_SCHEMA, {
    model: inspectModel(),
    thinking: "adaptive",
  })
}

// ===== 动作执行（均走巡检模型）=====

async function execNotes(lib: KbLibrary): Promise<string> {
  const index = await readIndex(lib.id)
  const targets = index.sources.filter((s) => s.status === "embedded" && !s.note)
  if (targets.length === 0) return "所有来源均已有摘要，无需补全"
  let done = 0
  for (const src of targets) {
    const chunks = index.chunks
      .filter((c) => c.sourceId === src.id)
      .map((c) => c.text)
      .join("\n\n")
    if (!chunks.trim()) continue
    const summary = await geminiText(
      `你在维护一个知识库（面向：${lib.audience || "通用"}）。请为以下资料生成一份详尽的中文笔记，` +
        `包含：一句话概述、核心要点（尽量完整）、关键术语解释、与其它主题的关联线索、可延伸阅读方向。` +
        `资料名：${src.name}\n\n内容：\n"""${chunks}"""`,
      { model: inspectModel(), thinking: "adaptive" },
    )
    await writeNote(
      lib,
      `summary-${safeName(src.name)}.md`,
      `# ${src.name} · 摘要笔记\n\n> 巡检自动生成于 ${new Date().toLocaleString()}\n\n${summary}\n`,
    )
    const firstLine = summary.split("\n").find((l) => l.trim())?.slice(0, 200) ?? ""
    await updateSource(lib.id, src.id, { note: firstLine })
    done++
  }
  return `为 ${done} 个来源生成摘要笔记`
}

async function execGaps(lib: KbLibrary, target?: string): Promise<string> {
  const topic = target?.trim()
  let gaps: string[]
  if (topic) {
    gaps = [topic]
  } else {
    const index = await readIndex(lib.id)
    const inventory = index.sources.map((s) => `- ${s.name}`).join("\n")
    const raw = await geminiText(
      `知识库（面向：${lib.audience || "通用"}）现有资料：\n${inventory}\n\n` +
        `请指出最重要的 3-5 个知识缺口，每行一个主题词（不超过 30 字），不要编号与解释。`,
      { model: inspectModel(), thinking: "adaptive" },
    )
    gaps = raw
      .split("\n")
      .map((l) => l.replace(/^[-*\d.、)\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 5)
  }
  if (gaps.length === 0) return "未识别到明显缺口"
  let filled = 0
  for (const gap of gaps) {
    const supplement = await geminiSearch(
      `围绕「${gap}」，面向「${lib.audience || "通用"}」整理一份准确、可引用的中文资料综述，` +
        `包含关键概念、要点、常见误区与权威来源链接。`,
      { model: inspectModel(), thinking: "adaptive" },
    )
    await writeNote(
      lib,
      `gap-${nowStamp()}-${safeName(gap)}.md`,
      `# 知识缺口补充：${gap}\n\n> 巡检联网补充于 ${new Date().toLocaleString()}\n\n${supplement}\n`,
    )
    filled++
  }
  return `识别并联网补充 ${filled} 个缺口（${gaps.join("、")}）`
}

async function execCrawl(lib: KbLibrary, target?: string): Promise<string> {
  const t = target?.trim()
  if (!t) return "未指定抓取目标，跳过"
  const isUrl = /^https?:\/\//i.test(t)
  let content: string
  if (isUrl) {
    content = await geminiUrlContext(
      t,
      `请抓取该网页正文，面向「${lib.audience || "通用"}」整理为准确的中文资料，剔除导航与广告。`,
      { model: inspectModel(), thinking: "adaptive" },
    )
  } else {
    content = await geminiSearch(
      `检索并抓取关于「${t}」的权威在线资料，面向「${lib.audience || "通用"}」整理为准确、可引用的中文综述，` +
        `附上来源链接。`,
      { model: inspectModel(), thinking: "adaptive" },
    )
  }
  await writeNote(
    lib,
    `crawl-${nowStamp()}-${safeName(t)}.md`,
    `# 抓取资料：${t}\n\n> 巡检抓取于 ${new Date().toLocaleString()}\n\n${content}\n`,
  )
  return `抓取并入库：${t}`
}

async function execReindex(lib: KbLibrary): Promise<string> {
  const index = await readIndex(lib.id)
  const missing = index.chunks.filter((c) => !c.embedding || c.embedding.length === 0)
  let embedded = 0
  if (missing.length > 0) {
    const vectors = await geminiEmbedBatch(missing.map((c) => c.text))
    for (let i = 0; i < missing.length; i++) {
      if (vectors[i]?.length) {
        missing[i].embedding = vectors[i]
        embedded++
      }
    }
  }
  const seen = new Set<string>()
  const before = index.chunks.length
  index.chunks = index.chunks.filter((c) => {
    const key = `${c.sourceId}::${c.text.trim()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const removed = before - index.chunks.length
  if (embedded > 0 || removed > 0) await writeIndex(lib.id, index)
  return `补嵌入 ${embedded} 片段，去重 ${removed} 片段`
}

async function execAction(lib: KbLibrary, action: InspectionAction, target?: string): Promise<string> {
  switch (action) {
    case "notes":
      return execNotes(lib)
    case "gaps":
      return execGaps(lib, target)
    case "crawl":
      return execCrawl(lib, target)
    case "reindex":
      return execReindex(lib)
    default:
      return "本轮无动作"
  }
}

// ===== 引擎循环（服务端常驻）=====

const runningLoops = new Set<string>()

function actionLabel(a: InspectionAction): string {
  return (
    { notes: "补全摘要笔记", gaps: "查找并补充知识缺口", crawl: "抓取在线资料", reindex: "重建索引", none: "评估中" }[
      a
    ] ?? "巡检中"
  )
}

async function runLoop(libId: string): Promise<void> {
  while (true) {
    const lib = await getLibrary(libId)
    const insp = lib?.inspection
    if (!lib || !insp || !insp.active) return

    // 终止条件
    if (insp.stopRequested) {
      await patchInspection(libId, {
        active: false,
        running: false,
        currentAction: "已手动结束",
        finishedAt: Date.now(),
      })
      return
    }
    if (insp.done) {
      await patchInspection(libId, { active: false, running: false, finishedAt: Date.now() })
      return
    }
    if (insp.round >= MAX_ROUNDS) {
      await patchInspection(libId, {
        active: false,
        running: false,
        currentAction: `已达轮次上限（${MAX_ROUNDS}）`,
        finishedAt: Date.now(),
      })
      return
    }

    // 跑一轮
    await patchInspection(libId, { running: true, currentAction: "高级模型决策中…", error: undefined })
    const roundNo = insp.round + 1
    try {
      const decision = await decide(lib)

      if (decision.done) {
        const log: InspectionRound = {
          round: roundNo,
          completeness: decision.completeness,
          action: "none",
          reason: decision.reason,
          result: "判定已无明显可迭代之处",
          at: Date.now(),
        }
        await patchInspection(libId, {
          running: false,
          done: true,
          round: roundNo,
          completeness: decision.completeness,
          currentAction: "巡检完成",
          lastReport: decision.reason,
          history: [...insp.history, log].slice(-HISTORY_KEEP),
        })
        continue // 下一圈会走 done 分支收尾
      }

      // 执行动作
      await patchInspection(libId, { currentAction: actionLabel(decision.action) })
      const result = await execAction(lib, decision.action, decision.target)

      const log: InspectionRound = {
        round: roundNo,
        completeness: decision.completeness,
        action: decision.action,
        reason: decision.reason,
        result,
        at: Date.now(),
      }
      const fresh = await getLibrary(libId)
      const freshInsp = fresh?.inspection ?? insp
      await patchInspection(libId, {
        running: false,
        round: roundNo,
        completeness: decision.completeness,
        currentAction: `第 ${roundNo} 轮完成：${result}`,
        lastReport: `【第 ${roundNo} 轮 · 完整度 ${decision.completeness}】${decision.reason}\n\n→ ${actionLabel(
          decision.action,
        )}：${result}`,
        history: [...freshInsp.history, log].slice(-HISTORY_KEEP),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知错误"
      // 出错不立即终止：记录错误并重试下一轮（除非用户停止）
      await patchInspection(libId, {
        running: false,
        round: roundNo,
        currentAction: `第 ${roundNo} 轮出错，将重试`,
        error: msg,
      })
    }

    await new Promise((r) => setTimeout(r, ROUND_GAP_MS))
  }
}

function ensureLoop(libId: string): void {
  if (runningLoops.has(libId)) return
  runningLoops.add(libId)
  void runLoop(libId).finally(() => runningLoops.delete(libId))
}

// 服务器重启后续跑：首次调用时扫描所有库，对仍 active 的自动恢复循环。
let resumed = false
async function ensureResume(): Promise<void> {
  if (resumed) return
  resumed = true
  try {
    const libs = await listLibraries()
    for (const lib of libs) {
      const insp = lib.inspection
      if (insp?.active && !insp.done && !insp.stopRequested) {
        // 清掉可能残留的 running 标记
        await patchInspection(lib.id, { running: false })
        ensureLoop(lib.id)
      }
    }
  } catch {
    // 忽略：续跑失败不致命
  }
}

// ===== 对外 API（供 server actions 调用）=====

export async function startInspection(libId: string): Promise<InspectionState> {
  await ensureResume()
  const lib = await getLibrary(libId)
  if (!lib) throw new Error("知识库不存在")
  const cur = lib.inspection ?? defaultInspection()
  if (cur.active) return cur // 已在巡检
  const next: InspectionState = {
    ...defaultInspection(),
    active: true,
    startedAt: Date.now(),
    currentAction: "正在启动巡检…",
    // 保留历史，便于多次巡检对比
    history: cur.history ?? [],
  }
  await patchLibrary(libId, { inspection: next })
  ensureLoop(libId)
  return next
}

export async function stopInspection(libId: string): Promise<InspectionState> {
  return patchInspection(libId, { stopRequested: true, currentAction: "正在结束巡检…" })
}

export async function readInspection(libId: string): Promise<InspectionState> {
  await ensureResume()
  return getInspection(libId)
}
