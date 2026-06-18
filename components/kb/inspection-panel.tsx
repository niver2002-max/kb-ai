"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import type { InspectionState } from "@/lib/kb/types"
import { getInspectionState, startInspectionAction, stopInspectionAction } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/kb/markdown"
import { toast } from "sonner"
import { ScanSearch, Loader2, Square, Sparkles } from "lucide-react"

// 巡检面板：放在主会话上方。
// · 空闲态：一条细栏 + 「开启巡检」按钮（对话生成中禁用）。
// · 巡检态：横幅展示轮次 / 完整度 / 当前动作 / 最新报告 + 「结束巡检」。
// 自身轮询服务端状态，因此关窗重开、在别处开启的巡检都会如实反映。
export function InspectionPanel({
  libId,
  initialState,
  chatBusy,
  onInspectingChange,
}: {
  libId: string
  initialState?: InspectionState
  chatBusy: boolean
  onInspectingChange: (inspecting: boolean) => void
}) {
  const [insp, setInsp] = useState<InspectionState | null>(initialState ?? null)
  const [pending, startTransition] = useTransition()
  const lastInspecting = useRef<boolean | null>(null)

  // 通知父级「是否处于巡检中」（用于置灰对话框）
  useEffect(() => {
    const inspecting = !!insp?.active
    if (lastInspecting.current !== inspecting) {
      lastInspecting.current = inspecting
      onInspectingChange(inspecting)
    }
  }, [insp?.active, onInspectingChange])

  // 轮询服务端状态：巡检中 4s 一次，空闲时 15s 一次（捕捉其它窗口的变更）。
  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout> | null = null
    async function poll() {
      if (stop) return
      try {
        const s = await getInspectionState(libId)
        if (!stop) setInsp(s)
        timer = setTimeout(poll, s.active ? 4000 : 15000)
      } catch {
        timer = setTimeout(poll, 15000)
      }
    }
    poll()
    return () => {
      stop = true
      if (timer) clearTimeout(timer)
    }
  }, [libId])

  function start() {
    startTransition(async () => {
      try {
        const s = await startInspectionAction(libId)
        setInsp(s)
        toast.success("已开启高级模型巡检")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "开启巡检失败")
      }
    })
  }

  function stop() {
    startTransition(async () => {
      try {
        const s = await stopInspectionAction(libId)
        setInsp(s)
        toast.message("巡检将在本轮结束后停止")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "结束巡检失败")
      }
    })
  }

  const active = !!insp?.active

  // 巡检态横幅
  if (active && insp) {
    const pct = Math.max(0, Math.min(100, insp.completeness))
    return (
      <div className="border-b bg-muted/40 px-4 py-3">
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          <div className="flex items-center gap-2">
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
            <span className="text-sm font-medium">高级模型巡检进行中</span>
            <span className="text-xs text-muted-foreground">{`第 ${insp.round + 1} 轮`}</span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 gap-1.5"
              onClick={stop}
              disabled={pending || insp.stopRequested}
            >
              <Square className="size-3 fill-current" />
              {insp.stopRequested ? "结束中…" : "结束巡检"}
            </Button>
          </div>

          {/* 完整度进度条 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">完整度</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-9 text-right font-mono text-xs text-foreground">{pct}%</span>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">{insp.currentAction || "准备中…"}</p>

          {/* 客观检索评估指标（跑过 eval 后展示） */}
          {insp.lastEval && (
            <div className="flex flex-wrap items-center gap-3 rounded-md bg-background/60 px-3 py-1.5 text-xs">
              <span className="text-muted-foreground">客观评估</span>
              <span className="font-mono">{`检索 ${insp.lastEval.retrievalScore}/100`}</span>
              <span className="font-mono">{`忠实度 ${insp.lastEval.faithfulnessScore}/100`}</span>
              {insp.lastEval.weakTopics.length > 0 && (
                <span className="text-muted-foreground">{`薄弱：${insp.lastEval.weakTopics.length} 项`}</span>
              )}
            </div>
          )}

          {insp.lastReport && (
            <details className="rounded-md bg-background/60 px-3 py-2 text-xs">
              <summary className="cursor-pointer select-none text-muted-foreground">最新巡检报告</summary>
              <div className="mt-2 max-h-48 overflow-y-auto">
                <Markdown>{insp.lastReport}</Markdown>
              </div>
            </details>
          )}

          {insp.error && (
            <p className="text-xs text-destructive">{`上轮出错（将自动重试）：${insp.error}`}</p>
          )}
        </div>
      </div>
    )
  }

  // 空闲态细栏
  const lastDone = insp && insp.history.length > 0
  return (
    <div className="flex items-center gap-2 border-b bg-muted/20 px-4 py-2">
      <ScanSearch className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">
        {lastDone
          ? `上次巡检完整度 ${insp!.completeness}%${insp!.done ? " · 已收敛" : ""}，可再次巡检做增量检查`
          : "对话结束后可开启高级模型巡检，自动评估并迭代知识库完整度"}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="ml-auto h-7 gap-1.5"
        onClick={start}
        disabled={pending || chatBusy}
        title={chatBusy ? "请等当前对话结束后再开启" : undefined}
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        开启巡检
      </Button>
    </div>
  )
}
