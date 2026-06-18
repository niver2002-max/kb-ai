import { promises as fs } from "node:fs"
import type { KbChunk, KbSource } from "./types"
import type { ParsedSegment } from "./parse"
import { geminiEmbedBatch, geminiEmbedOne, geminiParts } from "./gemini"

// 为一组文本片段生成 embedding（Gemini 原生批量向量端点），并组装成 chunk
export async function embedSegments(
  sourceId: string,
  segments: ParsedSegment[],
): Promise<KbChunk[]> {
  if (segments.length === 0) return []
  const embeddings = await geminiEmbedBatch(segments.map((s) => s.text))
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

// 基于余弦相似度的本地向量检索（查询向量用 RETRIEVAL_QUERY 任务类型）
export async function searchChunks(
  query: string,
  chunks: KbChunk[],
  topK = 6,
): Promise<SearchHit[]> {
  if (chunks.length === 0) return []
  const embedding = await geminiEmbedOne(query, "RETRIEVAL_QUERY")
  const scored = chunks.map((chunk) => ({
    chunk,
    score: cosine(embedding, chunk.embedding),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}
