import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"

// 运行时 API 设置：持久化到 .kb-data/settings.json，由设置面板配置，gemini 客户端动态读取。
// 默认值回退到环境变量（兼容旧的 .env.local 配置方式）。
export interface ApiSettings {
  baseUrl: string // 第三方 Gemini 原生兼容端点（可只填域名，自动补 /v1beta）
  apiKey: string // API Key（x-goog-api-key）
  model: string // 对话/生成模型
  embedModel: string // 向量模型
  temperature: number // 采样温度
  stream: boolean // 是否启用 SSE 流式
}

const DATA_DIR = path.join(process.cwd(), ".kb-data")
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json")

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"

function envDefaults(): ApiSettings {
  const t = Number(process.env.GEMINI_TEMPERATURE)
  return {
    baseUrl: process.env.GEMINI_BASE_URL || DEFAULT_BASE,
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash",
    embedModel: process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001",
    temperature: Number.isFinite(t) ? t : 0,
    stream: (process.env.GEMINI_STREAM ?? "true").toLowerCase() !== "false",
  }
}

// 同步内存缓存：模块加载时从文件读取一次，之后读写都走缓存（文件极小）。
let cache: ApiSettings | null = null

function load(): ApiSettings {
  if (cache) return cache
  const defaults = envDefaults()
  try {
    const raw = readFileSync(SETTINGS_FILE, "utf8")
    const saved = JSON.parse(raw) as Partial<ApiSettings>
    cache = { ...defaults, ...saved }
  } catch {
    cache = defaults
  }
  return cache
}

// 读取当前生效设置（同步）。空字段回退默认值。
export function getSettings(): ApiSettings {
  const s = load()
  const defaults = envDefaults()
  return {
    baseUrl: s.baseUrl?.trim() || defaults.baseUrl,
    apiKey: s.apiKey?.trim() || defaults.apiKey,
    model: s.model?.trim() || defaults.model,
    embedModel: s.embedModel?.trim() || defaults.embedModel,
    temperature: Number.isFinite(s.temperature) ? s.temperature : defaults.temperature,
    stream: typeof s.stream === "boolean" ? s.stream : defaults.stream,
  }
}

// 更新设置（合并写入文件 + 刷新缓存）。
export function updateSettings(partial: Partial<ApiSettings>): ApiSettings {
  const current = load()
  const next: ApiSettings = { ...current, ...partial }
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8")
  } catch {
    // 写失败不致命：至少更新内存缓存，本次运行内生效
  }
  cache = next
  return getSettings()
}

// 是否已配置 API Key（用于 UI 提示）
export function hasApiKey(): boolean {
  return !!getSettings().apiKey
}
