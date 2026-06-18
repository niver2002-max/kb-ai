"use client"

import { useState } from "react"
import type { KbSource, KbWorkflow } from "@/lib/kb/types"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card } from "@/components/ui/card"
import { Chat } from "@/components/kb/chat"
import { BuildWizard } from "@/components/kb/build-wizard"
import { SiteCrawler } from "@/components/kb/site-crawler"
import { formatSize } from "@/lib/kb/labels"
import { Database, Files, Layers, Lock } from "lucide-react"

export interface KbState {
  rootDir: string | null
  updatedAt: number
  sources: KbSource[]
  chunkCount: number
  workflow: KbWorkflow
}

export function KnowledgeBase({ initial }: { initial: KbState }) {
  const [state, setState] = useState<KbState>(initial)
  const [tab, setTab] = useState("build")

  const embeddedCount = state.sources.filter((s) => s.status === "embedded").length
  const totalSize = state.sources.reduce((n, s) => n + s.sizeBytes, 0)
  const chatReady = state.workflow.stage === "ready" && state.chunkCount > 0

  return (
    <div className="mx-auto flex min-h-svh max-w-5xl flex-col gap-6 px-4 py-8 md:px-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Database className="size-5" />
          <h1 className="text-balance text-xl font-semibold tracking-tight">
            本地知识库
          </h1>
          <Badge variant="secondary" className="ml-1 font-mono text-xs">
            AI 驱动 · 全本地
          </Badge>
        </div>
        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
          AI 全流程自动化：扫描本地文档与抓取网页 → 初筛 → 提问澄清 → 二次筛选建目录 →
          精细化入库 → 出报告 → 二次问答优化 → 验收 → 进入对话。所有数据保存在项目
          <code className="font-mono"> .kb-data</code> 目录内，不经过云数据库。
        </p>
        <div className="flex flex-wrap gap-3">
          <Stat icon={<Files className="size-3.5" />} label="来源" value={state.sources.length} />
          <Stat icon={<Database className="size-3.5" />} label="已入库" value={embeddedCount} />
          <Stat icon={<Layers className="size-3.5" />} label="文本块" value={state.chunkCount} />
          <Stat label="总大小" value={formatSize(totalSize)} />
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="flex-1">
        <TabsList>
          <TabsTrigger value="build">构建流程</TabsTrigger>
          <TabsTrigger value="crawl">站点抓取</TabsTrigger>
          <TabsTrigger value="chat" disabled={!chatReady} className="gap-1.5">
            对话问答
            {!chatReady && <Lock className="size-3" />}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="build" className="mt-4">
          <BuildWizard state={state} setState={setState} onGoChat={() => setTab("chat")} />
        </TabsContent>

        <TabsContent value="crawl" className="mt-4">
          <SiteCrawler state={state} setState={setState} />
        </TabsContent>

        <TabsContent value="chat" className="mt-4">
          <Card className="h-[62svh] p-4">
            <Chat chunkCount={state.chunkCount} />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Stat({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode
  label: string
  value: string | number
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm">
      {icon}
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </div>
  )
}
