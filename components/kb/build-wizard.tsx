"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import {
  scanDir,
  addWebSources,
  removeSource,
  startBuild,
  submitRound1,
  submitRound2,
  acceptBuild,
  restartWorkflow,
} from "@/app/actions"
import type { KbState } from "@/components/kb/knowledge-base"
import type { WorkflowStage } from "@/lib/kb/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Markdown } from "@/components/kb/markdown"
import { QuestionForm, type AnswerInput } from "@/components/kb/question-form"
import { CATEGORY_LABEL, STATUS_LABEL, STATUS_CLASS, formatSize } from "@/lib/kb/labels"
import {
  FolderSearch,
  Globe,
  Trash2,
  RotateCcw,
  Loader2,
  Sparkles,
  CheckCircle2,
  FileText,
  FolderTree,
  MessageSquare,
} from "lucide-react"

const STAGES: { key: WorkflowStage; label: string }[] = [
  { key: "idle", label: "准备来源" },
  { key: "scanned", label: "初筛澄清" },
  { key: "built", label: "构建报告" },
  { key: "reviewing", label: "验收" },
  { key: "ready", label: "对话" },
]

export function BuildWizard({
  state,
  setState,
  onGoChat,
}: {
  state: KbState
  setState: (s: KbState) => void
  onGoChat: () => void
}) {
  const [dir, setDir] = useState(state.rootDir ?? "")
  const [urls, setUrls] = useState("")
  const [prompt, setPrompt] = useState(state.workflow.userPrompt ?? "")
  const [pending, startTransition] = useTransition()
  const [action, setAction] = useState<string | null>(null)

  const wf = state.workflow
  const stageIndex = STAGES.findIndex((s) => s.key === wf.stage)

  function run<T extends KbState>(name: string, fn: () => Promise<T>, okMsg?: string) {
    setAction(name)
    startTransition(async () => {
      try {
        const next = await fn()
        setState(next)
        if (okMsg) toast.success(okMsg)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "操作失败")
      } finally {
        setAction(null)
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <StageStepper current={stageIndex} busy={!!wf.busy} busyLabel={wf.busy} />

      {/* 阶段 0：准备来源 + 启动 */}
      {wf.stage === "idle" && (
        <>
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
                  {action === "scan" ? <Loader2 className="size-4 animate-spin" /> : "扫描"}
                </Button>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <Label htmlFor="urls" className="flex items-center gap-1.5">
                <Globe className="size-4" /> 网页链接（每行一个，AI 用原生 url_context 抓取）
              </Label>
              <Textarea
                id="urls"
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                placeholder={"https://en.wikipedia.org/wiki/FPGA\nhttps://example.com/article"}
                className="min-h-20 font-mono text-sm"
              />
              <div>
                <Button
                  variant="secondary"
                  onClick={() => run("web", () => addWebSources(urls), "已添加网页来源")}
                  disabled={pending || !urls.trim()}
                >
                  {action === "web" ? <Loader2 className="size-4 animate-spin" /> : "添加网页"}
                </Button>
              </div>
            </div>
          </Card>

          <SourceList
            sources={state.sources}
            disabled={pending}
            onRemove={(id) => run("remove", () => removeSource(id))}
          />

          <Card className="flex flex-col gap-3 p-4">
            <Label htmlFor="prompt" className="flex items-center gap-1.5">
              <Sparkles className="size-4" /> 知识库目标 / 提示词
            </Label>
            <Textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="例如：把这个 wiki 网址的内容整理成一份可问答的知识库，并帮我总结要点"
              className="min-h-16 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              点击下方按钮后，AI 将开始：初筛打分 → 向你提出澄清选择题 → 二筛建目录 →
              精细化入库 → 出报告 → 再问 → 验收 → 进入对话。
            </p>
            <div>
              <Button
                onClick={() => run("start", () => startBuild(prompt))}
                disabled={pending || state.sources.length === 0}
              >
                {action === "start" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> AI 初筛中…
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" /> 开始智能构建
                  </>
                )}
              </Button>
            </div>
          </Card>
        </>
      )}

      {/* 阶段 1：第一批选择题 */}
      {wf.stage === "scanned" && (
        <RoundCard
          title="第一批澄清问题"
          intro={wf.rounds.find((r) => r.round === 1)?.intro}
        >
          {wf.rounds.find((r) => r.round === 1) && (
            <QuestionForm
              round={wf.rounds.find((r) => r.round === 1)!}
              busy={pending}
              submitLabel="提交并开始二筛 + 构建"
              onSubmit={(answers: AnswerInput[]) =>
                run("r1", () => submitRound1(answers))
              }
            />
          )}
          <RestartButton onClick={() => run("restart", () => restartWorkflow())} disabled={pending} />
        </RoundCard>
      )}

      {/* 阶段 2：报告1 + 目录 + 第二批问题 */}
      {wf.stage === "built" && (
        <>
          <CategoryCard state={state} />
          {wf.reports.find((r) => r.round === 1) && (
            <ReportCard title="第一次构建报告">
              <Markdown>{wf.reports.find((r) => r.round === 1)!.markdown}</Markdown>
            </ReportCard>
          )}
          <RoundCard
            title="第二批优化问题"
            intro={wf.rounds.find((r) => r.round === 2)?.intro}
          >
            {wf.rounds.find((r) => r.round === 2) && (
              <QuestionForm
                round={wf.rounds.find((r) => r.round === 2)!}
                busy={pending}
                submitLabel="提交并生成验收报告"
                onSubmit={(answers: AnswerInput[]) =>
                  run("r2", () => submitRound2(answers))
                }
              />
            )}
          </RoundCard>
        </>
      )}

      {/* 阶段 3：验收报告 */}
      {wf.stage === "reviewing" && (
        <>
          <CategoryCard state={state} />
          {wf.reports.find((r) => r.round === 2) && (
            <ReportCard title="验收报告">
              <Markdown>{wf.reports.find((r) => r.round === 2)!.markdown}</Markdown>
            </ReportCard>
          )}
          <Card className="flex flex-col gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              确认知识库符合预期后，点击验收进入对话提升模式；如需重做可重启流程。
            </p>
            <div className="flex items-center gap-3">
              <Button
                onClick={() => run("accept", () => acceptBuild(), "验收通过")}
                disabled={pending}
              >
                {action === "accept" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                验收并进入对话
              </Button>
              <RestartButton
                onClick={() => run("restart", () => restartWorkflow())}
                disabled={pending}
              />
            </div>
          </Card>
        </>
      )}

      {/* 阶段 4：完成 */}
      {wf.stage === "ready" && (
        <>
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <CheckCircle2 className="size-10 text-foreground" />
            <h3 className="text-base font-semibold">知识库已就绪</h3>
            <p className="max-w-md text-pretty text-sm leading-relaxed text-muted-foreground">
              已完成 {state.sources.filter((s) => s.status === "embedded").length} 份资料、
              {state.chunkCount} 个知识块的构建，分为 {wf.categories.length} 个主题。
              现在可以进入对话提升模式，向知识库提问，AI 会结合本地资料并在需要时联网补全。
            </p>
            <div className="flex items-center gap-3">
              <Button onClick={onGoChat}>
                <MessageSquare className="size-4" /> 进入对话问答
              </Button>
              <RestartButton
                onClick={() => run("restart", () => restartWorkflow())}
                disabled={pending}
                label="重新构建"
              />
            </div>
          </Card>
          <CategoryCard state={state} />
        </>
      )}
    </div>
  )
}

function StageStepper({
  current,
  busy,
  busyLabel,
}: {
  current: number
  busy: boolean
  busyLabel?: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {STAGES.map((s, i) => (
          <div key={s.key} className="flex flex-1 items-center gap-1.5">
            <div className="flex items-center gap-1.5">
              <span
                className={
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium " +
                  (i < current
                    ? "bg-foreground text-background"
                    : i === current
                      ? "bg-foreground text-background ring-2 ring-foreground/20"
                      : "bg-muted text-muted-foreground")
                }
              >
                {i < current ? <CheckCircle2 className="size-3.5" /> : i + 1}
              </span>
              <span
                className={
                  "hidden text-xs sm:inline " +
                  (i <= current ? "text-foreground" : "text-muted-foreground")
                }
              >
                {s.label}
              </span>
            </div>
            {i < STAGES.length - 1 && (
              <div
                className={
                  "h-px flex-1 " + (i < current ? "bg-foreground" : "bg-border")
                }
              />
            )}
          </div>
        ))}
      </div>
      {busy && busyLabel && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> {busyLabel}
        </div>
      )}
    </div>
  )
}

function RoundCard({
  title,
  intro,
  children,
}: {
  title: string
  intro?: string
  children: React.ReactNode
}) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {intro && (
          <div className="rounded-md bg-muted p-3 text-sm leading-relaxed text-muted-foreground">
            {intro}
          </div>
        )}
      </div>
      {children}
    </Card>
  )
}

function ReportCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-1.5">
        <FileText className="size-4" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <Separator />
      {children}
    </Card>
  )
}

function CategoryCard({ state }: { state: KbState }) {
  const { categories } = state.workflow
  if (categories.length === 0) return null
  const nameById = new Map(state.sources.map((s) => [s.id, s.name]))
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-1.5">
        <FolderTree className="size-4" />
        <h3 className="text-sm font-semibold">知识库目录（{categories.length} 个主题）</h3>
      </div>
      <Separator />
      <div className="flex flex-col gap-3">
        {categories.map((c) => (
          <div key={c.id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                {c.name}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {c.sourceIds.length} 份
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{c.description}</p>
            <div className="flex flex-wrap gap-1.5">
              {c.sourceIds.slice(0, 8).map((id) => (
                <span
                  key={id}
                  className="truncate rounded border bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                  title={nameById.get(id)}
                >
                  {nameById.get(id) ?? id}
                </span>
              ))}
              {c.sourceIds.length > 8 && (
                <span className="text-[11px] text-muted-foreground">
                  +{c.sourceIds.length - 8}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function RestartButton({
  onClick,
  disabled,
  label = "重启流程",
}: {
  onClick: () => void
  disabled: boolean
  label?: string
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      className="w-fit text-muted-foreground"
    >
      <RotateCcw className="size-4" /> {label}
    </Button>
  )
}

function SourceList({
  sources,
  disabled,
  onRemove,
}: {
  sources: KbState["sources"]
  disabled: boolean
  onRemove: (id: string) => void
}) {
  if (sources.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
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
