"use client"

import { useState, useEffect, useTransition } from "react"
import {
  getApiSettings,
  saveApiSettings,
  testApiEndpoint,
  listApiModels,
  pingApiModels,
} from "@/app/actions"
import type { ApiSettings } from "@/lib/kb/settings"
import type { ModelInfo, ModelLiveResult } from "@/lib/kb/api-probe"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog"
import { Settings, Loader2, CheckCircle2, XCircle, Zap, ListChecks, Plug } from "lucide-react"
import { toast } from "sonner"

export function ApiSettingsDialog() {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [pending, startTransition] = useTransition()

  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState("")
  const [inspectModel, setInspectModel] = useState("")
  const [embedModel, setEmbedModel] = useState("")
  const [temperature, setTemperature] = useState(0)
  const [stream, setStream] = useState(true)

  const [busy, setBusy] = useState("")
  const [endpointOk, setEndpointOk] = useState<boolean | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [live, setLive] = useState<Record<string, ModelLiveResult>>({})

  // 打开时加载当前设置
  useEffect(() => {
    if (!open || loaded) return
    getApiSettings().then((s) => {
      setBaseUrl(s.baseUrl)
      setApiKey(s.apiKey)
      setModel(s.model)
      setInspectModel(s.inspectModel)
      setEmbedModel(s.embedModel)
      setTemperature(s.temperature)
      setStream(s.stream)
      setLoaded(true)
    })
  }, [open, loaded])

  // 1) 智能测端点
  function runTestEndpoint() {
    setBusy("endpoint")
    setEndpointOk(null)
    startTransition(async () => {
      try {
        const r = await testApiEndpoint(baseUrl, apiKey)
        setEndpointOk(r.ok)
        if (r.ok) {
          setBaseUrl(r.baseUrl) // 回填可用的规整地址
          toast.success(r.message)
        } else {
          toast.error(r.message)
        }
      } finally {
        setBusy("")
      }
    })
  }

  // 2) 智能列模型
  function runListModels() {
    setBusy("models")
    startTransition(async () => {
      try {
        const r = await listApiModels(baseUrl, apiKey)
        if (!r.ok) {
          toast.error(r.message)
          return
        }
        setBaseUrl(r.baseUrl)
        setModels(r.models)
        setLive({})
        toast.success(r.message)
        // 自动给未设置的模型挑默认值
        if (!model) {
          const firstGen = r.models.find((m) => m.canGenerate)
          if (firstGen) setModel(firstGen.id)
        }
        if (!embedModel) {
          const firstEmbed = r.models.find((m) => m.canEmbed)
          if (firstEmbed) setEmbedModel(firstEmbed.id)
        }
      } finally {
        setBusy("")
      }
    })
  }

  // 3) 智能测活：对当前列出的可对话/可嵌入模型并发测活
  function runPing() {
    if (models.length === 0) {
      toast.error("请先列出模型")
      return
    }
    setBusy("ping")
    startTransition(async () => {
      try {
        const targets = models
          .filter((m) => m.canGenerate || m.canEmbed)
          .map((m) => ({ id: m.id, kind: m.canGenerate ? ("generate" as const) : ("embed" as const) }))
        const results = await pingApiModels(baseUrl, apiKey, targets)
        const map: Record<string, ModelLiveResult> = {}
        for (const r of results) map[r.id] = r
        setLive(map)
        const alive = results.filter((r) => r.alive).length
        toast.success(`测活完成：${alive}/${results.length} 个模型可用`)
      } finally {
        setBusy("")
      }
    })
  }

  function save() {
    startTransition(async () => {
      await saveApiSettings({ baseUrl, apiKey, model, inspectModel, embedModel, temperature, stream })
      toast.success("设置已保存")
      setOpen(false)
    })
  }

  const genModels = models.filter((m) => m.canGenerate)
  const embedModels = models.filter((m) => m.canEmbed)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="icon" className="size-9" aria-label="API 设置">
            <Settings className="size-4" />
          </Button>
        }
      />
      <DialogContent className="max-h-[88vh] gap-0 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>API 设置</DialogTitle>
          <DialogDescription>
            配置第三方 Gemini 原生兼容端点，并智能测试端点、列出模型、测活模型。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-4">
          {/* 端点 + 密钥 */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="base">API 端点（可只填域名，自动补 /v1beta）</Label>
              <Input
                id="base"
                placeholder="https://你的中转域名 或 https://域名/v1beta"
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value)
                  setEndpointOk(null)
                }}
                disabled={pending}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key">API Key</Label>
              <Input
                id="key"
                type="password"
                placeholder="sk-... 或 AIza..."
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setEndpointOk(null)
                }}
                disabled={pending}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runTestEndpoint} disabled={pending} size="sm" variant="secondary" className="gap-1.5">
                {busy === "endpoint" ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                测试端点
              </Button>
              <Button onClick={runListModels} disabled={pending} size="sm" variant="secondary" className="gap-1.5">
                {busy === "models" ? <Loader2 className="size-4 animate-spin" /> : <ListChecks className="size-4" />}
                列出模型
              </Button>
              <Button onClick={runPing} disabled={pending || models.length === 0} size="sm" variant="secondary" className="gap-1.5">
                {busy === "ping" ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
                测活模型
              </Button>
              {endpointOk === true && (
                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 className="size-3.5" /> 端点可用
                </span>
              )}
              {endpointOk === false && (
                <span className="flex items-center gap-1 text-xs text-destructive">
                  <XCircle className="size-3.5" /> 端点不可用
                </span>
              )}
            </div>
          </div>

          {/* 模型选择 */}
          {models.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <ModelPicker
                label={`对话模型（${genModels.length}）`}
                list={genModels}
                value={model}
                onChange={setModel}
                live={live}
              />
              <ModelPicker
                label={`向量模型（${embedModels.length}）`}
                list={embedModels}
                value={embedModel}
                onChange={setEmbedModel}
                live={live}
              />
            </div>
          )}

          {/* 当前选定（手填兜底） */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="model">对话模型（活动对话）</Label>
              <Input id="model" value={model} onChange={(e) => setModel(e.target.value)} disabled={pending} className="font-mono text-sm" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspect">巡检模型（高级）</Label>
              <Input id="inspect" value={inspectModel} onChange={(e) => setInspectModel(e.target.value)} disabled={pending} className="font-mono text-sm" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="embed">向量模型</Label>
              <Input id="embed" value={embedModel} onChange={(e) => setEmbedModel(e.target.value)} disabled={pending} className="font-mono text-sm" />
            </div>
          </div>

          {/* 高级 */}
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="temp">采样温度（{temperature}）</Label>
              <Input
                id="temp"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
                disabled={pending}
                className="w-28"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="stream" checked={stream} onCheckedChange={setStream} disabled={pending} />
              <Label htmlFor="stream">启用流式输出</Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={save} disabled={pending} className="gap-1.5">
            {pending && busy === "" ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ModelPicker({
  label,
  list,
  value,
  onChange,
  live,
}: {
  label: string
  list: ModelInfo[]
  value: string
  onChange: (id: string) => void
  live: Record<string, ModelLiveResult>
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="max-h-40 overflow-y-auto rounded-md border">
        {list.length === 0 && <p className="p-3 text-xs text-muted-foreground">无</p>}
        {list.map((m) => {
          const r = live[m.id]
          const selected = value === m.id
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onChange(m.id)}
              className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted ${
                selected ? "bg-muted font-medium" : ""
              }`}
            >
              <span className="truncate font-mono">{m.id}</span>
              {r && (
                <span className="shrink-0">
                  {r.alive ? (
                    <Badge variant="outline" className="gap-1 text-[10px] text-green-600 dark:text-green-400">
                      <CheckCircle2 className="size-3" />
                      {r.latencyMs}ms
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 text-[10px] text-destructive">
                      <XCircle className="size-3" />
                      离线
                    </Badge>
                  )}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
