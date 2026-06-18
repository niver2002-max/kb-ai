"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { Loader2, FolderPlus, BookOpen, Globe, FolderTree } from "lucide-react"
import { createKbLibrary } from "@/app/actions"
import type { KbLibrary } from "@/lib/kb/types"

type SourceMode = KbLibrary["sourceMode"]

const MODE_OPTIONS: Array<{
  value: SourceMode
  label: string
  desc: string
  icon: typeof BookOpen
}> = [
  { value: "materials", label: "我有现成资料", desc: "稍后导入本地目录 / 文件", icon: FolderTree },
  { value: "web", label: "我没有资料", desc: "让 AI 联网检索帮我建库", icon: Globe },
  { value: "mixed", label: "两者都有", desc: "本地资料 + 联网补全", icon: BookOpen },
]

export function Onboarding({
  onCreated,
  onCancel,
}: {
  onCreated: (lib: KbLibrary) => void
  onCancel?: () => void
}) {
  const [title, setTitle] = useState("")
  const [audience, setAudience] = useState("")
  const [rootDir, setRootDir] = useState("")
  const [mode, setMode] = useState<SourceMode>("materials")
  const [pending, startTransition] = useTransition()

  function submit() {
    if (!title.trim()) {
      toast.error("请填写知识库标题")
      return
    }
    if (!rootDir.trim()) {
      toast.error("请填写知识库存放目录（绝对路径）")
      return
    }
    startTransition(async () => {
      try {
        const lib = await createKbLibrary({
          title: title.trim(),
          audience: audience.trim(),
          rootDir: rootDir.trim(),
          sourceMode: mode,
        })
        toast.success(`知识库「${lib.title}」已创建并初始化${lib.hasGit ? "（含 git）" : ""}`)
        onCreated(lib)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "创建失败")
      }
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 py-10">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <FolderPlus className="size-4" />
          新建知识库
        </div>
        <h1 className="text-balance text-2xl font-semibold tracking-tight">
          先告诉我这个知识库的基本信息
        </h1>
        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
          我会在你指定的目录里初始化分层结构与 git，然后进入一个贯穿整个知识库的持久对话——
          重启后自动恢复，随时可在右上角加号导入更多资料。
        </p>
      </header>

      <Card className="flex flex-col gap-5 p-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="kb-title">标题</Label>
          <Input
            id="kb-title"
            placeholder="例如：GOWIN FPGA 器件知识库"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="kb-audience">主要面向 / 用途</Label>
          <Textarea
            id="kb-audience"
            placeholder="例如：面向硬件工程师，用于快速查询器件参数、引脚定义与设计注意事项"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            disabled={pending}
            rows={2}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="kb-dir">存放目录（绝对路径）</Label>
          <Input
            id="kb-dir"
            placeholder="例如：/Users/you/knowledge-bases/gowin 或项目内 kb/gowin"
            value={rootDir}
            onChange={(e) => setRootDir(e.target.value)}
            disabled={pending}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            将在此目录建立 sources/、raw/、imports/、exports/、notes/ 分层并初始化 git。
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label>资料来源</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODE_OPTIONS.map((opt) => {
              const Icon = opt.icon
              const active = mode === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMode(opt.value)}
                  disabled={pending}
                  className={`flex flex-col gap-1 rounded-md border p-3 text-left transition-colors ${
                    active
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <Icon className={`size-4 ${active ? "text-primary" : "text-muted-foreground"}`} />
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{opt.desc}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel} disabled={pending}>
              取消
            </Button>
          )}
          <Button onClick={submit} disabled={pending} className="gap-1.5">
            {pending ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
            创建并初始化
          </Button>
        </div>
      </Card>
    </div>
  )
}
