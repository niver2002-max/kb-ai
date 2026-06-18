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
//   GEMINI_BASE_URL=https://你的中转域名/v1beta  （也可只填域名，会自动补 /v1beta）
// 不设置时回退到 Google 官方端点。
const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"

function normalizeBase(raw: string): string {
  let b = raw.trim().replace(/\/+$/, "") // 去掉末尾斜杠
  // Gemini 原生协议要求带版本路径。若用户只填了域名（无 /v1beta 或 /v1），自动补 /v1beta，
  // 否则请求会打到中转站点的网页路由，返回 HTML 而非 JSON。
  if (!/\/v1beta$|\/v1$|\/v1beta\/|\/v1\//.test(b)) {
    b = `${b}/v1beta`
  }
  return b
}

const BASE = normalizeBase(process.env.GEMINI_BASE_URL || DEFAULT_BASE)

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
  // Gemini 原生工具，例如 [{ url_context: {} }]（抓网页）、[{ google_search: {} }]（联网检索）
  tools?: Record<string, unknown>[]
}

function buildBody(
  contents: Array<{ role: string; parts: GenPart[] }>,
  opts: GenOpts,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { temperature: TEMPERATURE }
  const tc = thinkingConfig(opts.thinking ?? "adaptive")
  if (tc) generationConfig.thinkingConfig = tc
  // 注意：responseSchema（结构化输出）与 tools（工具调用）互斥，不要同时传。
  if (opts.responseSchema) {
    generationConfig.responseMimeType = "application/json"
    generationConfig.responseSchema = opts.responseSchema
  }
  const body: Record<string, unknown> = { contents, generationConfig }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools
  }
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
  // 第三方中转若地址不对，常返回 HTML 页面（200）。提前识别，给出可读报错。
  const text = await res.text()
  const looksLikeHtml = text.trimStart().startsWith("<")
  if (looksLikeHtml) {
    throw new Error(
      `端点返回了 HTML 而非 JSON，说明 GEMINI_BASE_URL 路径不对（当前实际请求：${BASE}/models/${GEMINI_MODEL}）。` +
        `请确认中转地址正确，通常应形如 https://域名/v1beta。返回片段：${text.slice(0, 120)}`,
    )
  }
  let json: {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
  }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`端点返回了无法解析的内容：${text.slice(0, 200)}`)
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

// 多轮对话（非流式）——直接走 generateContent，对第三方中转兼容性最好。
// 返回完整回答文本（已过滤 thought 摘要）。
export async function geminiContents(
  contents: Array<{ role: string; parts: GenPart[] }>,
  opts: GenOpts = {},
): Promise<string> {
  const body = buildBody(contents, opts)
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

// 把一段完整文本按字符切片写入流，模拟打字机效果（非流式降级路径用）。
function sliceToStream(full: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const STEP = 2
  let i = 0
  const chars = Array.from(full)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chars.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chars.slice(i, i + STEP).join("")))
      i += STEP
      await new Promise((r) => setTimeout(r, 12))
    },
  })
}

// 对话输出：优先尝试真·SSE 流式（streamGenerateContent?alt=sse），
// 若中转不支持（请求失败 / 首块是 HTML / 整流无文本产出），自动降级为非流式 generateContent + 切片。
// 用环境变量 GEMINI_STREAM=false 可强制只走非流式。
export async function geminiStream(
  contents: Array<{ role: string; parts: GenPart[] }>,
  opts: GenOpts = {},
): Promise<ReadableStream<Uint8Array>> {
  const streamEnabled = (process.env.GEMINI_STREAM ?? "true").toLowerCase() !== "false"
  if (!streamEnabled) {
    console.log("[v0] GEMINI_STREAM=false，直接走非流式")
    return sliceToStream(await geminiContents(contents, opts))
  }

  const body = buildBody(contents, opts)
  let res: Response
  try {
    res = await fetch(`${BASE}/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": getApiKey() },
      body: JSON.stringify(body),
    })
  } catch (e) {
    console.log("[v0] 流式请求异常，降级非流式:", (e as Error).message)
    return sliceToStream(await geminiContents(contents, opts))
  }

  if (!res.ok || !res.body) {
    console.log(`[v0] 流式响应不可用 (status=${res.status})，降级非流式`)
    return sliceToStream(await geminiContents(contents, opts))
  }

  // 预读首块，判断是否为合法 SSE。若是 HTML 或非 data: 帧，则降级。
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const first = await reader.read()
  const firstText = first.value ? decoder.decode(first.value, { stream: true }) : ""
  if (firstText.trimStart().startsWith("<") || !firstText.includes("data:")) {
    console.log("[v0] 首块非 SSE 格式，降级非流式。片段:", JSON.stringify(firstText.slice(0, 120)))
    reader.cancel().catch(() => {})
    return sliceToStream(await geminiContents(contents, opts))
  }

  console.log("[v0] 走真·SSE 流式")
  const encoder = new TextEncoder()
  let buffer = firstText
  let emitted = false

  function drain(controller: ReadableStreamDefaultController<Uint8Array>) {
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith("data:")) continue
      const data = t.slice(5).trim()
      if (!data || data === "[DONE]") continue
      try {
        const chunk = JSON.parse(data) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
        }
        for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (!p.thought && typeof p.text === "string" && p.text) {
            emitted = true
            controller.enqueue(encoder.encode(p.text))
          }
        }
      } catch {
        // 跳过不完整片段
      }
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // 先冲掉首块里已就绪的内容
      if (buffer.includes("\n")) drain(controller)
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) drain(controller)
        if (!emitted) console.log("[v0] 流结束但无文本产出")
        controller.close()
        return
      }
      buffer += decoder.decode(value, { stream: true })
      drain(controller)
    },
    cancel() {
      reader.cancel().catch(() => {})
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
