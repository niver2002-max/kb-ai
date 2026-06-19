// Ollama 本地 embedding 客户端
// 封装 Ollama REST API 的 /api/embed 接口，支持批量嵌入、健康检查、模型检测。
// Ollama 天然支持 GPU/CPU 双模式：有 CUDA 自动 GPU 加速，无则 CPU 跑，用户无感。

import { getSettings } from "./settings"

const DEFAULT_OLLAMA_URL = "http://localhost:11434"

function getOllamaUrl(): string {
  const s = getSettings()
  return (s as any).ollamaUrl?.trim() || DEFAULT_OLLAMA_URL
}

function getOllamaModel(): string {
  const s = getSettings()
  return (s as any).ollamaEmbedModel?.trim() || "qwen3-embedding:0.6b"
}

export interface OllamaHealthResult {
  available: boolean
  models: string[]
  gpu: boolean
  error?: string
}

// 健康检查：Ollama 是否运行中 + 已拉取模型列表 + GPU 状态
export async function ollamaHealth(): Promise<OllamaHealthResult> {
  const base = getOllamaUrl()
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return { available: false, models: [], gpu: false, error: `HTTP ${res.status}` }
    const json = (await res.json()) as { models?: Array<{ name: string }> }
    const models = (json.models ?? []).map((m) => m.name)
    // GPU 检测：通过 /api/ps 查看当前加载模型是否用了 GPU
    let gpu = false
    try {
      const psRes = await fetch(`${base}/api/ps`)
      if (psRes.ok) {
        const ps = (await psRes.json()) as { models?: Array<{ size_vram?: number }> }
        gpu = (ps.models ?? []).some((m) => (m.size_vram ?? 0) > 0)
      }
    } catch {
      // /api/ps 不可用时默认 false
    }
    return { available: true, models, gpu }
  } catch (e) {
    return { available: false, models: [], gpu: false, error: (e as Error).message }
  }
}

// 检测指定模型是否已拉取
export async function ollamaHasModel(model?: string): Promise<boolean> {
  const target = model || getOllamaModel()
  const health = await ollamaHealth()
  if (!health.available) return false
  return health.models.some(
    (m) => m === target || m === `${target}:latest` || m.startsWith(`${target}:`),
  )
}

// 批量 embedding 调用（Ollama /api/embed 原生支持数组 input）
export async function ollamaEmbed(texts: string[], model?: string): Promise<number[][]> {
  if (texts.length === 0) return []
  const base = getOllamaUrl()
  const m = model || getOllamaModel()

  const res = await fetch(`${base}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: m, input: texts }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Ollama embed failed (${res.status}): ${body.slice(0, 200)}`)
  }

  const json = (await res.json()) as { embeddings?: number[][] }
  const embeddings = json.embeddings ?? []

  if (embeddings.length !== texts.length) {
    throw new Error(`Ollama 返回向量数 ${embeddings.length} ≠ 输入数 ${texts.length}`)
  }

  return embeddings
}

// 分批 embedding（避免单次过大 OOM，单批 256 条）
export async function ollamaEmbedBatch(texts: string[], model?: string): Promise<number[][]> {
  const BATCH = 256
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    const vecs = await ollamaEmbed(slice, model)
    out.push(...vecs)
  }
  return out
}

// 单条 embedding（用于查询向量化）
export async function ollamaEmbedOne(text: string, model?: string): Promise<number[]> {
  const [vec] = await ollamaEmbed([text], model)
  return vec ?? []
}
