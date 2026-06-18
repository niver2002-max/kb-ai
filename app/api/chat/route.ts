import { readIndex } from "@/lib/kb/store"
import { searchChunks } from "@/lib/kb/embed"
import { geminiStream } from "@/lib/kb/gemini"

// Node 运行时（需要文件系统访问），不可用 edge
export const runtime = "nodejs"
export const maxDuration = 60

interface ChatTurn {
  role: "user" | "assistant"
  content: string
}

export async function POST(req: Request) {
  const { messages }: { messages: ChatTurn[] } = await req.json()
  const query = [...messages].reverse().find((m) => m.role === "user")?.content ?? ""

  const index = await readIndex()
  // topK=8：BM25+MMR 已做多样性去重，更多上下文有助于复杂问题的推理质量
  const hits = query ? await searchChunks(query, index.chunks, 8) : []

  // 组装带来源编号的上下文，便于模型引用
  const sourceById = new Map(index.sources.map((s) => [s.id, s]))
  const context = hits
    .map((h, i) => {
      const src = sourceById.get(h.chunk.sourceId)
      const label = src ? src.name : h.chunk.sourceId
      const loc = h.chunk.loc ? `，${h.chunk.loc}` : ""
      return `【来源 ${i + 1}：${label}${loc}】\n${h.chunk.text}`
    })
    .join("\n\n---\n\n")

  // 是否允许联网补全（默认开启）。可用 GEMINI_WEB_GROUNDING=false 关闭。
  const webGrounding =
    (process.env.GEMINI_WEB_GROUNDING ?? "true").toLowerCase() !== "false"

  const system =
    "你是一个本地知识库问答助手。回答优先严格依据下面的【知识库片段】，" +
    "引用具体内容时标注来源编号（如 [来源 1]）。" +
    (webGrounding
      ? "当知识库不足以回答时，可使用联网检索(Google 搜索)自适应补全外部信息，" +
        "并明确标注「（联网补全）」以区分本地资料。"
      : "如果知识库中没有相关信息，请如实说明，不要编造。") +
    "用中文回答。\n\n" +
    (context
      ? `知识库片段：\n${context}`
      : "（当前没有检索到相关知识库片段。" +
        (webGrounding ? "可通过联网检索回答，并标注「（联网补全）」。）" : "请提示用户先构建知识库或换个问法。）"))

  // 转成 Gemini contents 格式（assistant → model）
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }))

  // adaptive 思考 + 原生联网检索（grounding），由模型按需自适应补全
  let stream: ReadableStream<Uint8Array>
  try {
    stream = await geminiStream(contents, {
      system,
      thinking: "adaptive",
      ...(webGrounding ? { tools: [{ google_search: {} }] } : {}),
    })
  } catch (err) {
    // 重试后仍失败（如中转持续过载）：返回可读提示，避免前端收到不可读的 500 页面。
    const raw = err instanceof Error ? err.message : String(err)
    const friendly = /overload|503|cpu/i.test(raw)
      ? "⚠️ 上游模型端点当前过载（已自动重试多次），请稍候片刻再发送。"
      : `⚠️ 生成失败：${raw}`
    return new Response(friendly, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
    })
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  })
}
