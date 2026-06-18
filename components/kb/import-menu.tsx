"use client"

import { useState, useTransition } from "react"
import type { KbState } from "@/components/kb/knowledge-base"
import {
  scanDir,
  screenSources,
  buildKb,
  importSingleFile,
} from "@/app/actions"
import { SiteCrawler } from "@/components/kb/site-crawler"
import { PathPicker } from "@/components/kb/path-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Checkbox } from "@/components/ui/checkbox"
import { formatSize } from "@/lib/kb/labels"
import { toast } from "sonner"
import { Plus, FolderInput, FileInput, Globe, Loader2, Check, FolderSearch } from "lucide-react"
import type { KbSource } from "@/lib/kb/types"

// 加号导入菜单：三种方式
// 1) 整目录导入：扫描 → AI 全量审查打分 → 用户勾选 → 一键入库
// 2) 单文件导入：扫描归类 → 直接入库
// 3) 网址抓取：复用 SiteCrawler
export function ImportMenu({
  libId,
  state,
  setState,
}: {
  libId: string
  state: KbState
  setState: (s: KbState) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="outline" className="gap-1.5">
        <Plus className="size-4" />
        导入材料
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[88svh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>导入材料到知识库</DialogTitle>
            <DialogDescription>
              选择导入方式：整目录由 AI 审查后按需筛选，单文件自动归类，网址走智能抓取。
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="dir">
            <TabsList>
              <TabsTrigger value="dir" className="gap-1.5">
                <FolderInput className="size-4" /> 整目录
              </TabsTrigger>
              <TabsTrigger value="file" className="gap-1.5">
                <FileInput className="size-4" /> 单文件
              </TabsTrigger>
              <TabsTrigger value="web" className="gap-1.5">
                <Globe className="size-4" /> 网址抓取
              </TabsTrigger>
            </TabsList>

            <TabsContent value="dir" className="mt-4">
              <DirImport libId={libId} state={state} setState={setState} />
            </TabsContent>
            <TabsContent value="file" className="mt-4">
              <FileImportPanel libId={libId} setState={setState} />
            </TabsContent>
            <TabsContent value="web" className="mt-4">
              <SiteCrawler libId={libId} state={state} setState={setState} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  )
}

// 整目录导入：扫描 + AI 审查 → 勾选清单 → 入库
function DirImport({
  libId,
  state,
  setState,
}: {
  libId: string
  state: KbState
  setState: (s: KbState) => void
}) {
  const [dir, setDir] = useState("")
  const [goal, setGoal] = useState("")
  const [busy, setBusy] = useState("")
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [reviewed, setReviewed] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  // 本目录扫描出的来源（已带相关性评分）
  const dirSources = state.sources.filter(
    (s) => s.kind === "file" && (!dir || s.location.startsWith(dir.trim())),
  )

  function scanAndReview() {
    if (!dir.trim()) {
      toast.error("请输入目录路径")
      return
    }
    setBusy("扫描目录中…")
    startTransition(async () => {
      try {
        await scanDir(libId, dir.trim())
        setBusy("AI 全量审查文件中…")
        const s = await screenSources(libId, goal.trim())
        setState(s)
        // 默认勾选相关性 >= 0.5 的文件
        const next = new Set<string>()
        for (const src of s.sources) {
          if (src.kind === "file" && (src.relevance ?? 0) >= 0.5) next.add(src.id)
        }
        setPicked(next)
        setReviewed(true)
        toast.success("审查完成，请确认要导入的文件")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "扫描失败")
      } finally {
        setBusy("")
      }
    })
  }

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function importPicked() {
    if (picked.size === 0) {
      toast.error("请至少勾选一个文件")
      return
    }
    setBusy(`入库 ${picked.size} 个文件中…`)
    startTransition(async () => {
      try {
        const s = await buildKb(libId, { includeIds: Array.from(picked) })
        setState(s)
        toast.success(`已导入 ${picked.size} 个文件到知识库`)
        setReviewed(false)
        setPicked(new Set())
        setDir("")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "入库失败")
      } finally {
        setBusy("")
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          placeholder="目录绝对路径，如 /Users/me/docs"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          disabled={pending}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => setPickerOpen(true)}
          disabled={pending}
          className="shrink-0 gap-1.5"
        >
          <FolderSearch className="size-4" />
          浏览
        </Button>
      </div>
      <Input
        placeholder="想筛选什么内容？（可选，帮助 AI 判断相关性）"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        disabled={pending}
      />
      <Button onClick={scanAndReview} disabled={pending} className="gap-1.5 self-start">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderInput className="size-4" />}
        {busy || "扫描并审查"}
      </Button>

      {reviewed && dirSources.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{`AI 审查结果（共 ${dirSources.length} 个文件，已选 ${picked.size}）`}</span>
            <Button onClick={importPicked} disabled={pending} size="sm" className="gap-1.5">
              <Check className="size-4" /> 导入勾选
            </Button>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-md border">
            {dirSources
              .slice()
              .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
              .map((s) => (
                <FileRow key={s.id} source={s} checked={picked.has(s.id)} onToggle={() => toggle(s.id)} disabled={pending} />
              ))}
          </div>
        </div>
      )}

      <PathPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="dir"
        initialDir={dir}
        onSelect={(p) => setDir(p)}
      />
    </div>
  )
}

