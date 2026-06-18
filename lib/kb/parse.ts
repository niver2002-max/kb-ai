import { promises as fs } from "node:fs"
import type { KbSource } from "./types"

// 单个来源解析后的结果：若干带定位信息的文本片段
export interface ParsedSegment {
  text: string
  loc?: string
}

export interface ParseResult {
  segments: ParsedSegment[]
  charCount: number
  // 若该来源无法在本地直接抽取文本（如图片/扫描件），标记为需要视觉分析
  needsVision?: boolean
}

const MAX_TEXT_BYTES = 8 * 1024 * 1024 // 单文件最多读 8MB 文本，防止超大文件拖垮

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

async function readTextFile(loc: string): Promise<string> {
  const buf = await fs.readFile(loc)
  return buf.subarray(0, MAX_TEXT_BYTES).toString("utf8")
}

// 文本层 PDF 用 unpdf 抽取，逐页返回，保留页码用于引用
async function parsePdf(loc: string): Promise<ParseResult> {
  const { extractText, getDocumentProxy } = await import("unpdf")
  const data = new Uint8Array(await fs.readFile(loc))
  const pdf = await getDocumentProxy(data)
  const { text } = await extractText(pdf, { mergePages: false })
  const pages = Array.isArray(text) ? text : [text]
  const segments: ParsedSegment[] = []
  let charCount = 0
  pages.forEach((pageText, i) => {
    const t = (pageText || "").trim()
    if (t.length > 0) {
      segments.push({ text: t, loc: `第 ${i + 1} 页` })
      charCount += t.length
    }
  })
  // 没有文本层 → 大概率是图片型/扫描件，需走视觉分析
  if (charCount < 20) {
    return { segments: [], charCount: 0, needsVision: true }
  }
  return { segments, charCount }
}

async function parseDocx(loc: string): Promise<ParseResult> {
  const mammoth = await import("mammoth")
  const buffer = await fs.readFile(loc)
  const { value } = await mammoth.extractRawText({ buffer })
  const text = (value || "").trim()
  return { segments: text ? [{ text }] : [], charCount: text.length }
}

// 解析单个来源（文件）。网页抓取走 fetchWeb。
export async function parseFile(source: KbSource): Promise<ParseResult> {
  const ext = source.ext.toLowerCase()

  if (source.category === "image") {
    return { segments: [], charCount: 0, needsVision: true }
  }
  if (source.category === "binary") {
    return { segments: [], charCount: 0 }
  }

  if (ext === ".pdf") {
    return parsePdf(source.location)
  }
  if (ext === ".docx") {
    return parseDocx(source.location)
  }
  if (ext === ".html" || ext === ".htm") {
    const raw = await readTextFile(source.location)
    const text = stripHtml(raw)
    return { segments: text ? [{ text }] : [], charCount: text.length }
  }

  // 其余按纯文本处理：txt/md/code/json/csv/...
  const text = (await readTextFile(source.location)).trim()
  return { segments: text ? [{ text }] : [], charCount: text.length }
}

// 抓取网页并抽取正文
export async function fetchWeb(url: string): Promise<ParseResult> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; LocalKnowledgeBase/1.0; +local)",
    },
    redirect: "follow",
  })
  if (!res.ok) {
    throw new Error(`抓取失败 ${res.status}: ${url}`)
  }
  const ct = res.headers.get("content-type") || ""
  const raw = await res.text()
  const text = ct.includes("html") ? stripHtml(raw) : raw.trim()
  return { segments: text ? [{ text, loc: url }] : [], charCount: text.length }
}

// 将解析片段切成适合嵌入的小块（按字符数，带重叠以保留上下文）
export function chunkSegments(
  segments: ParsedSegment[],
  chunkSize = 1200,
  overlap = 150,
): ParsedSegment[] {
  const chunks: ParsedSegment[] = []
  for (const seg of segments) {
    const text = seg.text
    if (text.length <= chunkSize) {
      chunks.push(seg)
      continue
    }
    let start = 0
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length)
      chunks.push({ text: text.slice(start, end), loc: seg.loc })
      if (end >= text.length) break
      start = end - overlap
    }
  }
  return chunks
}
