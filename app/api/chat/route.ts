import { geminiStream } from "@/lib/kb/gemini"
import {
  readSession,
  appendMessage,
  compressIfNeeded,
  buildContextMessages,
  retrieveContext,
} from "@/lib/kb/session"
import { getInspection } from "@/lib/kb/inspection"

// Node 运行时（需要文件系统访问），不可用 edge
export const runtime = "nodejs"
export const maxDuration = 60

interface ChatBody {
  libId: string
  message: string
  scope?: { type: "category" | "source"; id: string; label: string } | null
}

export async function POST(req: Request) {
  const { libId, message, scope }: ChatBody = await req.json()

  if (!libId || !message) {
    return new Response("缺少 libId 或 message", { status: 400 })
  }

  // 0) 巡检态拦截：巡检进行中（且未完成）时对话框应已置灰，这里再做服务端兜底。
  const insp = await getInspection(libId)
  if (insp.active && !insp.done) {
    return new Response("知识库正在巡检中，请先结束巡检再对话。", { status: 409 })
  }

  // 1) 持久化用户消息
  await appendMessage(libId, { role: "user", content: message, scope: scope ?? null })

  // 2) 必要时滚动压缩历史
  await compressIfNeeded(libId)
  const session = await readSession(libId)

  // 3) scope-aware RAG 检索（混合检索流水线，传入近期历史帮助解析指代）
  const recentHistory = session.messages
    .filter((m) => m.role !== "system")
    .slice(-5, -1)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.slice(0, 200)}`)
    .join("\n")
  const { context, citations } = await retrieveContext(libId, message, scope ?? null, 8, {
    history: recentHistory,
  })

  // 4) 组装上下文消息：[摘要] + 最近若干轮原文（已含刚写入的用户消息）
  const history = buildContextMessages(session)

  const webGrounding =
    (process.env.GEMINI_WEB_GROUNDING ?? "true").toLowerCase() !== "false"

  const scopeNote = scope
    ? `\n\n注意：用户已将提问范围限定在「${scope.label}」，请优先围绕该范围作答。`
    : ""

  const system =
    "你是一个本地知识库问答助手。回答优先严格依据下面的【知识库片段】，" +
    "引用具体内容时标注来源编号（如 [来源 1]）。" +
    (webGrounding
      ? "当知识库不足以回答时，可使用联网检索(Google 搜索)自适应补全外部信息，" +
        "并明确标注「（联网补全）」以区分本地资料。"
      : "如果知识库中没有相关信息，请如实说明，不要编造。") +
    "用中文回答。" +
    scopeNote +
    "\n\n" +
    (context
      ? `知识库片段：\n${context}`
      : "（当前没有检索到相关知识库片段。" +
        (webGrounding
          ? "可通过联网检索回答，并标注「（联网补全）」。）"
          : "请提示用户先构建知识库或换个问法。）"))

  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }))

  let stream: ReadableStream<Uint8Array>
  try {
    stream = await geminiStream(contents, {
      system,
      thinking: "adaptive",
      ...(webGrounding ? { tools: [{ google_search: {} }] } : {}),
    })
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const friendly = /overload|503|cpu/i.test(raw)
      ? "⚠️ 上游模型端点当前过载（已自动重试多次），请稍候片刻再发送。"
      : `⚠️ 生成失败：${raw}`
    // 失败也要落一条助手消息，保持历史一致
    await appendMessage(libId, { role: "assistant", content: friendly })
    return new Response(friendly, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
    })
  }

  // 5) 边转发边累积完整回答，在流的 flush（响应生命周期内）持久化助手消息（含引用）。
  // 用 TransformStream 而非 fire-and-forget：确保在 sandbox/serverless 上写盘随流完成，不被提前销毁。
  const decoder = new TextDecoder()
  let full = ""
  const persistTransform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      full += decoder.decode(chunk, { stream: true })
      controller.enqueue(chunk)
    },
    async flush() {
      if (full.trim()) {
        await appendMessage(libId, {
          role: "assistant",
          content: full,
          citations,
          scope: scope ?? null,
        })
      }
    },
  })

  return new Response(stream.pipeThrough(persistTransform), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      // 把本轮引用通过响应头传给前端做溯源标注
      "X-KB-Citations": encodeURIComponent(JSON.stringify(citations.slice(0, 8))),
    },
  })
}
