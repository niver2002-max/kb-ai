"use client"

import { useState } from "react"
import type { KbQuestionRound } from "@/lib/kb/types"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2 } from "lucide-react"

export interface AnswerInput {
  id: string
  answer: string[]
  freeText?: string
}

// 渲染一轮选择题并收集答案。支持单选/多选 + 每题可选补充说明。
export function QuestionForm({
  round,
  busy,
  submitLabel,
  onSubmit,
}: {
  round: KbQuestionRound
  busy: boolean
  submitLabel: string
  onSubmit: (answers: AnswerInput[]) => void
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    for (const q of round.questions) init[q.id] = q.answer ?? []
    return init
  })
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const q of round.questions) init[q.id] = q.freeText ?? ""
    return init
  })

  function toggle(qid: string, option: string, multi: boolean) {
    setSelected((prev) => {
      const cur = prev[qid] ?? []
      if (multi) {
        return {
          ...prev,
          [qid]: cur.includes(option)
            ? cur.filter((o) => o !== option)
            : [...cur, option],
        }
      }
      return { ...prev, [qid]: cur.includes(option) ? [] : [option] }
    })
  }

  function submit() {
    const answers: AnswerInput[] = round.questions.map((q) => ({
      id: q.id,
      answer: selected[q.id] ?? [],
      freeText: notes[q.id]?.trim() || undefined,
    }))
    onSubmit(answers)
  }

  const allAnswered = round.questions.every(
    (q) => (selected[q.id]?.length ?? 0) > 0 || (notes[q.id]?.trim()?.length ?? 0) > 0,
  )

  return (
    <div className="flex flex-col gap-5">
      {round.questions.map((q, qi) => (
        <div key={q.id} className="flex flex-col gap-2.5">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-medium text-background">
              {qi + 1}
            </span>
            <Label className="text-sm font-medium leading-relaxed">
              {q.question}
              {q.multiSelect && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  （可多选）
                </span>
              )}
            </Label>
          </div>
          <div className="ml-7 flex flex-col gap-2">
            {q.options.map((opt) => {
              const checked = (selected[q.id] ?? []).includes(opt)
              return (
                <button
                  key={opt}
                  type="button"
                  disabled={busy}
                  onClick={() => toggle(q.id, opt, q.multiSelect)}
                  className={
                    "flex items-center gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors " +
                    (checked
                      ? "border-foreground bg-foreground/5"
                      : "border-border hover:bg-muted")
                  }
                >
                  <Checkbox checked={checked} className="pointer-events-none" />
                  <span>{opt}</span>
                </button>
              )
            })}
            <Textarea
              value={notes[q.id] ?? ""}
              onChange={(e) =>
                setNotes((prev) => ({ ...prev, [q.id]: e.target.value }))
              }
              placeholder="补充说明（可选）"
              disabled={busy}
              className="mt-1 min-h-9 text-sm"
            />
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={busy || !allAnswered}>
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" /> 处理中…
            </>
          ) : (
            submitLabel
          )}
        </Button>
        {!allAnswered && (
          <span className="text-xs text-muted-foreground">
            请至少回答每道题（选择或填写补充）
          </span>
        )}
      </div>
    </div>
  )
}
