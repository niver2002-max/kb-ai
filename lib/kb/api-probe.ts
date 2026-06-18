import { normalizeBase } from "./gemini"

// ===== 智能 API 探测：测端点、列模型、测活模型 =====

export interface EndpointTestResult {
  ok: boolean
  baseUrl: string // 实际可用的规整端点
  message: string
  modelCount?: number
}

export interface ModelInfo {
  id: string // 去掉 "models/" 前缀的模型名
  displayName?: string
  methods: string[] // supportedGenerationMethods
  canGenerate: boolean // 支持 generateContent
  canEmbed: boolean // 支持 embedContent
}

export interface ModelLiveResult {
  id: string
  alive: boolean
  latencyMs?: number
  error?: string
}

function authHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", "x-goog-api-key": apiKey }
}

// 生成候选端点：用户可能填了域名、/v1beta、/v1 或带尾斜杠，全部尝试以最大化命中。
function candidateBases(raw: string): string[] {
  const trimmed = raw.trim().replace(/\/+$/, "")
  const set = new Set<string>()
  set.add(normalizeBase(trimmed)) // 自动补 /v1beta
  set.add(trimmed) // 原样
  // 若没有版本段，补 /v1 作为备选
  if (!/\/v1beta$|\/v1$/.test(trimmed)) {
    set.add(`${trimmed}/v1`)
  }
  // 若结尾是 /v1，也尝试 /v1beta（Gemini 原生更常用 v1beta）
  if (/\/v1$/.test(trimmed)) {
    set.add(trimmed.replace(/\/v1$/, "/v1beta"))
  }
  return Array.from(set)
}

async function fetchModels(
  base: string,
  apiKey: string,
  timeoutMs = 15000,
): Promise<{ ok: boolean; status: number; models?: unknown[]; isHtml?: boolean; error?: string }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/models?pageSize=1000`, {
      method: "GET",
      headers: authHeaders(apiKey),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (text.trimStart().startsWith("<")) {
      return { ok: false, status: res.status, isHtml: true }
    }
    let json: { models?: unknown[]; error?: { message?: string } }
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, status: res.status, error: text.slice(0, 200) }
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: json.error?.message || text.slice(0, 200) }
    }
    return { ok: true, status: res.status, models: json.models ?? [] }
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message }
  } finally {
    clearTimeout(t)
  }
}

// 智能测端点：逐个候选端点试 GET /models，返回第一个可用的规整地址。
export async function testEndpoint(rawBase: string, apiKey: string): Promise<EndpointTestResult> {
  if (!apiKey.trim()) {
    return { ok: false, baseUrl: rawBase, message: "请先填写 API Key" }
  }
  const candidates = candidateBases(rawBase)
  let authError = ""
  let htmlSeen = false
  for (const base of candidates) {
    const r = await fetchModels(base, apiKey)
    if (r.ok) {
      return {
        ok: true,
        baseUrl: base,
        message: `端点可用：${base}（发现 ${r.models?.length ?? 0} 个模型）`,
        modelCount: r.models?.length ?? 0,
      }
    }
    if (r.status === 401 || r.status === 403) authError = r.error || "鉴权失败"
    if (r.isHtml) htmlSeen = true
  }
  if (authError) {
    return { ok: false, baseUrl: rawBase, message: `API Key 无效或无权限：${authError}` }
  }
  if (htmlSeen) {
    return {
      ok: false,
      baseUrl: rawBase,
      message: "端点返回了网页（HTML）而非 API 响应，请检查中转地址是否正确（通常形如 https://域名/v1beta）",
    }
  }
  return { ok: false, baseUrl: rawBase, message: "所有候选端点均不可用，请检查地址与网络" }
}

// 智能列模型：返回可用端点下的全部模型，并标注可对话 / 可嵌入。
export async function listModels(
  rawBase: string,
  apiKey: string,
): Promise<{ ok: boolean; baseUrl: string; models: ModelInfo[]; message: string }> {
  if (!apiKey.trim()) return { ok: false, baseUrl: rawBase, models: [], message: "请先填写 API Key" }
  const candidates = candidateBases(rawBase)
  for (const base of candidates) {
    const r = await fetchModels(base, apiKey)
    if (r.ok && r.models) {
      const models: ModelInfo[] = r.models
        .map((m) => {
          const obj = m as {
            name?: string
            id?: string
            displayName?: string
            supportedGenerationMethods?: string[] | null
          }
          // 兼容两种返回：Gemini 原生用 name="models/xxx"，部分中转用 id="xxx"
          const id = (obj.name ?? obj.id ?? "").replace(/^models\//, "")
          const methods = obj.supportedGenerationMethods ?? []
          // 许多第三方中转不返回 supportedGenerationMethods（为 null/空），
          // 此时用模型名启发式推断能力，避免列表全空。
          const hasMethods = methods.length > 0
          const looksEmbed = /embed|embedding/i.test(id)
          const canGenerate = hasMethods ? methods.includes("generateContent") : !looksEmbed
          const canEmbed = hasMethods ? methods.includes("embedContent") : looksEmbed
          return { id, displayName: obj.displayName, methods, canGenerate, canEmbed }
        })
        .filter((m) => m.id) // 丢弃解析不出 id 的异常项
      return { ok: true, baseUrl: base, models, message: `发现 ${models.length} 个模型` }
    }
  }
  return { ok: false, baseUrl: rawBase, models: [], message: "无法列出模型，请先测试端点与 API Key" }
}

// 测活单个模型：发一个最小 generateContent / embedContent 请求，测真实可用性与延迟。
export async function pingModel(
  base: string,
  apiKey: string,
  modelId: string,
  kind: "generate" | "embed" = "generate",
  timeoutMs = 30000,
): Promise<ModelLiveResult> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  try {
    const url =
      kind === "embed"
        ? `${base}/models/${modelId}:embedContent`
        : `${base}/models/${modelId}:generateContent`
    const body =
      kind === "embed"
        ? { model: `models/${modelId}`, content: { parts: [{ text: "ping" }] } }
        : { contents: [{ role: "user", parts: [{ text: "ping" }] }] }
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    const latencyMs = Date.now() - started
    if (text.trimStart().startsWith("<")) {
      return { id: modelId, alive: false, error: "返回 HTML（端点路径不对）" }
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = JSON.parse(text) as { error?: { message?: string } }
        if (j.error?.message) msg = j.error.message
      } catch {
        /* ignore */
      }
      return { id: modelId, alive: false, latencyMs, error: msg.slice(0, 120) }
    }
    return { id: modelId, alive: true, latencyMs }
  } catch (e) {
    return { id: modelId, alive: false, error: (e as Error).message }
  } finally {
    clearTimeout(t)
  }
}
