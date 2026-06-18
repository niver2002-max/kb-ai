import { promises as fs } from "node:fs"
import type { KbChunk, KbSource } from "./types"
import type { ParsedSegment } from "./parse"
import { geminiEmbedBatch, geminiEmbedOne, geminiParts } from "./gemini"
import { keywordSearch, tokenize } from "./retrieval"

// 为一组文本片段生成 embedding（Gemini 原生批量向量端点），并组装成 chunk。
// 关键容错：若嵌入端点不可用（部分第三方中转不提供向量服务，如持续 503），
// 不再抛错丢失内容，而是以空向量入库；检索时自动降级为本地关键词检索。
export async function embedSegments(
  sourceId: string,
  segments: ParsedSegment[],
): Promise<KbChunk[]> {
  if (segments.length === 0) return []
  let embeddings: number[][] = []
  try {
    embeddings = await geminiEmbedBatch(segments.map((s) => s.text))
  } catch (e) {
    console.log(`[v0] 嵌入不可用，内容以关键词模式入库：${(e as Error).message}`)
    embeddings = []
  }
  return segments.map((seg, i) => ({
    id: `${sourceId}-${i}`,
    sourceId,
    index: i,
    text: seg.text,
    loc: seg.loc,
    embedding: embeddings[i] ?? [],
  }))
}

// 对图片型来源（扫描件 / 原理图 / 图片）用 Gemini 视觉能力抽取结构化文本描述。
// 思考深度用 adaptive（动态思考自动按复杂度调节）。
export async function visionExtract(source: KbSource): Promise<ParsedSegment[]> {
  const buffer = await fs.readFile(source.location)
  const base64 = buffer.toString("base64")
  const mime = guessMime(source.ext)

  const text = await geminiParts(
    [
      {
        text:
          "请详细描述这张图片中的全部信息，用于构建知识库检索。" +
          "尽可能提取：所有可见文字/标号/标题、图中包含的对象或元件、" +
          "整体表达的内容或功能。若是工程图/原理图，请列出可识别的元件标号、" +
          "文字标注和图纸标题，但不要臆造无法看清的连接关系。用中文输出。",
      },
      { inlineData: { mimeType: mime, data: base64 } },
    ],
    { thinking: "adaptive" },
  )
  const t = text.trim()
  return t ? [{ text: t, loc: source.name }] : []
}

function guessMime(ext: string): string {
  const e = ext.toLowerCase()
  if (e === ".png") return "image/png"
  if (e === ".gif") return "image/gif"
  if (e === ".webp") return "image/webp"
  if (e === ".bmp") return "image/bmp"
  if (e === ".tiff" || e === ".tif") return "image/tiff"
  if (e === ".pdf") return "application/pdf"
  return "image/jpeg"
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface SearchHit {
  chunk: KbChunk
  score: number
}

// 知识库检索：优先语义向量（chunk 有 embedding 时），并对向量候选做 MMR 多样性去重；
// 若嵌入不可用（chunk.embedding 为空）则自动降级为 BM25 关键词检索（短语加权 + MMR）。
// 两种模式都在本地完成，无需外部服务即可工作。
export async function searchChunks(
  query: string,
  chunks: KbChunk[],
  topK = 8,
): Promise<SearchHit[]> {
  if (chunks.length === 0) return []
  const hasVectors = chunks.some((c) => c.embedding && c.embedding.length > 0)

  if (hasVectors) {
    try {
      const embedding = await geminiEmbedOne(query, "RETRIEVAL_QUERY")
      if (embedding.length > 0) {
        const scored = chunks
          .map((chunk) => ({ chunk, score: cosine(embedding, chunk.embedding) }))
          .sort((a, b) => b.score - a.score)
        // 取较大候选集再 MMR 去冗余，提升上下文多样性与覆盖
        return mmrSelectHits(query, scored.slice(0, Math.max(topK * 4, 24)), topK)
      }
    } catch (e) {
      console.log(`[v0] 查询向量化失败，降级 BM25 关键词检索：${(e as Error).message}`)
    }
  }

  // BM25 + 短语加权 + MMR 关键词检索
  const results = keywordSearch(
    query,
    chunks.map((c) => c.text),
    topK,
  )
  return results.map((r) => ({ chunk: chunks[r.index], score: r.score }))
}

// 对已按相关性排序的向量候选做 MMR：在相关性与多样性间平衡，去除近重复块。
function mmrSelectHits(query: string, ranked: SearchHit[], topK: number): SearchHit[] {
  if (ranked.length <= topK) return ranked
  const lambda = 0.7
  const tokenSets = ranked.map((h) => new Set(tokenize(h.chunk.text)))
  const maxScore = ranked[0]?.score || 1
  const selected: number[] = []
  const remaining = ranked.map((_, i) => i)

  while (selected.length < topK && remaining.length > 0) {
    let bestPos = -1
    let bestVal = -Infinity
    for (let p = 0; p < remaining.length; p++) {
      const i = remaining[p]
      const rel = (ranked[i].score || 0) / (maxScore || 1)
      let maxSim = 0
      for (const s of selected) {
        const a = tokenSets[i]
        const b = tokenSets[s]
        let inter = 0
        for (const t of a) if (b.has(t)) inter++
        const sim = a.size + b.size - inter === 0 ? 0 : inter / (a.size + b.size - inter)
        maxSim = Math.max(maxSim, sim)
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim
      if (mmr > bestVal) {
        bestVal = mmr
        bestPos = p
      }
    }
    if (bestPos === -1) break
    selected.push(remaining.splice(bestPos, 1)[0])
  }
  return selected.map((i) => ranked[i])
}
