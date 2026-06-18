"use client"

import { useState, useTransition } from "react"
import type { KbSource, KbWorkflow, KbLibrary, KbMessage } from "@/lib/kb/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Onboarding } from "@/components/kb/onboarding"
import { Workspace } from "@/components/kb/workspace"
import { getKbState, getSession, getLibraries, deleteKbLibrary } from "@/app/actions"
import { toast } from "sonner"
import { Database, Plus, Trash2, Loader2, FolderTree, Globe, BookOpen, ArrowRight } from "lucide-react"

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

export function KnowledgeBase({ initialLibraries }: { initialLibraries: KbLibrary[] }) {
  const [libraries, setLibraries] = useState<KbLibrary[]>(initialLibraries)
  const [view, setView] = useState<View>({ kind: "list" })
  const [pending, startTransition] = useTransition()
  const [enteringId, setEnteringId] = useState<string | null>(null)

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
        </div>
        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
          每个知识库是一个独立目录（含 git 版本管理）与一段持久对话。新建后由 AI 初始化结构并进入对话，
          可随时导入本地资料、单文件或抓取网址，并 @ 任意层级聚焦提问。
        </p>
      </header>

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{`我的知识库（${libraries.length}）`}</span>
        <Button onClick={() => setView({ kind: "onboarding" })} className="gap-1.5">
          <Plus className="size-4" />
          新建知识库
        </Button>
      </div>

      {libraries.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 border-dashed p-10 text-center">
          <FolderTree className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">还没有知识库，点击「新建知识库」开始引导流程。</p>
          <Button onClick={() => setView({ kind: "onboarding" })} variant="outline" className="gap-1.5">
            <Plus className="size-4" /> 新建知识库
          </Button>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {libraries.map((lib) => {
            const meta = MODE_META[lib.sourceMode]
            const Icon = meta.icon
            const busy = enteringId === lib.id
            return (
              <Card key={lib.id} className="group flex flex-col gap-3 p-4 transition-colors hover:border-foreground/30">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="truncate text-sm font-semibold">{lib.title}</h3>
                    <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{lib.audience || "未填写用途"}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => removeLibrary(lib.id)}
                    disabled={pending}
                    aria-label="删除知识库"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Icon className="size-3.5" />
                  <span>{meta.label}</span>
                  {lib.hasGit && <Badge variant="outline" className="font-mono text-[10px]">git</Badge>}
                </div>
                <Button
                  onClick={() => enterLibrary(lib)}
                  disabled={pending}
                  size="sm"
                  variant="secondary"
                  className="mt-auto gap-1.5"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
                  {busy ? "打开中…" : "进入对话"}
                </Button>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
