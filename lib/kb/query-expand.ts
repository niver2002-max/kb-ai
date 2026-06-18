// 查询理解：把用户原话改写为多个互补的检索 query，并生成一个 HyDE 假设答案。
// 动机：用户原话往往不是好的检索词（口语化、含指代、缺专有名词）。
// - 多查询：覆盖不同表述/同义词/拆解子问题，提升召回。
// - HyDE（Hypothetical Document Embeddings）：先让模型“假想一段理想答案”，
//   用它的向量去检索，能显著拉近与真实文档的语义距离。
// 用对话模型（flash）做，快且便宜；失败时回退为仅用原始查询，绝不阻断主流程。

import { geminiJson } from "./gemini"

export interface ExpandedQuery {
  // 用于检索的查询集合（始终包含原始 query 作为第一个）
  queries: string[]
  // HyDE 假设文档（可能为空）
  hyde: string
}

interface RawExpand {
  queries?: string[]
  hypothetical_answer?: string
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    queries: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "2-4 个用于向量/关键词检索的改写查询，覆盖同义表述与可拆解的子问题",
    },
    hypothetical_answer: {
      type: "STRING",
      description: "对该问题的一段简短假设性回答（2-4 句），用于 HyDE 检索",
    },
  },
  required: ["queries", "hypothetical_answer"],
}

export async function expandQuery(
  query: string,
  opts: { history?: string; maxQueries?: number } = {},
): Promise<ExpandedQuery> {
  const q = query.trim()
  if (!q) return { queries: [], hyde: "" }
  const maxQueries = opts.maxQueries ?? 4

  const prompt =
    "你是检索查询优化器。根据【用户问题】（必要时参考【对话上下文】解析指代），" +
    "产出用于知识库检索的改写查询，并写一段假设性回答。\n" +
    "要求：\n" +
    "1) queries：2-4 条，每条是独立、信息充分的检索查询；" +
    "把口语化表述规范化，补全省略的主语/专有名词/型号，必要时拆成子问题；不要互相重复。\n" +
    "2) hypothetical_answer：假装你已知道答案，写 2-4 句最可能的正确回答（用于 HyDE 向量检索），" +
    "宁可具体也不要空泛；不确定的细节可合理假设。\n" +
    "全部用与问题相同的语言。\n\n" +
    (opts.history ? `【对话上下文】\n${opts.history}\n\n` : "") +
    `【用户问题】\n${q}`

  try {
    const raw = await geminiJson<RawExpand>(prompt, SCHEMA, { thinking: "adaptive" })
    const extra = (raw.queries ?? [])
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0 && s.toLowerCase() !== q.toLowerCase())
    // 始终把原始查询放在首位，再补充改写查询（去重、限量）
    const seen = new Set<string>()
    const queries: string[] = []
    for (const s of [q, ...extra]) {
      const key = s.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      queries.push(s)
      if (queries.length >= maxQueries) break
    }
    return { queries, hyde: (raw.hypothetical_answer ?? "").trim() }
  } catch (e) {
    console.log(`[v0] 查询扩写失败，回退原始查询：${(e as Error).message}`)
    return { queries: [q], hyde: "" }
  }
}
