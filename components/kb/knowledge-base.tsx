"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import {
  scanDir,
  addWebSources,
  screenSources,
  buildKb,
  removeSource,
  resetKb,
} from "@/app/actions"
import type { KbSource } from "@/lib/kb/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { Chat } from "@/components/kb/chat"
import { CATEGORY_LABEL, STATUS_LABEL, STATUS_CLASS, formatSize } from "@/lib/kb/labels"
import {
  FolderSearch,
  Globe,
  ListFilter,
  Database,
  Trash2,
  RotateCcw,
  Files,
  Layers,
  Loader2,
} from "lucide-react"

export interface KbState {
  rootDir: string | null
  updatedAt: number
  sources: KbSource[]
  chunkCount: number
}

export function KnowledgeBase({ initial }: { initial: KbState }) {
  const [state, setState] = useState<KbState>(initial)
  const [dir, setDir] = useState(initial.rootDir ?? "")
  const [urls, setUrls] = useState("")
  const [prompt, setPrompt] = useState("")
  const [minRelevance, setMinRelevance] = useState(0)
  const [pending, startTransition] = useTransition()
  const [activeAction, setActiveAction] = useState<string | null>(null)

  function run(action: string, fn: () => Promise<KbState | (KbState & { processed?: number; failed?: number })>, okMsg?: string) {
    setActiveAction(action)
    startTransition(async () => {
      try {
        const next = await fn()
        setState(next)
        if (okMsg) toast.success(okMsg)
        if ("processed" in next) {
          toast.success(`构建完成：成功 ${next.processed} 个，失败 ${next.failed} 个`)
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "操作失败")
      } finally {
        setActiveAction(null)
      }
    })
  }

  const embeddedCount = state.sources.filter((s) => s.status === "embedded").length
  const totalSize = state.sources.reduce((n, s) => n + s.sizeBytes, 0)

  return (
    <div className="mx-auto flex min-h-svh max-w-5xl flex-col gap-6 px-4 py-8 md:px-6">
      {/* 头部 */}
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Database className="size-5" />
          <h1 className="text-balance text-xl font-semibold tracking-tight">
            本地知识库
          </h1>
          <Badge variant="secondary" className="ml-1 font-mono text-xs">
            AI 驱动 · 全本地
          </Badge>
        </div>
        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
          指定一个本地目录，AI 自动扫描、抓取指定网页、智能初筛、解析入库，最后进入对话问答。
          所有数据都保存在项目目录的 <code className="font-mono">.kb-data</code> 文件夹内，不经过任何云数据库。
        </p>
        <div className="flex flex-wrap gap-3">
          <Stat icon={<Files className="size-3.5" />} label="来源" value={state.sources.length} />
          <Stat icon={<Database className="size-3.5" />} label="已入库" value={embeddedCount} />
          <Stat icon={<Layers className="size-3.5" />} label="文本块" value={state.chunkCount} />
          <Stat label="总大小" value={formatSize(totalSize)} />
        </div>
      </header>

      <Tabs defaultValue="sources" className="flex-1">
        <TabsList>
          <TabsTrigger value="sources">来源与构建</TabsTrigger>
          <TabsTrigger value="chat">对话问答</TabsTrigger>
        </TabsList>

        {/* 来源与构建 */}
        <TabsContent value="sources" className="mt-4 flex flex-col gap-4">
          <Card className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="dir" className="flex items-center gap-1.5">
                <FolderSearch className="size-4" /> 本地目录路径
              </Label>
              <div className="flex gap-2">
                <Input
                  id="dir"
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder="例如 /Users/you/Documents/资料 或 D:\\资料"
                  className="font-mono text-sm"
                />
                <Button
                  onClick={() => run("scan", () => scanDir(dir), "扫描完成")}
                  disabled={pending || !dir.trim()}
                >
                  {activeAction === "scan" ? <Loader2 className="size-4 animate-spin" /> : "扫描"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                在本地运行时会读取你电脑上的真实目录；在线预览时读取的是运行环境内的目录。
              </p>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <Label htmlFor="urls" className="flex items-center gap-1.5">
                <Globe className="size-4" /> 网页链接（每行一个，自动抓取正文）
              </Label>
              <Textarea
                id="urls"
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                placeholder={"https://example.com/doc\nhttps://example.com/article"}
                className="min-h-20 font-mono text-sm"
              />
              <div>
                <Button
                  variant="secondary"
                  onClick={() => run("web", () => addWebSources(urls), "已添加网页来源")}
                  disabled={pending || !urls.trim()}
                >
                  {activeAction === "web" ? <Loader2 className="size-4 animate-spin" /> : "添加网页"}
                </Button>
              </div>
            </div>
          </Card>

          <Card className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="prompt" className="flex items-center gap-1.5">
                <ListFilter className="size-4" /> 知识库目标 / 筛选要求（用于 AI 初筛打分）
              </Label>
              <Textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="例如：整理某产品的硬件设计资料，重点是电源与通信模块相关文档"
                className="min-h-16 text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => run("screen", () => screenSources(prompt), "初筛完成")}
                  disabled={pending || state.sources.length === 0}
                >
                  {activeAction === "screen" ? <Loader2 className="size-4 animate-spin" /> : "AI 初筛"}
                </Button>
                <div className="flex items-center gap-2 text-sm">
                  <Label htmlFor="minrel" className="text-muted-foreground">
                    仅构建相关性 ≥
                  </Label>
                  <Input
                    id="minrel"
                    type="number"
                    min={0}
                    max={1}
                    step={0.1}
                    value={minRelevance}
                    onChange={(e) => setMinRelevance(Number(e.target.value))}
                    className="w-20"
                  />
                </div>
                <Button
                  onClick={() => run("build", () => buildKb({ minRelevance }))}
                  disabled={pending || state.sources.length === 0}
                >
                  {activeAction === "build" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> 构建中…
                    </>
                  ) : (
                    "解析并构建知识库"
                  )}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => run("reset", () => resetKb(), "已清空")}
                  disabled={pending}
                  className="text-muted-foreground"
                >
                  <RotateCcw className="size-4" /> 清空
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                构建会逐个解析来源：文本型直接抽取、图片/扫描件走视觉模型、大 PDF 按页处理并保留页码。
              </p>
            </div>
          </Card>

          <SourceList
            sources={state.sources}
            disabled={pending}
            onRemove={(id) => run("remove", () => removeSource(id))}
          />
        </TabsContent>

        {/* 对话 */}
        <TabsContent value="chat" className="mt-4">
          <Card className="h-[60svh] p-4">
            <Chat chunkCount={state.chunkCount} />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Stat({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode
  label: string
  value: string | number
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm">
      {icon}
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </div>
  )
}

function SourceList({
  sources,
  disabled,
  onRemove,
}: {
  sources: KbSource[]
  disabled: boolean
  onRemove: (id: string) => void
}) {
  if (sources.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        还没有任何来源。扫描一个本地目录，或添加网页链接开始。
      </Card>
    )
  }

  return (
    <Card className="divide-y p-0">
      {sources.map((s) => (
        <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
          <Badge variant="outline" className="shrink-0 text-xs">
            {CATEGORY_LABEL[s.category]}
          </Badge>
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm" title={s.location}>
              {s.name}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span>{formatSize(s.sizeBytes)}</span>
              {typeof s.relevance === "number" && (
                <span>· 相关性 {s.relevance.toFixed(1)}</span>
              )}
              {typeof s.chunkCount === "number" && <span>· {s.chunkCount} 块</span>}
              {s.note && <span className="truncate">· {s.note}</span>}
              {s.error && <span className="text-destructive">· {s.error}</span>}
            </div>
          </div>
          <Badge className={`shrink-0 text-xs ${STATUS_CLASS[s.status]}`}>
            {STATUS_LABEL[s.status]}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            disabled={disabled}
            onClick={() => onRemove(s.id)}
            aria-label={`移除 ${s.name}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </Card>
  )
}
