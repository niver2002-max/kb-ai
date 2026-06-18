"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Markdown } from "@/components/kb/markdown"
import { SendHorizontal, Sparkles, X, AtSign, FileText, Square, Paperclip, Upload, Loader2 } from "lucide-react"
import { ingestUploadedFiles, type DroppedFile } from "@/app/actions"
import type { KbState } from "@/components/kb/knowledge-base"
import { toast } from "sonner"
import type { KbMessage } from "@/lib/kb/types"

// 读取浏览器 File 为 base64（不含 data: 前缀）
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const res = reader.result as string
      const comma = res.indexOf(",")
      resolve(comma >= 0 ? res.slice(comma + 1) : res)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// 递归读取拖入的目录条目（webkitGetAsEntry），收集所有文件及其相对路径
async function readEntry(entry: any, prefix: string, out: File[], relPaths: Map<File, string>) {
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej))
    relPaths.set(file, prefix + entry.name)
    out.push(file)
  } else if (entry.isDirectory) {
    const reader = entry.createReader()
    // readEntries 需循环读直到返回空
    const readAll = (): Promise<any[]> =>
      new Promise((res, rej) => reader.readEntries(res, rej))
    let batch = await readAll()
    while (batch.length > 0) {
      for (const e of batch) await readEntry(e, prefix + entry.name + "/", out, relPaths)
      batch = await readAll()
    }
  }
}

