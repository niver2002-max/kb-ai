// 知识库核心类型定义

export type SourceKind = "file" | "web"

// 文件 / 网页的大分类，由扫描阶段推断
export type SourceCategory =
  | "document" // 文本型文档：txt/md/pdf(文本层)/docx
  | "webpage" // 网页抓取
  | "code" // 源代码
  | "data" // 结构化数据：json/csv
  | "image" // 图片型文件（含扫描件，需视觉分析）
  | "binary" // 无法直接解析的二进制
  | "unknown"

export type SourceStatus =
  | "discovered" // 已发现，未处理
  | "queued" // 已排队等待构建
  | "parsing" // 解析中
  | "embedded" // 已切块并入库
  | "skipped" // 被筛选跳过
  | "error" // 处理失败

export interface KbSource {
  id: string
  kind: SourceKind
  // 文件用绝对路径；网页用 URL
  location: string
  name: string
  category: SourceCategory
  ext: string
  sizeBytes: number
  status: SourceStatus
  // 解析得到的纯文本长度
  charCount?: number
  chunkCount?: number
  error?: string
  // LLM 初筛给出的相关性/重要性（0-1）与一句话说明
  relevance?: number
  note?: string
  updatedAt: number
}

export interface KbChunk {
  id: string
  sourceId: string
  // 在该来源内的序号
  index: number
  text: string
  // 来源定位信息（页码 / 段落等），用于引用溯源
  loc?: string
  embedding: number[]
}

export interface KbIndex {
  // 知识库元信息
  rootDir: string | null
  createdAt: number
  updatedAt: number
  embeddingModel: string
  sources: KbSource[]
  chunks: KbChunk[]
}

export interface ScanResult {
  rootDir: string
  sources: KbSource[]
  totalSize: number
}
