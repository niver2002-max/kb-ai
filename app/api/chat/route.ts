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
  const hits = query ? await searchChunks(query, index.chunks, 6) : []

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

  const system =
    "你是一个本地知识库问答助手。请严格依据下面提供的【知识库片段】回答用户问题，" +
    "并在引用具体内容时标注来源编号（如 [来源 1]）。" +
    "如果知识库中没有相关信息，请如实说明，不要编造。用中文回答。\n\n" +
    (context
      ? `知识库片段：\n${context}`
      : "（当前没有检索到相关知识库片段，请提示用户先构建知识库或换个问法。）")

  // 转成 Gemini contents 格式（assistant → model）
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }))

  // adaptive 思考：交给 Gemini 动态思考按问题复杂度自动调节深度
  const stream = await geminiStream(contents, { system, thinking: "adaptive" })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  })
}
