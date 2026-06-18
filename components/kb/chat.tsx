"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Markdown } from "@/components/kb/markdown"
import { SendHorizontal, Sparkles } from "lucide-react"

interface ChatTurn {
  id: string
  role: "user" | "assistant"
  content: string
}

export function Chat({ chunkCount }: { chunkCount: number }) {
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<ChatTurn[]>([])
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || busy) return

    const userTurn: ChatTurn = { id: crypto.randomUUID(), role: "user", content: text }
    const assistantId = crypto.randomUUID()
    const history = [...messages, userTurn]
    setMessages([...history, { id: assistantId, role: "assistant", content: "" }])
    setInput("")
    setBusy(true)
    scrollToBottom()

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      })
      if (!res.ok || !res.body) {
        throw new Error(await res.text().catch(() => "请求失败"))
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let acc = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        acc += decoder.decode(value, { stream: true })
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: acc } : m)),
        )
        scrollToBottom()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "出错了"
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: `⚠️ ${msg}` } : m,
        ),
      )
    } finally {
      setBusy(false)
      scrollToBottom()
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-1 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <Sparkles className="size-8" />
            <div className="max-w-sm text-sm leading-relaxed">
              {chunkCount > 0
                ? "知识库已就绪，向它提问吧。回答会标注来源编号，便于溯源。"
                : "知识库还没有内容。请先在「来源与构建」里扫描目录并构建知识库。"}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.role === "user" ? "flex justify-end" : "flex justify-start"
                }
              >
                <div
                  className={
                    "max-w-[85%] rounded-lg px-4 py-2.5 text-sm leading-relaxed " +
                    (m.role === "user"
                      ? "whitespace-pre-wrap bg-foreground text-background"
                      : "bg-muted text-foreground")
                  }
                >
                  {m.role === "assistant" ? (
                    m.content ? (
                      <Markdown>{m.content}</Markdown>
                    ) : busy ? (
                      "思考中…"
                    ) : (
                      ""
                    )
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={submit}
        className="mx-auto flex w-full max-w-2xl items-center gap-2 border-t pt-4"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="向知识库提问…"
          disabled={busy}
          aria-label="提问输入框"
        />
        <Button type="submit" disabled={busy || !input.trim()} size="icon">
          <SendHorizontal className="size-4" />
          <span className="sr-only">发送</span>
        </Button>
      </form>
    </div>
  )
}
