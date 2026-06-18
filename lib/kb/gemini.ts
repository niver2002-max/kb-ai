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
import { getSettings } from "./settings"

// 端点规整：Gemini 原生协议要求带版本路径。若只填了域名（无 /v1beta 或 /v1），自动补 /v1beta，
// 否则请求会打到中转站点的网页路由，返回 HTML 而非 JSON。
export function normalizeBase(raw: string): string {
  let b = raw.trim().replace(/\/+$/, "") // 去掉末尾斜杠
  if (!/\/v1beta$|\/v1$|\/v1beta\/|\/v1\//.test(b)) {
    b = `${b}/v1beta`
  }
  return b
}

// 以下配置全部运行时从设置面板（.kb-data/settings.json）动态读取，回退环境变量。
function BASE_URL(): string {
  return normalizeBase(getSettings().baseUrl)
}
function MODEL(): string {
  return getSettings().model
}
function EMBED_MODEL(): string {
  return getSettings().embedModel
}
function temperature(): number {
  return getSettings().temperature
}

// thinkingLevel：minimal | low | medium(默认) | high。
// "adaptive" = 不固定档位，交给 Gemini 原生的「动态思考(dynamic thinking)」按问题复杂度自动调节，
// 这同时就是「自适应 thinking」与「自适应 effort」——Gemini 没有独立的 effort 参数，
// 自适应深度由动态思考统一承担。
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "adaptive"

function getApiKey(): string {
  const key = getSettings().apiKey
  if (!key) {
    throw new Error(
      "尚未配置 API Key。请点击右上角「设置」配置并测试你的第三方 API，或在 .env.local 设置 GEMINI_API_KEY。",
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
  const generationConfig: Record<string, unknown> = { temperature: temperature() }
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
  // 带指数退避重试：第三方中转常出现瞬时 503/过载（system_cpu_overloaded），重试可显著提升成功率。
  const res = await fetchWithRetry(
    `${BASE_URL()}/models/${MODEL()}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getApiKey(),
      },
      body: JSON.stringify(body),
    },
    "Gemini generateContent",
  )
  // 第三方中转若地址不对，常返回 HTML 页面（200）。提前识别，给出可读报错。
  const text = await res.text()
  const looksLikeHtml = text.trimStart().startsWith("<")
  if (looksLikeHtml) {
    throw new Error(
      `端点返回了 HTML 而非 JSON，说明端点地址不对（当前实际请求：${BASE_URL()}/models/${MODEL()}）。` +
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

// 原生 PDF 文档理解：把整份 PDF 以 application/pdf inlineData 直接发给模型。
// Gemini 原生会同时理解文字、图形、表格，并保留跨页上下文——这是处理
// 引脚手册/数据手册/原理图类 PDF 的正确方式（非流式，带 adaptive 动态思考）。
// inline 方式适用于 <20MB 的文件；更大的需走 Files API（后续增强）。
export async function geminiPdf(
  base64: string,
  instruction: string,
  opts: GenOpts = {},
): Promise<string> {
  const body = buildBody(
    [
      {
        role: "user",
        parts: [
          { text: instruction },
          { inlineData: { mimeType: "application/pdf", data: base64 } },
        ],
      },
    ],
    { thinking: "adaptive", ...opts },
  )
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

// 原生网页理解：用 Gemini 的 url_context 工具，让模型自己抓取并读懂网页内容
// （能处理 JS 渲染、自动剔除导航/广告），再按 instruction 输出。比手写 fetch+stripHtml 准确得多。
export async function geminiUrlContext(
  url: string,
  instruction: string,
  opts: GenOpts = {},
): Promise<string> {
  const body = buildBody(
    [{ role: "user", parts: [{ text: `${instruction}\n\n网址：${url}` }] }],
    { thinking: "adaptive", ...opts, tools: [{ url_context: {} }] },
  )
  return callGenerate(body)
}

// 原生联网检索：用 Gemini 的 google_search 工具做实时检索（grounding），
// 用于在本地资料不足时由 AI 自适应补全外部信息。
export async function geminiSearch(
  query: string,
  opts: GenOpts = {},
): Promise<string> {
  const body = buildBody(
    [{ role: "user", parts: [{ text: query }] }],
    { thinking: "adaptive", ...opts, tools: [{ google_search: {} }] },
  )
  return callGenerate(body)
}

// 从可能含代码围栏/多余文字的文本中提取出 JSON 并解析。
// 第三方中转对 responseSchema 的支持参差不齐，返回的内容常被包在 ```json``` 里
// 或前后带说明文字，因此不能直接 JSON.parse。
function extractJson<T>(raw: string): T {
  const text = raw.trim()
  // 1) 直接尝试
  try {
    return JSON.parse(text) as T
  } catch {
    // 继续
  }
  // 2) 去掉 markdown 代码围栏 ```json ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as T
    } catch {
      // 继续
    }
  }
  // 3) 截取第一个 { 或 [ 到与之匹配的最后一个 } 或 ]
  const firstObj = text.indexOf("{")
  const firstArr = text.indexOf("[")
  let start = -1
  let open = "{"
  let close = "}"
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr
    open = "["
    close = "]"
  } else if (firstObj !== -1) {
    start = firstObj
  }
  if (start !== -1) {
    const end = text.lastIndexOf(close)
    if (end > start) {
      const slice = text.slice(start, end + 1)
      try {
        return JSON.parse(slice) as T
      } catch {
        // 继续
      }
    }
  }
  throw new Error(`模型未返回合法 JSON。原始片段：${text.slice(0, 200)}`)
}

