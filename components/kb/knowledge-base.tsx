"use client"

import { useState, useTransition, useRef, useEffect, useCallback } from "react"
import type { KbSource, KbWorkflow, KbLibrary, KbMessage } from "@/lib/kb/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Onboarding } from "@/components/kb/onboarding"
import { Workspace } from "@/components/kb/workspace"
import { getKbState, getSession, getLibraries, deleteKbLibrary, tickAutoIterate } from "@/app/actions"
import { ApiSettingsDialog } from "@/components/kb/api-settings"
import { toast } from "sonner"
import { Database, Plus, Trash2, Loader2, FolderTree, Globe, BookOpen, ArrowRight, ChevronLeft, ChevronRight, Clock } from "lucide-react"

// 单库的运行态快照（客户端组件共享）
export interface KbState {
  libId: string
  rootDir: string | null
  updatedAt: number
  sources: KbSource[]
  chunkCount: number
  workflow: KbWorkflow
}

type View =
  | { kind: "list" }
  | { kind: "onboarding" }
  | { kind: "workspace"; library: KbLibrary; state: KbState; messages: KbMessage[] }

const MODE_META: Record<KbLibrary["sourceMode"], { label: string; icon: typeof BookOpen }> = {
  materials: { label: "本地资料", icon: FolderTree },
  web: { label: "联网建库", icon: Globe },
  mixed: { label: "混合来源", icon: BookOpen },
}

// 相对时间（更新先后）
function relTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return "刚刚"
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ts).toLocaleDateString()
}

export function KnowledgeBase({ initialLibraries }: { initialLibraries: KbLibrary[] }) {
  const [libraries, setLibraries] = useState<KbLibrary[]>(initialLibraries)
  const [view, setView] = useState<View>({ kind: "list" })
  const [pending, startTransition] = useTransition()
  const [enteringId, setEnteringId] = useState<string | null>(null)

  // 横向滚动：左右箭头 + 边缘可滚动判定
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const updateArrows = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    setCanLeft(el.scrollLeft > 4)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
  }, [])

  useEffect(() => {
    updateArrows()
    const el = scrollerRef.current
    if (!el) return
    el.addEventListener("scroll", updateArrows, { passive: true })
    window.addEventListener("resize", updateArrows)
    return () => {
      el.removeEventListener("scroll", updateArrows)
      window.removeEventListener("resize", updateArrows)
    }
  }, [updateArrows, libraries.length, view])

  function scrollBy(dir: -1 | 1) {
    scrollerRef.current?.scrollBy({ left: dir * 320, behavior: "smooth" })
  }

  // 后台自迭代调度：每分钟询问后端是否有库满足"已启用+空闲+到点"，满足则跑一次迭代。
  // 仅依赖各库自身的开关（默认关闭），关闭时后端直接跳过、不消耗 token。
  useEffect(() => {
    let stop = false
    async function loop() {
      if (stop) return
      try {
        const runs = await tickAutoIterate()
        for (const r of runs) {
          const lib = libraries.find((l) => l.id === r.libId)
          toast.success(`自迭代「${lib?.title ?? r.libId}」：${r.result}`)
        }
        if (runs.length > 0) {
          // 迭代可能改了 updatedAt，刷新列表顺序
          const libs = await getLibraries()
          if (!stop) setLibraries(libs)
        }
      } catch {
        // 静默：调度失败不打扰用户
      }
    }
    const timer = setInterval(loop, 60_000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [libraries])

  // 进入某个知识库工作区：拉取 state + 会话（resume）
  function enterLibrary(library: KbLibrary) {
    setEnteringId(library.id)
    startTransition(async () => {
      try {
        const [state, session] = await Promise.all([
          getKbState(library.id),
          getSession(library.id),
        ])
        setView({ kind: "workspace", library, state, messages: session.messages })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "打开知识库失败")
      } finally {
        setEnteringId(null)
      }
    })
  }

  function handleCreated(lib: KbLibrary) {
    setLibraries((prev) => [lib, ...prev.filter((l) => l.id !== lib.id)])
    enterLibrary(lib)
  }

  function removeLibrary(id: string) {
    startTransition(async () => {
      try {
        await deleteKbLibrary(id)
        const libs = await getLibraries()
        setLibraries(libs)
        toast.success("已删除知识库")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "删除失败")
      }
    })
  }

  // 工作区视图
  if (view.kind === "workspace") {
    return (
      <Workspace
        library={view.library}
        initialState={view.state}
        initialMessages={view.messages}
        onExit={() => {
          // 返回时刷新列表元信息
          startTransition(async () => {
            const libs = await getLibraries()
            setLibraries(libs)
          })
          setView({ kind: "list" })
        }}
      />
    )
  }

  // 新建引导视图
  if (view.kind === "onboarding") {
    return (
      <div className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center px-4 py-8">
        <Onboarding onCreated={handleCreated} onCancel={() => setView({ kind: "list" })} />
      </div>
    )
  }

  // 库列表视图
  return (
    <div className="mx-auto flex min-h-svh max-w-4xl flex-col gap-6 px-4 py-10 md:px-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Database className="size-5" />
          <h1 className="text-balance text-xl font-semibold tracking-tight">本地知识库</h1>
          <Badge variant="secondary" className="ml-1 font-mono text-xs">AI 驱动 · 全本地</Badge>
          <div className="ml-auto">
            <ApiSettingsDialog />
          </div>
        </div>
        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
          每个知识库是一个独立目录（含 git 版本管理）与一段持久对话。新建后由 AI 初始化结构并进入对话，
          可随时导入本地资料、单文件或抓取网址，并 @ 任意层级聚焦提问。
        </p>
      </header>

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{`我的知识库（${libraries.length}）`}</span>
        {libraries.length > 0 && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              onClick={() => scrollBy(-1)}
              disabled={!canLeft}
              aria-label="向左滚动"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              onClick={() => scrollBy(1)}
              disabled={!canRight}
              aria-label="向右滚动"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}
      </div>

      <div
        ref={scrollerRef}
        className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]"
      >
        {/* 新建卡片（收敛唯一入口） */}
        <button
          type="button"
          onClick={() => setView({ kind: "onboarding" })}
          className="flex w-44 shrink-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
        >
          <Plus className="size-6" />
          <span className="text-sm font-medium">新建知识库</span>
        </button>

        {/* 已有库：按更新时间倒序（listLibraries 已倒序） */}
        {libraries.map((lib) => {
          const meta = MODE_META[lib.sourceMode]
          const Icon = meta.icon
          const busy = enteringId === lib.id
          return (
            <Card
              key={lib.id}
              className="group flex w-64 shrink-0 cursor-pointer flex-col gap-3 p-4 transition-colors hover:border-foreground/30"
              onClick={() => !pending && enterLibrary(lib)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="truncate text-sm font-semibold">{lib.title}</h3>
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{lib.audience || "未填写用途"}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeLibrary(lib.id)
                  }}
                  disabled={pending}
                  aria-label="删除知识库"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Icon className="size-3.5" />
                <span>{meta.label}</span>
                {lib.hasGit && <Badge variant="outline" className="font-mono text-[10px]">git</Badge>}
              </div>
              <div className="mt-auto flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="size-3" />
                  {relTime(lib.updatedAt)}
                </span>
                <span className="flex items-center gap-1 font-medium text-foreground opacity-0 transition-opacity group-hover:opacity-100">
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRight className="size-3.5" />}
                  {busy ? "打开中…" : "进入"}
                </span>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
