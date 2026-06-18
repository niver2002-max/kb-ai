// 纯原生 Gemini API 客户端 —— 直接打第三方 API 端点，不经过任何 SDK / 网关。
// 走的是 Gemini 原生 REST 协议，因此任何「兼容 Gemini 原生格式」的第三方中转/代理都能用。
//
// 关键约定（已对照官方文档）：
//   · 文本/JSON：POST {BASE}/models/{model}:generateContent
//   · 流式：    POST {BASE}/models/{model}:streamGenerateContent?alt=sse
//   · 向量：    POST {BASE}/models/{embedModel}:embedContent | :batchEmbedContents
//   · 鉴权头：  x-goog-api-key: GEMINI_API_KEY
//
// 第三方端点配置：在 .env.local 设置 GEMINI_BASE_URL 指向你的中转地址，例如：
//   GEMINI_BASE_URL=https://你的中转域名/v1beta
// 不设置时回退到 Google 官方端点。末尾多余的斜杠会被自动去除。
const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"
const BASE = (process.env.GEMINI_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "")

// 仅使用 Gemini 3.5 Flash 原生端点（非 chat 接口）
export const GEMINI_MODEL = "gemini-3.5-flash"
// 向量模型同样走 Gemini 原生端点
export const GEMINI_EMBED_MODEL = "gemini-embedding-001"

// 温度固定为 0（按你的要求）。
// ⚠️ 注意：Google 官方建议 Gemini 3 系列保持 temperature=1.0，设为 0 在复杂推理/数学任务上
// 可能出现循环或质量下降。若发现异常，把这里改回 1 即可。
export const TEMPERATURE = 0

// thinkingLevel：minimal | low | medium(默认) | high。
// "adaptive" = 不固定档位，交给 Gemini 原生的「动态思考(dynamic thinking)」按问题复杂度自动调节，
// 这同时就是「自适应 thinking」与「自适应 effort」——Gemini 没有独立的 effort 参数，
// 自适应深度由动态思考统一承担。
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "adaptive"

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY
  if (!key) {
    throw new Error(
      "缺少 GEMINI_API_KEY 环境变量。请在本地 .env.local 中设置你的 Gemini API Key。",
    )
  }
  return key
}

// 组装 thinkingConfig：adaptive → 省略 thinkingLevel（触发原生动态思考）；其余传入固定档位。
function thinkingConfig(level: ThinkingLevel): Record<string, unknown> | undefined {
  if (level === "adaptive") return undefined
  return { thinkingLevel: level }
}

interface GenPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

interface GenOpts {
  system?: string
  thinking?: ThinkingLevel
  // 结构化输出：传入 Gemini OpenAPI 风格 schema（type 用大写枚举）
  responseSchema?: Record<string, unknown>
}

function buildBody(
  contents: Array<{ role: string; parts: GenPart[] }>,
  opts: GenOpts,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { temperature: TEMPERATURE }
  const tc = thinkingConfig(opts.thinking ?? "adaptive")
  if (tc) generationConfig.thinkingConfig = tc
  if (opts.responseSchema) {
    generationConfig.responseMimeType = "application/json"
    generationConfig.responseSchema = opts.responseSchema
  }
  const body: Record<string, unknown> = { contents, generationConfig }
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] }
  }
  return body
}

async function callGenerate(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(
    `${BASE}/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getApiKey(),
      },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`Gemini generateContent 失败 (${res.status}): ${detail.slice(0, 500)}`)
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
  }
  const parts = json.candidates?.[0]?.content?.parts ?? []
  // 跳过 thought 摘要，只取正式回答文本
  return parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
}

// 纯文本生成
export async function geminiText(prompt: string, opts: GenOpts = {}): Promise<string> {
  const body = buildBody([{ role: "user", parts: [{ text: prompt }] }], opts)
  return callGenerate(body)
}

// 多模态生成（图片 + 文本），用于扫描件/原理图/图片解析
export async function geminiParts(parts: GenPart[], opts: GenOpts = {}): Promise<string> {
  const body = buildBody([{ role: "user", parts }], opts)
  return callGenerate(body)
}

// 结构化 JSON 生成（带 schema），自动解析为对象
export async function geminiJson<T>(
  prompt: string,
  responseSchema: Record<string, unknown>,
  opts: GenOpts = {},
): Promise<T> {
  const raw = await geminiText(prompt, { ...opts, responseSchema })
  return JSON.parse(raw) as T
}

// 流式生成纯文本：返回一个 ReadableStream<Uint8Array>（已解码为纯文本增量），
// 供路由直接以 text/plain 流式返回给前端。
export async function geminiStream(
  contents: Array<{ role: string; parts: GenPart[] }>,
  opts: GenOpts = {},
): Promise<ReadableStream<Uint8Array>> {
  const body = buildBody(contents, opts)
  const res = await fetch(
    `${BASE}/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getApiKey(),
      },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "")
    throw new Error(`Gemini streamGenerateContent 失败 (${res.status}): ${detail.slice(0, 500)}`)
  }

  const upstream = res.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let rawLogged = 0
  let emittedAny = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await upstream.read()
      if (done) {
        if (!emittedAny) {
          console.log("[v0] stream end, NO text emitted. tail buffer:", buffer.slice(0, 500))
        }
        controller.close()
        return
      }
      const decoded = decoder.decode(value, { stream: true })
      if (rawLogged < 3) {
        console.log(`[v0] raw chunk #${rawLogged}:`, JSON.stringify(decoded.slice(0, 800)))
        rawLogged++
      }
      buffer += decoded
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === "[DONE]") continue
        try {
          const chunk = JSON.parse(data) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string; thought?: boolean }> }
            }>
          }
          const parts = chunk.candidates?.[0]?.content?.parts ?? []
          for (const p of parts) {
            if (!p.thought && typeof p.text === "string" && p.text) {
              emittedAny = true
              controller.enqueue(encoder.encode(p.text))
            }
          }
        } catch {
          // 跳过不完整/无法解析的 SSE 片段
        }
      }
    },
    cancel() {
      void upstream.cancel()
    },
  })
}

// 单条文本向量
export async function geminiEmbedOne(
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_QUERY",
): Promise<number[]> {
  const res = await fetch(
    `${BASE}/models/${GEMINI_EMBED_MODEL}:embedContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getApiKey(),
      },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType,
      }),
    },
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`Gemini embedContent 失败 (${res.status}): ${detail.slice(0, 500)}`)
  }
  const json = (await res.json()) as { embedding?: { values?: number[] } }
  return json.embedding?.values ?? []
}

// 批量文本向量（自动分批，单批上限 100 条）
export async function geminiEmbedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  const BATCH = 100
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    const res = await fetch(
      `${BASE}/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": getApiKey(),
        },
        body: JSON.stringify({
          requests: slice.map((text) => ({
            model: `models/${GEMINI_EMBED_MODEL}`,
            content: { parts: [{ text }] },
            taskType: "RETRIEVAL_DOCUMENT",
          })),
        }),
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(`Gemini batchEmbedContents 失败 (${res.status}): ${detail.slice(0, 500)}`)
    }
    const json = (await res.json()) as { embeddings?: Array<{ values?: number[] }> }
    for (const e of json.embeddings ?? []) out.push(e.values ?? [])
  }
  return out
}
