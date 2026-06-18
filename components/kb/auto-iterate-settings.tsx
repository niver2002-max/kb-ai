"use client"

import { useState, useEffect, useTransition } from "react"
import { getAutoIterate, setAutoIterate } from "@/app/actions"
import type { AutoIterateConfig, AutoIterateTask } from "@/lib/kb/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog"
import { RefreshCw, Loader2 } from "lucide-react"
import { toast } from "sonner"

const TASK_OPTIONS: { value: AutoIterateTask; label: string; desc: string }[] = [
  { value: "notes", label: "生成/补全笔记与摘要", desc: "为缺少摘要的来源生成详尽笔记，写入 notes/" },
  { value: "gaps", label: "找知识缺口并联网补充", desc: "分析缺口并用联网检索补全资料" },
  { value: "reindex", label: "重建索引 / 去重 / 优化", desc: "补全缺失向量、去除重复片段" },
]

export function AutoIterateDialog({ libId }: { libId: string }) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [pending, startTransition] = useTransition()
  const [cfg, setCfg] = useState<AutoIterateConfig | null>(null)

  useEffect(() => {
    if (!open || loaded) return
    getAutoIterate(libId).then((c) => {
      setCfg(c)
      setLoaded(true)
    })
  }, [open, loaded, libId])

  function update(patch: Partial<AutoIterateConfig>) {
    setCfg((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  function toggleTask(t: AutoIterateTask, on: boolean) {
    setCfg((prev) => {
      if (!prev) return prev
      const tasks = on ? [...new Set([...prev.tasks, t])] : prev.tasks.filter((x) => x !== t)
      return { ...prev, tasks }
    })
  }

  function save() {
    if (!cfg) return
    startTransition(async () => {
      await setAutoIterate(libId, cfg)
      toast.success(cfg.enabled ? "后台自迭代已开启" : "后台自迭代已关闭")
      setOpen(false)
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="gap-1.5">
            <RefreshCw className="size-4" />
            自迭代
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>后台自迭代</DialogTitle>
          <DialogDescription>
            库在前台空闲时，自动用 AI 持续完善自身。默认关闭——开启会持续消耗 token。
          </DialogDescription>
        </DialogHeader>

        {!cfg ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex flex-col gap-5 py-2">
            {/* 总开关 */}
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="ai-enabled" className="text-sm font-medium">启用后台自迭代</Label>
                <span className="text-xs text-muted-foreground">关闭时完全不调用 API、不消耗 token</span>
              </div>
              <Switch
                id="ai-enabled"
                checked={cfg.enabled}
                onCheckedChange={(v) => update({ enabled: v })}
                disabled={pending}
              />
            </div>

            {/* 任务选择 */}
            <div className="flex flex-col gap-2">
              <Label className="text-sm">执行的任务（轮流执行）</Label>
              {TASK_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-start gap-3 rounded-md border p-2.5 text-sm"
                >
                  <Checkbox
                    checked={cfg.tasks.includes(opt.value)}
                    onCheckedChange={(v) => toggleTask(opt.value, v === true)}
                    disabled={pending || !cfg.enabled}
                    className="mt-0.5"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{opt.label}</span>
                    <span className="text-xs text-muted-foreground">{opt.desc}</span>
                  </span>
                </label>
              ))}
            </div>

            {/* 频率 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ai-interval" className="text-xs">最小迭代间隔（分钟）</Label>
                <Input
                  id="ai-interval"
                  type="number"
                  min="5"
                  value={cfg.intervalMinutes}
                  onChange={(e) => update({ intervalMinutes: Math.max(5, Number(e.target.value)) })}
                  disabled={pending || !cfg.enabled}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ai-idle" className="text-xs">空闲多久才迭代（分钟）</Label>
                <Input
                  id="ai-idle"
                  type="number"
                  min="1"
                  value={cfg.idleMinutes}
                  onChange={(e) => update({ idleMinutes: Math.max(1, Number(e.target.value)) })}
                  disabled={pending || !cfg.enabled}
                />
              </div>
            </div>

            {/* 上次结果 */}
            {cfg.lastResult && (
              <div className="rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">上次迭代：</span>
                {cfg.lastResult}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={save} disabled={pending || !cfg} className="gap-1.5">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