// 结构化 JSON 生成（带 schema），自动解析为对象。
// 很多第三方中转并不支持 responseSchema/responseMimeType，会忽略它并返回普通散文。
// 因此这里双保险：1) 仍传 responseSchema（官方端点/兼容中转可直接生效）；
// 2) 把 schema 作为强约束写进提示词，要求模型“只输出纯 JSON”；3) extractJson 容错解析。
export async function geminiJson<T>(
  prompt: string,
  responseSchema: Record<string, unknown>,
  opts: GenOpts = {},
): Promise<T> {
  const jsonInstruction =
    `\n\n【输出格式要求 - 必须严格遵守】\n` +
    `只输出一个合法的 JSON，且必须完全符合下面的 JSON Schema。\n` +
    `不要输出任何解释、前后缀、Markdown 代码围栏或多余文字，第一个字符必须是 { 或 [。\n` +
    `JSON Schema：\n${JSON.stringify(responseSchema)}`
  const raw = await geminiText(prompt + jsonInstruction, { ...opts, responseSchema })
  return extractJson<T>(raw)
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
  const streamEnabled = getSettings().stream
  if (!streamEnabled) {
    console.log("[v0] 流式已关闭，直接走非流式")
    return sliceToStream(await geminiContents(contents, opts))
  }

  const body = buildBody(contents, opts)
  let res: Response
  try {
    res = await fetch(`${BASE_URL()}/models/${MODEL()}:streamGenerateContent?alt=sse`, {
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

// 带指数退避的重试：对 429/5xx 等瞬时错误重试，最多 attempts 次。
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  attempts = 4,
): Promise<Response> {
  let lastErr = ""
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init)
      if (res.ok) return res
      // 仅对可重试状态码退避重试；其它直接抛
      if (![408, 429, 500, 502, 503, 504].includes(res.status)) {
        const detail = await res.text().catch(() => "")
        throw new Error(`${label} 失败 (${res.status}): ${detail.slice(0, 300)}`)
      }
      lastErr = `${label} 临时错误 (${res.status})`
    } catch (e) {
      lastErr = (e as Error).message
      // 非 HTTP 异常（网络等）也重试
    }
    if (i < attempts - 1) {
      const delay = 500 * Math.pow(2, i) + Math.random() * 300
      console.log(`[v0] ${label} 第 ${i + 1} 次失败，${Math.round(delay)}ms 后重试：${lastErr}`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error(`${label} 多次重试后仍失败：${lastErr}`)
}

// 单条文本向量
export async function geminiEmbedOne(
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_QUERY",
): Promise<number[]> {
  const embedModel = EMBED_MODEL()
  const res = await fetchWithRetry(
    `${BASE_URL()}/models/${embedModel}:embedContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getApiKey(),
      },
      body: JSON.stringify({
        model: `models/${embedModel}`,
        content: { parts: [{ text }] },
        taskType,
      }),
    },
    "Gemini embedContent",
  )
  const json = (await res.json()) as { embedding?: { values?: number[] } }
  return json.embedding?.values ?? []
}

// 批量文本向量（自动分批，单批上限 100 条）。
// 带重试；若某批 batchEmbedContents 始终失败（部分第三方中转不支持批量接口或不稳定），
// 自动降级为逐条 embedContent，确保内容不丢失。
export async function geminiEmbedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  const BATCH = 100
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    try {
      const embedModel = EMBED_MODEL()
      const res = await fetchWithRetry(
        `${BASE_URL()}/models/${embedModel}:batchEmbedContents`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": getApiKey(),
          },
          body: JSON.stringify({
            requests: slice.map((text) => ({
              model: `models/${embedModel}`,
              content: { parts: [{ text }] },
              taskType: "RETRIEVAL_DOCUMENT",
            })),
          }),
        },
        "Gemini batchEmbedContents",
        3,
      )
      const json = (await res.json()) as { embeddings?: Array<{ values?: number[] }> }
      const vecs = json.embeddings ?? []
      // 批量返回数量异常时也降级逐条
      if (vecs.length !== slice.length) throw new Error("批量返回数量不匹配")
      for (const e of vecs) out.push(e.values ?? [])
    } catch (e) {
      console.log(`[v0] 批量嵌入失败，降级为逐条：${(e as Error).message}`)
      for (const text of slice) {
        const v = await geminiEmbedOne(text, "RETRIEVAL_DOCUMENT")
        out.push(v)
      }
    }
  }
  return out
}
