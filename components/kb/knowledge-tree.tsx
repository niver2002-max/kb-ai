"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileText,
  AtSign,
  Layers,
} from "lucide-react"
import type { KbCategory, KbSource } from "@/lib/kb/types"
import type { ChatScope } from "@/components/kb/main-session"

interface KbStateLike {
  sources: KbSource[]
  workflow: { categories: KbCategory[] }
}

export function KnowledgeTree({
  state,
  activeScope,
  onScope,
}: {
  state: KbStateLike
  activeScope: ChatScope | null
  onScope: (scope: ChatScope) => void
}) {
  const categories = state.workflow.categories ?? []
  const sourceById = new Map(state.sources.map((s) => [s.id, s]))

  // 未归类来源（已入库但不在任何分类里）
  const categorizedIds = new Set(categories.flatMap((c) => c.sourceIds))
  const uncategorized = state.sources.filter(
    (s) => !categorizedIds.has(s.id) && s.status === "embedded",
  )

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Layers className="size-3.5" />
        知识树
      </div>

      {categories.length === 0 && uncategorized.length === 0 ? (
        <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
          知识库还没有结构。导入资料并构建后，这里会实时显示分类与文件层级，可 @ 任意层级聚焦提问。
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {categories.map((cat) => (
            <CategoryNode
              key={cat.id}
              cat={cat}
              sourceById={sourceById}
              activeScope={activeScope}
              onScope={onScope}
            />
          ))}
          {uncategorized.length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5">
              <div className="px-2 py-1 text-xs text-muted-foreground">未归类</div>
              {uncategorized.map((s) => (
                <SourceLeaf
                  key={s.id}
                  source={s}
                  activeScope={activeScope}
                  onScope={onScope}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CategoryNode({
  cat,
  sourceById,
  activeScope,
  onScope,
}: {
  cat: KbCategory
  sourceById: Map<string, KbSource>
  activeScope: ChatScope | null
  onScope: (scope: ChatScope) => void
}) {
  const [open, setOpen] = useState(true)
  const active = activeScope?.type === "category" && activeScope.id === cat.id
  const sources = cat.sourceIds
    .map((id) => sourceById.get(id))
    .filter(Boolean) as KbSource[]

  return (
    <div className="flex flex-col">
      <div
        className={`group flex items-center gap-1 rounded-md px-1.5 py-1 text-sm ${
          active ? "bg-primary/10" : "hover:bg-muted/60"
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center text-muted-foreground"
          aria-label={open ? "折叠" : "展开"}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <Folder className="size-3.5 text-muted-foreground" />
        <span className="flex-1 truncate" title={cat.description}>
          {cat.name}
        </span>
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
          {sources.length}
        </Badge>
        <button
          type="button"
          onClick={() => onScope({ type: "category", id: cat.id, label: cat.name })}
          className="opacity-0 transition-opacity group-hover:opacity-100"
          title={`@ ${cat.name} 聚焦提问`}
        >
          <AtSign className="size-3.5 text-muted-foreground hover:text-foreground" />
        </button>
      </div>
      {open && sources.length > 0 && (
        <div className="ml-5 flex flex-col gap-0.5 border-l pl-2">
          {sources.map((s) => (
            <SourceLeaf
              key={s.id}
              source={s}
              activeScope={activeScope}
              onScope={onScope}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SourceLeaf({
  source,
  activeScope,
  onScope,
}: {
  source: KbSource
  activeScope: ChatScope | null
  onScope: (scope: ChatScope) => void
}) {
  const active = activeScope?.type === "source" && activeScope.id === source.id
  return (
    <div
      className={`group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm ${
        active ? "bg-primary/10" : "hover:bg-muted/60"
      }`}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate" title={source.name}>
        {source.name}
      </span>
      <button
        type="button"
        onClick={() => onScope({ type: "source", id: source.id, label: source.name })}
        className="opacity-0 transition-opacity group-hover:opacity-100"
        title={`@ ${source.name} 聚焦提问`}
      >
        <AtSign className="size-3.5 text-muted-foreground hover:text-foreground" />
      </button>
    </div>
  )
}
