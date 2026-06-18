import { promises as fs } from "node:fs"
import path from "node:path"
import type { KbSession, KbMessage, KbChunk, KbSource } from "./types"
import { DATA_DIR, readIndex } from "./store"
import { hybridSearch } from "./search"
import { geminiText } from "./gemini"

// 每库一个会话文件：.kb-data/<libId>/session.json
function sessionFile(libId: string): string {
  return path.join(DATA_DIR, libId, "session.json")
}

// 滚动摘要触发阈值：保留最近 RECENT_KEEP 轮原文，更早的压缩进 summary
const RECENT_KEEP = 12 // 最近保留的消息条数（约 6 轮问答）
const SUMMARY_TRIGGER = 20 // 超过这么多条未摘要消息时触发一次压缩

function rid(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function emptySession(libId: string): KbSession {
  return {
    libraryId: libId,
    messages: [],
    rollingSummary: "",
    summarizedCount: 0,
    updatedAt: Date.now(),
  }
}

let writeChain: Promise<unknown> = Promise.resolve()

// 读取会话（重启后自动 resume 即来自此处）
export async function readSession(libId: string): Promise<KbSession> {
  try {
    const raw = await fs.readFile(sessionFile(libId), "utf8")
    const parsed = JSON.parse(raw) as KbSession
    if (!parsed.messages) parsed.messages = []
    if (typeof parsed.rollingSummary !== "string") parsed.rollingSummary = ""
    if (typeof parsed.summarizedCount !== "number") parsed.summarizedCount = 0
    return parsed
  } catch {
    return emptySession(libId)
  }
}

async function writeSession(session: KbSession): Promise<void> {
  session.updatedAt = Date.now()
  writeChain = writeChain.then(async () => {
    await fs.mkdir(path.join(DATA_DIR, session.libraryId), { recursive: true })
    const tmp = sessionFile(session.libraryId) + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(session), "utf8")
    await fs.rename(tmp, sessionFile(session.libraryId))
  })
  await writeChain
}

// 追加一条消息并持久化
export async function appendMessage(
  libId: string,
  msg: Omit<KbMessage, "id" | "createdAt"> & { id?: string },
): Promise<KbMessage> {
  const session = await readSession(libId)
  const full: KbMessage = {
    id: msg.id ?? rid(),
    role: msg.role,
    content: msg.content,
    citations: msg.citations,
    scope: msg.scope ?? null,
    createdAt: Date.now(),
  }
  session.messages.push(full)
  await writeSession(session)
  return full
}

export async function clearSession(libId: string): Promise<void> {
  await writeSession(emptySession(libId))
}

// ===== 滚动摘要压缩（Gemini 无状态，由我们维护历史与压缩）=====
// 当未摘要消息过多时，把较早的一段对话用 Gemini 压成一段累积摘要，
// 之后只发送 [摘要 + 最近若干轮原文] 给模型，token 可控且能长期持续。
export async function compressIfNeeded(libId: string): Promise<KbSession> {
  const session = await readSession(libId)
  const unsummarized = session.messages.length - session.summarizedCount
  if (unsummarized <= SUMMARY_TRIGGER) return session

  // 需要压缩的范围：从 summarizedCount 起，到“保留最近 RECENT_KEEP 条之前”为止
  const compressEnd = session.messages.length - RECENT_KEEP
  if (compressEnd <= session.summarizedCount) return session

  const toCompress = session.messages.slice(session.summarizedCount, compressEnd)
  const transcript = toCompress
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
    .join("\n")

  const prompt =
    "下面是一段知识库问答的历史记录，以及此前已有的摘要。请把它们合并、提炼成一段简洁但信息完整的累积摘要，" +
    "保留关键事实、用户目标、已确认的结论与待办，去除寒暄与冗余。用中文，控制在 400 字以内。\n\n" +
    (session.rollingSummary ? `【已有摘要】\n${session.rollingSummary}\n\n` : "") +
    `【新增对话】\n${transcript}`

  try {
    const summary = await geminiText(prompt, { thinking: "adaptive" })
    session.rollingSummary = summary.trim()
    session.summarizedCount = compressEnd
    await writeSession(session)
  } catch {
    // 压缩失败不阻塞主流程，下次再试
  }
  return session
}

// 组装发送给模型的对话上下文：[摘要(若有)] + 最近若干轮原文
export function buildContextMessages(
  session: KbSession,
): Array<{ role: string; content: string }> {
  const recent = session.messages.slice(session.summarizedCount)
  const out: Array<{ role: string; content: string }> = []
  if (session.rollingSummary) {
    out.push({
      role: "user",
      content: `【对话历史摘要（供你参考，不必复述）】\n${session.rollingSummary}`,
    })
    out.push({ role: "assistant", content: "明白，我已了解此前的对话背景。" })
  }
  for (const m of recent) {
    if (m.role === "system") continue
    out.push({ role: m.role, content: m.content })
  }
  return out
}

// ===== RAG 检索（scope-aware：@某层级时把范围限定到该分类/来源）=====
export interface RetrievedContext {
  context: string
  citations: Array<{ sourceId: string; name: string; loc?: string }>
}

export async function retrieveContext(
  libId: string,
  query: string,
  scope?: { type: "category" | "source"; id: string } | null,
  topK = 8,
  opts: { history?: string; expand?: boolean; useRerank?: boolean } = {},
): Promise<RetrievedContext> {
  if (!query) return { context: "", citations: [] }
  const index = await readIndex(libId)

  // 按 scope 缩小候选 chunk 范围
  let chunks: KbChunk[] = index.chunks
  let sources: KbSource[] = index.sources
  if (scope) {
    if (scope.type === "source") {
      chunks = chunks.filter((c) => c.sourceId === scope.id)
    } else if (scope.type === "category") {
      const cat = index.workflow.categories.find((c) => c.id === scope.id)
      const ids = new Set(cat?.sourceIds ?? [])
      chunks = chunks.filter((c) => ids.has(c.sourceId))
    }
  }

  // 完整混合检索流水线：多查询+HyDE → 向量&BM25 RRF 融合 → LLM 重排 → MMR 去冗
  const hits = await hybridSearch(query, chunks, {
    topK,
    history: opts.history,
    expand: opts.expand,
    useRerank: opts.useRerank,
  })
  const sourceById = new Map(sources.map((s) => [s.id, s]))
  const citations: RetrievedContext["citations"] = []
  const context = hits
    .map((h, i) => {
      const src = sourceById.get(h.chunk.sourceId)
      const label = src ? src.name : h.chunk.sourceId
      if (src) citations.push({ sourceId: src.id, name: src.name, loc: h.chunk.loc })
      const loc = h.chunk.loc ? `，${h.chunk.loc}` : ""
      return `【来源 ${i + 1}：${label}${loc}】\n${h.chunk.text}`
    })
    .join("\n\n---\n\n")

  return { context, citations }
}
