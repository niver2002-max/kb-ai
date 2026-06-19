import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"

// 运行时 API 设置：持久化到 .kb-data/settings.json，由设置面板配置，gemini 客户端动态读取。
// 默认值回退到环境变量（兼容旧的 .env.local 配置方式）。
export interface ApiSettings {
  baseUrl: string // 第三方 Gemini 原生兼容端点（可只填域名，自动补 /v1beta）
  apiKey: string // API Key（x-goog-api-key）
  model: string // 对话/生成模型（活动对话固定用它，默认 gemini-3.5-flash）
  inspectModel: string // 巡检模型（高级模型，默认 gemini-3.1-pro-high）
  embedModel: string // 向量模型（Gemini 端点用）
  // 独立嵌入端点：很多第三方对话中转不提供 embedding 模型，可在此单独指向带向量能力的端点。
  // 留空则回退主端点（baseUrl/apiKey）。
  embedBaseUrl: string
  embedApiKey: string
  // 向量引擎选择：auto = 先尝试 Ollama 本地，失败回退 Gemini；ollama = 强制本地；gemini = 强制远程
  embedProvider: "auto" | "ollama" | "gemini"
  // Ollama 本地 embedding 配置
  ollamaUrl: string // 默认 http://localhost:11434
  ollamaEmbedModel: string // 默认 qwen3-embedding:0.6b（无 GPU 也能跑），有 6GB+ 显存可切 qwen3-embedding:8b
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
    inspectModel: process.env.GEMINI_INSPECT_MODEL || "gemini-3.1-pro-high",
    embedModel: process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001",
    embedBaseUrl: process.env.GEMINI_EMBED_BASE_URL || "",
    embedApiKey: process.env.GEMINI_EMBED_API_KEY || "",
    embedProvider: (process.env.EMBED_PROVIDER as any) || "auto",
    ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
    ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL || "qwen3-embedding:0.6b",
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
    inspectModel: s.inspectModel?.trim() || defaults.inspectModel,
    embedModel: s.embedModel?.trim() || defaults.embedModel,
    // 嵌入端点留空是合法的（表示复用主端点），因此不回退默认值，仅做 trim。
    embedBaseUrl: s.embedBaseUrl?.trim() ?? defaults.embedBaseUrl,
    embedApiKey: s.embedApiKey?.trim() ?? defaults.embedApiKey,
    embedProvider: s.embedProvider || defaults.embedProvider,
    ollamaUrl: s.ollamaUrl?.trim() || defaults.ollamaUrl,
    ollamaEmbedModel: s.ollamaEmbedModel?.trim() || defaults.ollamaEmbedModel,
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
