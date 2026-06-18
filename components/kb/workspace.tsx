"use client"

import { useState, useEffect } from "react"
import type { KbLibrary, KbMessage } from "@/lib/kb/types"
import type { KbState } from "@/components/kb/knowledge-base"
import { MainSession, type ChatScope } from "@/components/kb/main-session"
import { KnowledgeTree } from "@/components/kb/knowledge-tree"
import { ImportMenu } from "@/components/kb/import-menu"
import { BuildWizard } from "@/components/kb/build-wizard"
import { ApiSettingsDialog } from "@/components/kb/api-settings"
import { InspectionPanel } from "@/components/kb/inspection-panel"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Database, Settings2, ArrowLeft } from "lucide-react"

// 单个知识库的工作区：左知识树 + 中主会话 + 右上导入/构建。
export function Workspace({
  library,
  initialState,
  initialMessages,
  onExit,
}: {
  library: KbLibrary
  initialState: KbState
  initialMessages: KbMessage[]
  onExit: () => void
}) {
  const [state, setState] = useState<KbState>(initialState)
  const [scope, setScope] = useState<ChatScope | null>(null)
  // 巡检中：对话框置灰；对话生成中：禁用「开启巡检」
  const [inspecting, setInspecting] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)

  // 知识树随 state 实时更新；导入菜单与构建向导通过 setState 推动更新
  useEffect(() => {
    setState(initialState)
  }, [initialState])

  const embeddedCount = state.sources.filter((s) => s.status === "embedded").length

  return (
    <div className="flex h-svh flex-col">
      {/* 顶栏 */}
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon" onClick={onExit} className="size-8 shrink-0" aria-label="返回知识库列表">
          <ArrowLeft className="size-4" />
        </Button>
        <Database className="size-4 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-sm font-semibold leading-tight">{library.title}</h1>
          <span className="truncate text-xs text-muted-foreground">{library.audience}</span>
        </div>
        <Badge variant="secondary" className="ml-1 shrink-0 font-mono text-xs">
          {`${embeddedCount} 已入库 · ${state.chunkCount} 块`}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <ImportMenu libId={library.id} state={state} setState={setState} />
          <BuildSheet libId={library.id} state={state} setState={setState} />
          <ApiSettingsDialog />
        </div>
      </header>

      {/* 主体三栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 左：知识树 */}
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r p-3 md:block lg:w-72">
          <KnowledgeTree state={state} activeScope={scope} onScope={setScope} />
        </aside>

        {/* 中：主会话（上方为巡检面板） */}
        <main className="flex min-w-0 flex-1 flex-col">
          <InspectionPanel
            libId={library.id}
            initialState={library.inspection}
            chatBusy={chatBusy}
            onInspectingChange={setInspecting}
          />
          <MainSession
            libId={library.id}
            initialMessages={initialMessages}
            chunkCount={state.chunkCount}
            scope={scope}
            onClearScope={() => setScope(null)}
            inspecting={inspecting}
            onBusyChange={setChatBusy}
          />
        </main>
      </div>
    </div>
  )
}

// 构建向导放进侧滑面板（保留完整自动化流程，不占据主界面）
function BuildSheet({
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
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button variant="outline" size="sm" className="gap-1.5">
            <Settings2 className="size-4" />
            构建流程
          </Button>
        }
      />
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>知识库构建流程</SheetTitle>
        </SheetHeader>
        <div className="mt-4 px-1">
          <BuildWizard libId={libId} state={state} setState={setState} onGoChat={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
