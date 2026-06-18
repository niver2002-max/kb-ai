"use client"

import { useState, useEffect, useCallback } from "react"
import { browseFs, makeDir, pickNativePath, type FsEntry } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import {
  Folder,
  FileText,
  ArrowUp,
  Loader2,
  FolderPlus,
  Check,
  CornerDownRight,
  MonitorUp,
} from "lucide-react"

// 应用内文件系统选择弹窗：逐层浏览服务器目录，返回真实绝对路径。
// mode="dir" 选目录（可新建文件夹）；mode="file" 选文件。
export function PathPicker({
  open,
  onOpenChange,
  mode,
  initialDir,
  onSelect,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: "dir" | "file"
  initialDir?: string
  onSelect: (absPath: string) => void
}) {
  const [cwd, setCwd] = useState("")
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [selected, setSelected] = useState<string>("") // 选中的文件路径（file 模式）
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [nativeBusy, setNativeBusy] = useState(false)

  // 调起系统原生对话框（Win/macOS/Linux）。成功即返回选中路径并关闭弹窗；
  // 取消则保持应用内浏览；环境不支持则提示改用应用内浏览。
  async function pickNative() {
    setNativeBusy(true)
    try {
      const p = await pickNativePath(mode, cwd || initialDir)
      if (p) {
        onSelect(p)
        onOpenChange(false)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "无法调起系统对话框")
    } finally {
      setNativeBusy(false)
    }
  }

  const load = useCallback(
    async (dir?: string) => {
      setLoading(true)
      try {
        const res = await browseFs(dir, { onlyDirs: mode === "dir" })
        setCwd(res.cwd)
        setParent(res.parent)
        setEntries(res.entries)
        setSelected("")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "读取目录失败")
      } finally {
        setLoading(false)
      }
    },
    [mode],
  )

  // 打开时从 initialDir（或主目录）开始
  useEffect(() => {
    if (open) {
      setCreating(false)
      setNewName("")
      void load(initialDir)
    }
  }, [open, initialDir, load])

  function openEntry(entry: FsEntry) {
    if (entry.isDir) void load(entry.path)
    else if (mode === "file") setSelected(entry.path)
  }

  function confirm() {
    if (mode === "dir") {
      onSelect(cwd) // 选当前所在目录
    } else {
      if (!selected) {
        toast.error("请选择一个文件")
        return
      }
      onSelect(selected)
    }
    onOpenChange(false)
  }

  async function createFolder() {
    if (!newName.trim()) {
      toast.error("请输入文件夹名称")
      return
    }
    try {
      const created = await makeDir(cwd, newName.trim())
      setCreating(false)
      setNewName("")
      toast.success("已创建文件夹")
      void load(created)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "创建失败")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80svh] max-w-2xl flex-col gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle>{mode === "dir" ? "选择目录" : "选择文件"}</DialogTitle>
          <DialogDescription>
            {mode === "dir"
              ? "推荐用系统对话框选择；也可在下方应用内浏览，点「选择此目录」确认。"
              : "推荐用系统对话框选择；也可在下方应用内浏览，点「选择此文件」确认。"}
          </DialogDescription>
        </DialogHeader>

        {/* 系统原生对话框（更顺手，尤其 Windows） */}
        <Button onClick={pickNative} disabled={nativeBusy} className="w-full gap-1.5">
          {nativeBusy ? <Loader2 className="size-4 animate-spin" /> : <MonitorUp className="size-4" />}
          {nativeBusy ? "等待系统对话框…" : mode === "dir" ? "用系统对话框选择目录" : "用系统对话框选择文件"}
        </Button>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          或在应用内浏览
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* 当前路径 + 上级 */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!parent || loading}
            onClick={() => parent && load(parent)}
            className="gap-1.5"
          >
            <ArrowUp className="size-4" />
            上级
          </Button>
          <div className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-1.5 font-mono text-xs text-muted-foreground">
            {cwd || "…"}
          </div>
          {mode === "dir" && (
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => setCreating((v) => !v)}
              className="gap-1.5"
            >
              <FolderPlus className="size-4" />
              新建
            </Button>
          )}
        </div>

        {creating && (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              placeholder="新文件夹名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createFolder()}
            />
            <Button size="sm" onClick={createFolder} className="gap-1.5">
              <Check className="size-4" />
              创建
            </Button>
          </div>
        )}

        {/* 条目列表 */}
        <div className="min-h-48 flex-1 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载中…
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              {mode === "dir" ? "此目录下没有子目录" : "此目录为空"}
            </div>
          ) : (
            entries.map((entry) => {
              const isSel = !entry.isDir && selected === entry.path
              return (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => openEntry(entry)}
                  className={
                    "flex w-full items-center gap-2.5 border-b px-3 py-2 text-left text-sm last:border-b-0 transition-colors " +
                    (isSel ? "bg-foreground/5" : "hover:bg-muted")
                  }
                >
                  {entry.isDir ? (
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate flex-1">{entry.name}</span>
                  {entry.isDir && <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
                  {isSel && <Check className="size-4 shrink-0 text-foreground" />}
                </button>
              )
            })
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <span className="truncate font-mono text-xs text-muted-foreground">
            {mode === "file" ? selected || "未选择文件" : cwd}
          </span>
          <Button onClick={confirm} disabled={loading} className="gap-1.5">
            <Check className="size-4" />
            {mode === "dir" ? "选择此目录" : "选择此文件"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
