import { promises as fs } from "node:fs"
import type { KbSource } from "./types"
import { geminiPdf } from "./gemini"

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

// inline 方式上限：>20MB 的 PDF 不能直接塞进请求体（Gemini 限制），回退到本地文本抽取。
const PDF_INLINE_MAX_BYTES = 20 * 1024 * 1024
// 每批处理的页数：控制单次原生调用的输出量，避免密集表格被截断。
const PDF_PAGES_PER_BATCH = 4

// 本地文本层兜底（无 Gemini / 超大文件时）：用 unpdf 逐页抽取。
async function parsePdfLocal(loc: string): Promise<ParseResult> {
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
  if (charCount < 20) {
    return { segments: [], charCount: 0, needsVision: true }
  }
  return { segments, charCount }
}

// 把原始 PDF 按页范围拆成多个子 PDF（base64），用于分批送入 Gemini 原生理解。
async function splitPdfToBatches(
  data: Uint8Array,
  pagesPerBatch: number,
): Promise<{ base64: string; startPage: number; endPage: number }[]> {
  const { PDFDocument } = await import("pdf-lib")
  const src = await PDFDocument.load(data)
  const total = src.getPageCount()
  const batches: { base64: string; startPage: number; endPage: number }[] = []
  for (let start = 0; start < total; start += pagesPerBatch) {
    const end = Math.min(start + pagesPerBatch, total)
    const sub = await PDFDocument.create()
    const indices = Array.from({ length: end - start }, (_, k) => start + k)
    const copied = await sub.copyPages(src, indices)
    copied.forEach((p) => sub.addPage(p))
    const bytes = await sub.save()
    const base64 = Buffer.from(bytes).toString("base64")
    batches.push({ base64, startPage: start + 1, endPage: end })
  }
  return batches
}

// PDF 默认走 Gemini 原生文档理解：视觉读取表格/图形，按页分批 + 滚动摘要保留跨页上下文。
// 输出 Markdown（表格保留对齐、图形给出结构化描述），再交由上层切块、嵌入。
async function parsePdf(loc: string): Promise<ParseResult> {
  const buf = await fs.readFile(loc)

  // 超过 inline 上限：回退本地抽取（后续可接 Files API 处理大文件）。
  if (buf.byteLength > PDF_INLINE_MAX_BYTES) {
    return parsePdfLocal(loc)
  }

  let batches: { base64: string; startPage: number; endPage: number }[]
  try {
    batches = await splitPdfToBatches(new Uint8Array(buf), PDF_PAGES_PER_BATCH)
  } catch {
    // 拆分失败（加密/损坏等）→ 整份直接送原生理解
    const base64 = buf.toString("base64")
    const md = await geminiPdf(
      base64,
      "请把这份 PDF 的全部内容完整转写为结构化 Markdown：表格用 Markdown 表格并保持行列对齐；" +
        "图形/原理图/封装图请给出结构化文字描述（标题、可见标号、图例）。只输出内容，不要寒暄。",
    )
    const t = md.trim()
    return { segments: t ? [{ text: t, loc: "全文" }] : [], charCount: t.length, needsVision: t.length === 0 }
  }

  const segments: ParsedSegment[] = []
  let charCount = 0
  let rollingSummary = ""

  for (const b of batches) {
    const instruction =
      `这是一份 PDF 的第 ${b.startPage}–${b.endPage} 页。` +
      (rollingSummary
        ? `\n【前文摘要，仅供理解上下文，不要重复输出】\n${rollingSummary}\n`
        : "") +
      `\n请把这些页的全部内容完整转写为结构化 Markdown：` +
      `表格用 Markdown 表格并严格保持行列对齐（引脚号/信号名/Bank 等不能错位）；` +
      `图形/原理图/封装图请给出结构化文字描述（标题、可见标号、引脚坐标、图例）。` +
      `只输出本页范围的内容本身，不要添加解释或寒暄。`

    const md = (await geminiPdf(b.base64, instruction)).trim()
    if (md) {
      segments.push({ text: md, loc: `第 ${b.startPage}–${b.endPage} 页` })
      charCount += md.length
      // 更新滚动摘要（取本批结尾一段作为下批上下文，控制长度）
      rollingSummary = md.slice(-600)
    }
  }

  // 原生理解完全没产出 → 兜底本地抽取
  if (charCount === 0) {
    return parsePdfLocal(loc)
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
