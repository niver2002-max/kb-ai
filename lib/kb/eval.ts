// 检索质量评估闭环（RAGAS 思路的本地实现）：
//   1) 由高级模型基于知识库实际内容生成一批“用户最可能问”的测试问题；
//   2) 用真实的混合检索流水线为每个问题召回上下文；
//   3) 裁判模型对每个问题评判两项客观指标：
//        · 检索相关性/覆盖（context relevance）：召回的上下文能否支撑回答；
//        · 答案忠实度（faithfulness）：仅依据该上下文作答时是否会产生幻觉/缺依据。
//   4) 聚合成 0-100 的客观分，并指出薄弱主题。
// 这把巡检的“完整度”从主观判断升级为可量化、可复现的客观指标，喂回 pro 决策。

import type { KbLibrary, EvalReport, EvalCase } from "./types"
import { readIndex } from "./store"
import { hybridSearch } from "./search"
import { geminiJson } from "./gemini"
import { getSettings } from "./settings"

function judgeModel(): string {
  return getSettings().inspectModel
}

const QUESTIONS_SCHEMA = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "测试问题，覆盖知识库不同主题、难度由浅入深",
    },
  },
  required: ["questions"],
}

const JUDGE_SCHEMA = {
  type: "OBJECT",
  properties: {
    retrieval_score: { type: "NUMBER", description: "0-10：召回上下文对回答该问题的支撑程度" },
    faithfulness_score: {
      type: "NUMBER",
      description: "0-10：仅凭该上下文作答的可忠实程度（10=完全有据，0=只能靠编造）",
    },
    missing: { type: "STRING", description: "指出缺失/薄弱之处，没有则留空" },
  },
  required: ["retrieval_score", "faithfulness_score", "missing"],
}

// 基于知识库内容生成测试问题集
async function genQuestions(lib: KbLibrary, n: number): Promise<string[]> {
  const index = await readIndex(lib.id)
  const inventory = index.sources
    .filter((s) => s.status === "embedded")
    .slice(0, 120)
    .map((s) => `- ${s.name}${s.note ? `：${s.note}` : ""}`)
    .join("\n")
  if (!inventory.trim()) return []

  const prompt =
    `你在为一个知识库（标题：${lib.title}；面向：${lib.audience || "通用"}）设计检索测试集。\n` +
    `下面是资料清单：\n${inventory}\n\n` +
    `请基于这些资料实际涵盖的内容，提出 ${n} 个该知识库用户最可能问、且应当能从资料中找到答案的问题。` +
    `覆盖不同主题与难度，问题要具体、可检索，不要空泛。`
  try {
    const raw = await geminiJson<{ questions?: string[] }>(prompt, QUESTIONS_SCHEMA, {
      model: judgeModel(),
      thinking: "adaptive",
    })
    return (raw.questions ?? [])
      .map((q) => (typeof q === "string" ? q.trim() : ""))
      .filter(Boolean)
      .slice(0, n)
  } catch (e) {
    console.log(`[v0] 评估问题生成失败：${(e as Error).message}`)
    return []
  }
}

// 对单个问题：真实检索 + 裁判打分
async function judgeOne(lib: KbLibrary, question: string): Promise<EvalCase> {
  const index = await readIndex(lib.id)
  // 评估用原始检索（关闭扩写/重排带来的额外开销？——保留重排以反映线上真实表现）
  const hits = await hybridSearch(question, index.chunks, { topK: 6, expand: true, useRerank: true })
  const context = hits.map((h, i) => `【片段${i + 1}】${h.chunk.text.slice(0, 600)}`).join("\n\n")

  if (!context.trim()) {
    return { question, retrievalScore: 0, faithfulnessScore: 0, missing: "未检索到任何相关上下文" }
  }

  const prompt =
    `你是严格的 RAG 评测裁判。给定【问题】与系统【召回上下文】，请客观评判：\n` +
    `1) retrieval_score(0-10)：上下文是否包含足以正确、完整回答问题的信息；\n` +
    `2) faithfulness_score(0-10)：若只依据该上下文作答，能在多大程度上做到有据可依、不需编造；\n` +
    `3) missing：简述缺失或薄弱之处（若充分则留空）。\n` +
    `只依据给定内容判断，不要使用你自己的外部知识补全。\n\n` +
    `【问题】\n${question}\n\n【召回上下文】\n${context}`
  try {
    const raw = await geminiJson<{
      retrieval_score?: number
      faithfulness_score?: number
      missing?: string
    }>(prompt, JUDGE_SCHEMA, { model: judgeModel(), thinking: "adaptive" })
    return {
      question,
      retrievalScore: clamp10(raw.retrieval_score),
      faithfulnessScore: clamp10(raw.faithfulness_score),
      missing: (raw.missing ?? "").trim(),
    }
  } catch (e) {
    console.log(`[v0] 评估裁判失败：${(e as Error).message}`)
    return { question, retrievalScore: 0, faithfulnessScore: 0, missing: "评判失败" }
  }
}

function clamp10(n: unknown): number {
  const v = typeof n === "number" ? n : 0
  return Math.max(0, Math.min(10, v))
}

// 运行一次完整评估，返回客观报告。
export async function evalRetrieval(lib: KbLibrary, opts: { n?: number } = {}): Promise<EvalReport> {
  const n = opts.n ?? 6
  const questions = await genQuestions(lib, n)
  if (questions.length === 0) {
    return {
      retrievalScore: 0,
      faithfulnessScore: 0,
      cases: [],
      weakTopics: [],
      summary: "知识库暂无可评估内容（无已入库来源）",
      at: Date.now(),
    }
  }

  const cases: EvalCase[] = []
  for (const q of questions) {
    cases.push(await judgeOne(lib, q))
  }

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const retrievalScore = Math.round(avg(cases.map((c) => c.retrievalScore)) * 10)
  const faithfulnessScore = Math.round(avg(cases.map((c) => c.faithfulnessScore)) * 10)
  const weakTopics = cases
    .filter((c) => c.retrievalScore < 6 && c.missing)
    .map((c) => c.missing)
    .slice(0, 5)

  return {
    retrievalScore,
    faithfulnessScore,
    cases,
    weakTopics,
    summary:
      `检索得分 ${retrievalScore}/100，忠实度 ${faithfulnessScore}/100（基于 ${cases.length} 道测试题）。` +
      (weakTopics.length ? `薄弱：${weakTopics.join("；")}` : "整体表现稳健。"),
    at: Date.now(),
  }
}
