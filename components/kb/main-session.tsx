"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Markdown } from "@/components/kb/markdown"
import { SendHorizontal, Sparkles, X, AtSign, FileText } from "lucide-react"
import type { KbMessage } from "@/lib/kb/types"

export interface ChatScope {
  type: "category" | "source"
  id: string
  label: string
}

interface UiMessage {
  id: string
  role: "user" | "assistant"
  content: string
  citations?: KbMessage["citations"]
  scopeLabel?: string
}

export function MainSession({
  libId,
  initialMessages,
  chunkCount,
  scope,
  onClearScope,
}: {
  libId: string
  initialMessages: KbMessage[]
  chunkCount: number
  scope: ChatScope | null
  onClearScope: () => void
}) {
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<UiMessage[]>(
    initialMessages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        citations: m.citations,
        scopeLabel: m.scope?.label,
      })),
  )
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  useEffect(() => {
    scrollToBottom()
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || busy) return

    const userMsg: UiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      scopeLabel: scope?.label,
    }
    const assistantId = crypto.randomUUID()
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", content: "" },
    ])
    setInput("")
    setBusy(true)
    scrollToBottom()

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libId, message: text, scope }),
      })
      if (!res.ok || !res.body) {
        throw new Error(await res.text().catch(() => "请求失败"))
      }
      // 解析本轮引用（响应头）
      let citations: KbMessage["citations"] = []
      const rawCite = res.headers.get("X-KB-Citations")
      if (rawCite) {
        try {
          citations = JSON.parse(decodeURIComponent(rawCite))
        } catch {
          citations = []
        }
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
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, citations } : m)),
      )
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
                ? "这是贯穿整个知识库的持久对话，重启后自动恢复。直接提问，或用左侧知识树 @ 某个层级聚焦提问。"
                : "知识库还没有内容。点右上角加号导入资料，或直接告诉我你想建什么——我可以联网帮你搜集。"}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {messages.map((m) => (
              <div
                key={m.id}
                className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
              >
                <div className="flex max-w-[85%] flex-col gap-1">
                  {m.scopeLabel && (
                    <div
                      className={`flex items-center gap-1 text-xs text-muted-foreground ${
                        m.role === "user" ? "justify-end" : "justify-start"
                      }`}
                    >
                      <AtSign className="size-3" />
                      {m.scopeLabel}
                    </div>
                  )}
                  <div
                    className={
                      "rounded-lg px-4 py-2.5 text-sm leading-relaxed " +
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
                  {m.role === "assistant" && m.citations && m.citations.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {m.citations.map((c, i) => (
                        <Badge
                          key={`${m.id}-cite-${i}`}
                          variant="secondary"
                          className="gap-1 font-normal"
                        >
                          <FileText className="size-3" />
                          {c.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-2xl border-t pt-3">
        {scope && (
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="outline" className="gap-1">
              <AtSign className="size-3" />
              聚焦：{scope.label}
            </Badge>
            <button
              type="button"
              onClick={onClearScope}
              className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
              取消聚焦
            </button>
          </div>
        )}
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={scope ? `在「${scope.label}」范围内提问…` : "向知识库提问…"}
            disabled={busy}
            aria-label="提问输入框"
          />
          <Button type="submit" disabled={busy || !input.trim()} size="icon">
            <SendHorizontal className="size-4" />
            <span className="sr-only">发送</span>
          </Button>
        </form>
      </div>
    </div>
  )
}
