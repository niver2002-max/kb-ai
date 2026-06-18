// 混合检索编排器（2026 一线 RAG 流水线）：
//   查询扩写(多查询+HyDE) → 向量 & BM25 双路召回 → RRF 倒数排名融合 → LLM 重排 → MMR 去冗。
// 相比“向量与关键词二选一”，混合召回能同时抓住语义(向量)与专有名词/型号(BM25)；
// RRF 无需调参即可稳健融合多路结果；重排提升精排质量；MMR 去除近重复，提升上下文覆盖。
// 任一增强环节失败都会优雅降级，保证总能返回结果。

import type { KbChunk } from "./types"
import { geminiEmbedOne } from "./gemini"
import { keywordSearch, tokenize } from "./retrieval"
import { VectorIndex } from "./vector-index"
import { expandQuery } from "./query-expand"
import { rerank } from "./rerank"

export interface SearchHit {
  chunk: KbChunk
  score: number
}

export interface HybridOptions {
  topK?: number // 最终返回数量
  expand?: boolean // 是否做查询扩写(多查询+HyDE)
  useRerank?: boolean // 是否做 LLM 重排
  candidateK?: number // 进入融合/重排的候选数量
  history?: string // 对话上下文(供查询扩写解析指代)
  mmrLambda?: number // MMR 相关性/多样性权衡
}

// RRF 常数：标准取 60，弱化排名靠后项的边际贡献。
const RRF_K = 60

// 把一组“有序下标列表”用倒数排名融合成统一打分。
function rrfFuse(rankedLists: number[][]): Map<number, number> {
  const fused = new Map<number, number>()
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const idx = list[rank]
      fused.set(idx, (fused.get(idx) ?? 0) + 1 / (RRF_K + rank + 1))
    }
  }
  return fused
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// MMR 去冗：在保持相关性顺序的前提下，剔除与已选高度重复的块。
function mmrDedup(orderedIdx: number[], texts: string[], topK: number, lambda: number): number[] {
  if (orderedIdx.length <= topK) return orderedIdx
  const tokenSets = new Map<number, Set<string>>()
  const tok = (i: number) => {
    let s = tokenSets.get(i)
    if (!s) {
      s = new Set(tokenize(texts[i]))
      tokenSets.set(i, s)
    }
    return s
  }
  const selected: number[] = []
  const remaining = [...orderedIdx]
  // 相关性以“排名位置”近似（越靠前越相关）
  const relOf = new Map<number, number>()
  orderedIdx.forEach((idx, pos) => relOf.set(idx, 1 - pos / orderedIdx.length))

  while (selected.length < topK && remaining.length > 0) {
    let bestPos = -1
    let bestVal = -Infinity
    for (let p = 0; p < remaining.length; p++) {
      const idx = remaining[p]
      let maxSim = 0
      for (const s of selected) maxSim = Math.max(maxSim, jaccard(tok(idx), tok(s)))
      const mmr = lambda * (relOf.get(idx) ?? 0) - (1 - lambda) * maxSim
      if (mmr > bestVal) {
        bestVal = mmr
        bestPos = p
      }
    }
    if (bestPos === -1) break
    selected.push(remaining.splice(bestPos, 1)[0])
  }
  return selected
}

// 主入口：对一组 chunk 执行完整混合检索流水线。
export async function hybridSearch(
  query: string,
  chunks: KbChunk[],
  options: HybridOptions = {},
): Promise<SearchHit[]> {
  if (chunks.length === 0 || !query.trim()) return []
  const topK = options.topK ?? 8
  const expand = options.expand ?? true
  const useRerank = options.useRerank ?? true
  const candidateK = options.candidateK ?? Math.max(topK * 4, 24)
  const mmrLambda = options.mmrLambda ?? 0.7

  const texts = chunks.map((c) => c.text)
  const hasVectors = chunks.some((c) => c.embedding && c.embedding.length > 0)

  // 1) 查询扩写（多查询 + HyDE）
  let queries = [query]
  let hyde = ""
  if (expand) {
    const ex = await expandQuery(query, { history: options.history })
    if (ex.queries.length > 0) queries = ex.queries
    hyde = ex.hyde
  }

  const rankedLists: number[][] = []

  // 2) 向量召回（对每个查询 + HyDE 各跑一路）
  if (hasVectors) {
    const vindex = new VectorIndex(chunks.map((c) => c.embedding))
    const vecTexts = [...queries]
    if (hyde) vecTexts.push(hyde)
    try {
      const embeds = await Promise.all(
        vecTexts.map((t) => geminiEmbedOne(t, "RETRIEVAL_QUERY").catch(() => [] as number[])),
      )
      for (const emb of embeds) {
        if (emb.length === 0) continue
        const matches = vindex.search(emb, candidateK)
        rankedLists.push(matches.map((m) => m.index))
      }
    } catch (e) {
      console.log(`[v0] 向量召回异常，仅用关键词路：${(e as Error).message}`)
    }
  }

  // 3) BM25 关键词召回（对每个查询各跑一路；专有名词/型号靠它兜住）
  for (const q of queries) {
    const kw = keywordSearch(q, texts, candidateK)
    rankedLists.push(kw.map((r) => r.index))
  }

  // 无任何召回（极端情况）：返回前 topK 兜底
  if (rankedLists.length === 0) {
    return chunks.slice(0, topK).map((c) => ({ chunk: c, score: 0 }))
  }

  // 4) RRF 融合多路结果
  const fused = rrfFuse(rankedLists)
  let candidates = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, candidateK)
    .map(([idx]) => idx)

  // 5) LLM 重排（对融合后的候选精排）
  if (useRerank && candidates.length > 1) {
    const order = await rerank(
      query,
      candidates.map((idx) => ({ text: texts[idx] })),
      candidates.length,
    )
    candidates = order.map((pos) => candidates[pos])
  }

  // 6) MMR 去冗，取最终 topK
  const finalIdx = mmrDedup(candidates, texts, topK, mmrLambda)

  // 融合分用于展示（归一化到 0~1）
  const maxFused = Math.max(...finalIdx.map((i) => fused.get(i) ?? 0), 1e-9)
  return finalIdx.map((i) => ({
    chunk: chunks[i],
    score: (fused.get(i) ?? 0) / maxFused,
  }))
}