// 从 DataTransfer 收集所有文件（支持目录递归），返回 {file, relPath}[]
async function collectDropped(dt: DataTransfer): Promise<Array<{ file: File; relPath: string }>> {
  const relPaths = new Map<File, string>()
  const files: File[] = []
  const items = Array.from(dt.items || [])
  const entries = items
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean)

  if (entries.length > 0) {
    for (const entry of entries) await readEntry(entry, "", files, relPaths)
  } else {
    // 回退：直接用 files 列表（无目录结构）
    for (const f of Array.from(dt.files || [])) {
      relPaths.set(f, f.name)
      files.push(f)
    }
  }
  return files.map((f) => ({ file: f, relPath: relPaths.get(f) || f.name }))
}

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
  inspecting = false,
  onBusyChange,
  onStateChange,
}: {
  libId: string
  initialMessages: KbMessage[]
  chunkCount: number
  scope: ChatScope | null
  onClearScope: () => void
  // 巡检进行中：整个对话框置灰、禁用收发
  inspecting?: boolean
  // 上报对话是否正在生成（用于禁用「开启巡检」）
  onBusyChange?: (busy: boolean) => void
  // 拖拽导入后回传最新知识库状态（用于刷新知识树）
  onStateChange?: (s: KbState) => void
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
  // 拖拽导入：覆盖层显隐、上传进度、已附带文件（@xxx 引用）
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState("")
  const [attachments, setAttachments] = useState<string[]>([])
  const dragDepth = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 用于「停止」按钮中断当前生成
  const abortRef = useRef<AbortController | null>(null)

  // 把收集到的文件上传入库，并在输入框插入 @文件名 引用
  async function uploadFiles(picked: Array<{ file: File; relPath: string }>) {
    if (picked.length === 0 || inspecting) return
    // 限制单次体积，避免一次性塞入超大目录
    const MAX_TOTAL = 80 * 1024 * 1024
    let total = 0
    for (const p of picked) total += p.file.size
    if (total > MAX_TOTAL) {
      toast.error("单次拖入内容过大（>80MB），请分批拖入或用「导入材料」选目录")
      return
    }
    setUploading(`读取 ${picked.length} 个文件…`)
    try {
      const payload: DroppedFile[] = []
      for (const { file, relPath } of picked) {
        payload.push({ relPath, dataBase64: await fileToBase64(file) })
      }
      setUploading(`解析并入库 ${payload.length} 个文件…`)
      const { imported, failed, state } = await ingestUploadedFiles(libId, payload)
      onStateChange?.(state)
      if (imported.length > 0) {
        // 在输入框插入 @文件名 引用；并记录为附带项展示
        const mentions = imported.map((n) => `@${n}`)
        setAttachments((prev) => Array.from(new Set([...prev, ...imported])))
        setInput((prev) => (prev ? prev.trimEnd() + " " : "") + mentions.join(" ") + " ")
        textareaRef.current?.focus()
        toast.success(`已导入 ${imported.length} 个文件到知识库`)
      }
      if (failed.length > 0) toast.error(`${failed.length} 个文件导入失败`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导入失败")
    } finally {
      setUploading("")
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    if (inspecting || uploading) return
    const picked = await collectDropped(e.dataTransfer)
    await uploadFiles(picked)
  }

  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = "" // 允许重复选择同一文件
    await uploadFiles(files.map((f) => ({ file: f, relPath: f.name })))
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  useEffect(() => {
    scrollToBottom()
  }, [])

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  // 停止当前生成：中断请求，已生成的部分内容保留
  function stop() {
    abortRef.current?.abort()
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || busy || inspecting) return

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

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libId, message: text, scope }),
        signal: controller.signal,
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
      // 用户主动停止：保留已生成内容，不显示报错
      if (err instanceof DOMException && err.name === "AbortError") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId && !m.content
              ? { ...m, content: "（已停止）" }
              : m,
          ),
        )
      } else {
        const msg = err instanceof Error ? err.message : "出错了"
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: `⚠️ ${msg}` } : m,
          ),
        )
      }
    } finally {
      abortRef.current = null
      setBusy(false)
      scrollToBottom()
    }
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={(e) => {
        if (inspecting) return
        // 仅当拖入的是文件时才显示覆盖层
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault()
          dragDepth.current++
          setDragOver(true)
        }
      }}
      onDragOver={(e) => {
        if (dragOver) e.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {/* 拖拽覆盖层：拖文件/目录进来即可导入 */}
      {dragOver && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-primary bg-background/90 backdrop-blur-sm">
          <Upload className="size-10 text-primary" />
          <div className="text-center text-sm">
            <p className="font-medium">松开即可导入到知识库</p>
            <p className="text-muted-foreground">支持任意文件与整个文件夹，导入后会变成 @ 引用</p>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className={
          "flex-1 overflow-y-auto px-1 py-4 transition-opacity " +
          (inspecting ? "pointer-events-none opacity-50" : "")
        }
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <Sparkles className="size-8" />
            <div className="max-w-sm text-sm leading-relaxed">
              {chunkCount > 0
                ? "这是贯穿整个知识库的持久对话，重启后自动恢复。直接提问，用左侧知识树 @ 某层级聚焦，或把文件/文件夹拖进来导入。"
                : "知识库还没有内容。把文件或文件夹直接拖进来导入，点右上角加号，或直接告诉我你想建什么——我可以联网帮你搜集。"}
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

      <div className="mx-auto w-full max-w-2xl px-1 pb-5 pt-2">
        {/* 聚焦范围 */}
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

        {/* 已附带的拖入文件（@ 引用） */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {attachments.map((name) => (
              <Badge key={name} variant="secondary" className="gap-1 font-normal">
                <AtSign className="size-3" />
                {name}
                <button
                  type="button"
                  aria-label={`移除 ${name}`}
                  onClick={() => {
                    setAttachments((prev) => prev.filter((n) => n !== name))
                    setInput((prev) => prev.replace(`@${name}`, "").replace(/\s{2,}/g, " ").trim())
                  }}
                  className="ml-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        {/* 输入区：放大为多行，可拖文件/点附件导入 */}
        <form
          onSubmit={submit}
          className="flex flex-col gap-2 rounded-xl border bg-card p-2.5 shadow-sm focus-within:ring-1 focus-within:ring-ring"
        >
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter 发送，Shift+Enter 换行
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit(e as unknown as React.FormEvent)
              }
            }}
            placeholder={
              inspecting
                ? "巡检进行中，对话已暂停…"
                : scope
                  ? `在「${scope.label}」范围内提问…（可拖入文件/文件夹导入）`
                  : "向知识库提问，或把文件、文件夹拖进来导入…"
            }
            disabled={inspecting}
            aria-label="提问输入框"
            rows={3}
            className="min-h-20 resize-none border-0 bg-transparent px-1.5 py-1 shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              disabled={inspecting || !!uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
              {uploading || "添加文件"}
            </Button>
            {busy ? (
              <Button type="button" onClick={stop} size="icon" variant="secondary" aria-label="停止生成">
                <Square className="size-3.5 fill-current" />
                <span className="sr-only">停止</span>
              </Button>
            ) : (
              <Button type="submit" disabled={inspecting || !input.trim()} size="icon" aria-label="发送">
                <SendHorizontal className="size-4" />
                <span className="sr-only">发送</span>
              </Button>
            )}
          </div>
        </form>
        <p className="mt-1.5 px-1 text-center text-[11px] text-muted-foreground">
          Enter 发送 · Shift+Enter 换行 · 可把任意文件或文件夹拖进来导入
        </p>

        {/* 隐藏的多选文件输入（系统原生文件选择） */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={onPickFiles}
        />
      </div>
    </div>
  )
}
