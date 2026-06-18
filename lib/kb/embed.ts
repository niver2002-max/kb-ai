import { promises as fs } from "node:fs"
import type { KbChunk, KbSource } from "./types"
import type { ParsedSegment } from "./parse"
import { geminiEmbedBatch, geminiEmbedOne, geminiParts } from "./gemini"

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

// 基于关键词重合度的本地检索（无需任何外部服务），作为向量检索的降级方案。
// 简单分词：CJK 按双字 bigram + 连续 ASCII 词，计算覆盖与频次得分。
function tokenize(s: string): string[] {
  const lower = s.toLowerCase()
  const tokens: string[] = []
  // 连续的字母数字串（英文词、型号等）
  for (const m of lower.match(/[a-z0-9]+/g) ?? []) {
    if (m.length >= 2) tokens.push(m)
  }
  // CJK 字符的相邻双字组合
  const cjk = lower.match(/[\u4e00-\u9fff]/g) ?? []
  const cjkStr = cjk.join("")
  for (let i = 0; i < cjkStr.length - 1; i++) {
    tokens.push(cjkStr.slice(i, i + 2))
  }
  return tokens
}

function keywordScore(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0
  const textLower = text.toLowerCase()
  let hit = 0
  for (const qt of queryTokens) {
    if (textLower.includes(qt)) hit++
  }
  return hit / queryTokens.length
}

// 知识库检索：优先语义向量（chunk 有 embedding 时），
// 若嵌入不可用（chunk.embedding 为空）则自动降级为关键词检索。两种模式都在本地完成相似度计算。
export async function searchChunks(
  query: string,
  chunks: KbChunk[],
  topK = 6,
): Promise<SearchHit[]> {
  if (chunks.length === 0) return []
  const hasVectors = chunks.some((c) => c.embedding && c.embedding.length > 0)

  if (hasVectors) {
    try {
      const embedding = await geminiEmbedOne(query, "RETRIEVAL_QUERY")
      if (embedding.length > 0) {
        const scored = chunks.map((chunk) => ({
          chunk,
          score: cosine(embedding, chunk.embedding),
        }))
        scored.sort((a, b) => b.score - a.score)
        return scored.slice(0, topK)
      }
    } catch (e) {
      console.log(`[v0] 查询向量化失败，降级关键词检索：${(e as Error).message}`)
    }
  }

  // 关键词检索降级
  const qTokens = tokenize(query)
  const scored = chunks.map((chunk) => ({
    chunk,
    score: keywordScore(qTokens, chunk.text),
  }))
  scored.sort((a, b) => b.score - a.score)
  // 全 0 分（无任何关键词命中）时，返回前 topK 块兜底，保证有上下文
  const top = scored.slice(0, topK)
  return top.some((h) => h.score > 0) ? top.filter((h) => h.score > 0) : scored.slice(0, topK)
}
