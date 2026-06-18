import type { SourceCategory, SourceStatus } from "./types"

export const CATEGORY_LABEL: Record<SourceCategory, string> = {
  document: "文档",
  webpage: "网页",
  code: "代码",
  data: "数据",
  image: "图片",
  binary: "二进制",
  unknown: "未知",
}

export const STATUS_LABEL: Record<SourceStatus, string> = {
  discovered: "已发现",
  queued: "排队中",
  parsing: "解析中",
  embedded: "已入库",
  skipped: "已跳过",
  error: "失败",
}

// 状态对应的 Badge 样式（基于设计令牌）
export const STATUS_CLASS: Record<SourceStatus, string> = {
  discovered: "bg-muted text-muted-foreground",
  queued: "bg-muted text-muted-foreground",
  parsing: "bg-foreground/10 text-foreground",
  embedded: "bg-foreground text-background",
  skipped: "bg-muted text-muted-foreground line-through",
  error: "bg-destructive/15 text-destructive",
}

export function formatSize(bytes: number): string {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
