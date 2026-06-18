// LLM 重排序（cross-encoder 的轻量替代）：召回阶段为了高召回会取较多候选，
// 但它们与问题的真实相关性参差不齐。这里用对话模型(flash)对每个候选打分(0-10)，
// 一次调用批量评估，按分数重排后取最终 topN。这是 2026 年严肃 RAG 的标配环节，
// 对最终答案质量提升最直接。失败时回退为保持原有顺序，绝不阻断主流程。

import { geminiJson } from "./gemini"

export interface RerankItem {
  text: string
}

interface RawScore {
  scores?: Array<{ id: number; score: number }>
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    scores: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "INTEGER", description: "候选片段编号" },
          score: { type: "NUMBER", description: "与问题的相关性，0(无关)到10(高度相关)" },
        },
        required: ["id", "score"],
      },
    },
  },
  required: ["scores"],
}

// 返回重排后的下标顺序（相对传入 items 的下标），已截断到 topN。
export async function rerank(
  query: string,
  items: RerankItem[],
  topN: number,
): Promise<number[]> {
  const n = items.length
  if (n === 0) return []
  if (n <= 1) return items.map((_, i) => i)

  // 每个候选裁剪到合理长度，控制 token；编号从 0 开始
  const listing = items
    .map((it, i) => `[#${i}]\n${it.text.slice(0, 700)}`)
    .join("\n\n")

  const prompt =
    "你是检索重排器。给定【问题】和若干【候选片段】，" +
    "请逐个评估每个片段对回答该问题的相关性与信息价值，打 0-10 分：" +
    "10=直接回答问题的关键依据，5=部分相关/背景，0=完全无关。" +
    "只依据片段本身内容判断，不要臆测。必须为每个编号都给出分数。\n\n" +
    `【问题】\n${query}\n\n【候选片段】\n${listing}`

  try {
    const raw = await geminiJson<RawScore>(prompt, SCHEMA, { thinking: "adaptive" })
    const scoreById = new Map<number, number>()
    for (const s of raw.scores ?? []) {
      if (typeof s.id === "number" && typeof s.score === "number") {
        scoreById.set(s.id, s.score)
      }
    }
    if (scoreById.size === 0) throw new Error("重排未返回有效分数")

    // 按重排分数降序；未被打分的候选用 -1 兜底排在后面但保留
    const order = items
      .map((_, i) => i)
      .sort((a, b) => (scoreById.get(b) ?? -1) - (scoreById.get(a) ?? -1))
    return order.slice(0, topN)
  } catch (e) {
    console.log(`[v0] 重排失败，保持召回顺序：${(e as Error).message}`)
    return items.map((_, i) => i).slice(0, topN)
  }
}