function FileRow({
  source,
  checked,
  onToggle,
  disabled,
}: {
  source: KbSource
  checked: boolean
  onToggle: () => void
  disabled: boolean
}) {
  const rel = source.relevance ?? 0
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      className={
        "flex w-full items-center gap-2.5 border-b px-3 py-2 text-left text-sm last:border-b-0 transition-colors " +
        (checked ? "bg-foreground/5" : "hover:bg-muted")
      }
    >
      <Checkbox checked={checked} className="pointer-events-none shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{source.name}</span>
        {source.note && <span className="truncate text-xs text-muted-foreground">{source.note}</span>}
      </div>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatSize(source.sizeBytes)}</span>
      <span
        className={
          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium " +
          (rel >= 0.7
            ? "bg-foreground text-background"
            : rel >= 0.4
              ? "bg-muted-foreground/20 text-foreground"
              : "bg-muted text-muted-foreground")
        }
      >
        {rel.toFixed(2)}
      </span>
    </button>
  )
}

// 单文件导入：扫描归类 → 入库
function FileImportPanel({
  libId,
  setState,
}: {
  libId: string
  setState: (s: KbState) => void
}) {
  const [file, setFile] = useState("")
  const [busy, setBusy] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function importFile() {
    if (!file.trim()) {
      toast.error("请输入文件路径")
      return
    }
    setBusy("导入并入库中…")
    startTransition(async () => {
      try {
        const { source } = await importSingleFile(libId, file.trim())
        const s = await buildKb(libId, { includeIds: [source.id] })
        setState(s)
        toast.success(`已导入并归类：${source.name}（${source.category}）`)
        setFile("")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "导入失败")
      } finally {
        setBusy("")
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        输入单个文件的绝对路径，系统会自动按类型归类并直接入库。
      </p>
      <div className="flex gap-2">
        <Input
          placeholder="文件绝对路径，如 /Users/me/docs/spec.pdf"
          value={file}
          onChange={(e) => setFile(e.target.value)}
          disabled={pending}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => setPickerOpen(true)}
          disabled={pending}
          className="shrink-0 gap-1.5"
        >
          <FolderSearch className="size-4" />
          浏览
        </Button>
      </div>
      <Button onClick={importFile} disabled={pending} className="gap-1.5 self-start">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <FileInput className="size-4" />}
        {busy || "导入并归类"}
      </Button>

      <PathPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="file"
        onSelect={(p) => setFile(p)}
      />
    </div>
  )
}
