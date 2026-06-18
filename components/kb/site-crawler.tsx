"use client"

import { useState, useEffect, useTransition } from "react"
import { toast } from "sonner"
import {
  classifyOnly,
  enumerateAndSelect,
  ingestFetchable,
  serverDownload,
  getDownloadManifest,
  setCrawlLinkPicked,
  rescanDownloads,
  suggestCrawlPrompts,
} from "@/app/actions"
import type { KbState } from "@/components/kb/knowledge-base"
import type { KbCrawlSite, KbCrawlLink, LinkAction } from "@/lib/kb/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import {
  Globe,
  Loader2,
  Sparkles,
  Download,
  FileSearch,
  HardDriveDownload,
  FolderDown,
  RefreshCw,
  LogIn,
  ExternalLink,
  ArrowRightToLine,
  Lightbulb,
  ListChecks,
  CheckCircle2,
  ArrowRight,
  MessageSquare,
} from "lucide-react"

// 站点类型中文标签
const SITE_KIND_LABEL: Record<string, string> = {
  wiki: "文档 / 百科",
  open_download: "开放下载站",
  login_download: "需登录下载站",
  generic: "普通网页",
  unknown: "未知",
}

// 动作中文标签与样式
const ACTION_META: Record<LinkAction, { label: string; cls: string }> = {
  fetch: { label: "在线识别", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  server_download: { label: "服务端下载", cls: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
  manual_download: { label: "需手动下载", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  traverse: { label: "子目录", cls: "bg-muted text-muted-foreground" },
  skip: { label: "跳过", cls: "bg-muted text-muted-foreground" },
}

export function SiteCrawler({
  libId,
  state,
  setState,
}: {
  libId: string
  state: KbState
  setState: (s: KbState) => void
}) {
  const [url, setUrl] = useState("")
  const [prompt, setPrompt] = useState(state.workflow.userPrompt ?? "")
  const [site, setSite] = useState<KbCrawlSite | null>(null)
  const [pending, startTransition] = useTransition()
  const [busyLabel, setBusyLabel] = useState("")
  // AI 自动建议的提示词（点选即填入）
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loadingSug, setLoadingSug] = useState(false)
  // 入库结果：本次抓取后已加入知识库的页面，便于"知道入了什么"
  const [ingestResult, setIngestResult] = useState<{ names: string[]; failed: number } | null>(null)

  // 进入页面即按知识库标题/用途预取建议提示词
  useEffect(() => {
    let alive = true
    setLoadingSug(true)
    suggestCrawlPrompts(libId)
      .then((s) => alive && setSuggestions(s))
      .catch(() => {})
      .finally(() => alive && setLoadingSug(false))
    return () => {
      alive = false
    }
  }, [libId])

  const links = site?.links ?? []
  const fetchable = links.filter((l) => l.action === "fetch")
  const serverDl = links.filter((l) => l.action === "server_download")
  const manualDl = links.filter((l) => l.action === "manual_download")
  const traverse = links.filter((l) => l.action === "traverse")

  // 分诊（快速）后直接枚举筛选。是否需登录只影响"下载"环节（受保护文件走浏览器登录后批量下载），
  // 不影响枚举：文件清单通常无需登录即可列出。
  function runCrawl(targetUrl?: string) {
    const u = (targetUrl ?? url).trim()
    if (!/^https?:\/\//i.test(u)) {
      toast.error("请输入有效的 http(s) 网址")
      return
    }
    if (targetUrl) setUrl(targetUrl) // 深入子目录时同步输入框
    setIngestResult(null)
    setBusyLabel("分诊站点类型中…")
    startTransition(async () => {
      try {
        const classified = await classifyOnly(libId, u)
        setSite(classified)
        toast.success(`分诊完成：${SITE_KIND_LABEL[classified.siteKind]}${classified.requiresLogin ? "（需登录）" : ""}`)
        // 结合站点概况刷新更贴合的提示词建议
        suggestCrawlPrompts(libId, classified.summary).then((s) => {
          if (s.length) setSuggestions(s)
        })
        setBusyLabel("遍历站点并按目标筛选中…")
        const result = await enumerateAndSelect(libId, classified.id, prompt.trim())
        if (result) setSite(result)
        toast.success(`发现 ${result?.links.length ?? 0} 条相关链接`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "抓取失败")
      } finally {
        setBusyLabel("")
      }
    })
  }

  // 手动触发枚举（用户调整提示词后想重新筛选时）
  function runEnumerate() {
    if (!site) return
    setBusyLabel("遍历站点并按目标筛选中…")
    startTransition(async () => {
      try {
        const result = await enumerateAndSelect(libId, site.id, prompt.trim())
        if (result) setSite(result)
        toast.success(`发现 ${result?.links.length ?? 0} 条相关链接`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "枚举失败")
      } finally {
        setBusyLabel("")
      }
    })
  }

  function togglePick(link: KbCrawlLink) {
    if (!site) return
    const next = !link.picked
    // 乐观更新
    setSite({
      ...site,
      links: site.links.map((l) => (l.id === link.id ? { ...l, picked: next } : l)),
    })
    startTransition(async () => {
      await setCrawlLinkPicked(libId, site.id, link.id, next)
    })
  }

  // 批量勾选/取消一组链接（按主题分组「全选」用）
  function toggleMany(targets: KbCrawlLink[], next: boolean) {
    if (!site || targets.length === 0) return
    const ids = new Set(targets.map((l) => l.id))
    setSite({
      ...site,
      links: site.links.map((l) => (ids.has(l.id) ? { ...l, picked: next } : l)),
    })
    startTransition(async () => {
      for (const l of targets) await setCrawlLinkPicked(libId, site.id, l.id, next)
    })
  }

  function runIngest() {
    if (!site) return
    setBusyLabel("在线抓取识别并入库中…")
    startTransition(async () => {
      try {
        const r = await ingestFetchable(libId, site.id)
        if (r.site) setSite(r.site)
        // 收集已入库页面名，便于让用户清楚"入了什么"
        const names = (r.site?.links ?? site.links)
          .filter((l) => l.action === "fetch" && l.ingested)
          .map((l) => l.title || l.url)
        setIngestResult({ names, failed: r.failed })
        toast.success(`已入库 ${r.ingested} 个页面${r.failed ? `，失败 ${r.failed}` : ""}`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "入库失败")
      } finally {
        setBusyLabel("")
      }
    })
  }

  function runServerDownload() {
    if (!site) return
    setBusyLabel("服务端下载到项目目录中…")
    startTransition(async () => {
      try {
        const r = await serverDownload(libId, site.id)
        if (r.site) setSite(r.site)
        // 下载后重扫 downloads/ 并入库
        const s = await rescanDownloads(libId)
        setState(s)
        toast.success(`已下载 ${r.downloaded} 个文件到 downloads/${r.failed ? `，失败 ${r.failed}` : ""}`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "下载失败")
      } finally {
        setBusyLabel("")
      }
    })
  }

  // 一键批量下载到项目目录：用 File System Access API 让用户选 downloads/ 目录，
  // 浏览器用当前登录态逐个抓取并写入（同域 cookie 自动带上）。
  async function runBatchManualDownload() {
    if (!site) return
    const { items, host } = await getDownloadManifest(libId, site.id)
    if (items.length === 0) {
      toast.error("没有勾选的需手动下载文件")
      return
    }
    // 优先 File System Access API（Chrome/Edge，localhost 可用）
    const anyWin = window as unknown as {
      showDirectoryPicker?: (opts?: unknown) => Promise<FileSystemDirectoryHandle>
    }
    if (typeof anyWin.showDirectoryPicker === "function") {
      try {
        toast.message("请选择项目根目录下的 downloads 文件夹")
        const dirHandle = await anyWin.showDirectoryPicker({ mode: "readwrite" })
        const subHandle = await dirHandle.getDirectoryHandle(host || "site", { create: true })
        let ok = 0
        let fail = 0
        for (const it of items) {
          try {
            // 同域已登录 → 浏览器自动带 cookie；跨域无 CORS 时用 no-cors 兜底（拿不到内容���失败）
            const res = await fetch(it.url, { credentials: "include" })
            if (!res.ok) throw new Error(String(res.status))
            const blob = await res.blob()
            const fileHandle = await subHandle.getFileHandle(it.name, { create: true })
            const writable = await fileHandle.createWritable()
            await writable.write(blob)
            await writable.close()
            ok++
          } catch {
            fail++
          }
        }
        toast.success(`已写入 ${ok} 个文件到 downloads/${host}${fail ? `，${fail} 个失败（可能被 CORS 拦截，请用下方链接手动下载）` : ""}`)
        if (ok > 0) {
          const s = await rescanDownloads(libId)
          setState(s)
        }
        return
      } catch (e) {
        // 用户取消或不支持 → 降级
        if ((e as Error).name === "AbortError") return
      }
    }
    // 降级：逐个触发浏览器下载（进入系统下载目录，需用户手动移入项目）
    toast.message("浏览器不支持目录写入，已逐个触发下载，请将文件移入项目 downloads/ 目录后点重扫")
    for (const it of items) {
      const a = document.createElement("a")
      a.href = it.url
      a.download = it.name
      a.rel = "noopener"
      document.body.appendChild(a)
      a.click()
      a.remove()
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  function runRescan() {
    setBusyLabel("重新扫描 downloads/ 中…")
    startTransition(async () => {
      try {
        const s = await rescanDownloads(libId)
        setState(s)
        toast.success("已重新扫描 downloads/ 目录并更新来源")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "重扫失败")
      } finally {
        setBusyLabel("")
      }
    })
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 输入区 */}
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-2">
          <Globe className="size-4" />
          <h2 className="text-sm font-semibold">站点智能抓取</h2>
          <Badge variant="secondary" className="font-mono text-xs">
            AI 自动分诊
          </Badge>
        </div>
        <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
          输入任意网址，AI 自动分辨站点类型（文档站 / 开放下载站 / 需登录下载站）并选择遍历策略：
          自动穿透所有子目录深度遍历，再按目标挑出相关链接并<strong>按主题分类</strong>，你可整组全选而非逐条勾选。
          提示词可留空——将自动按知识库标题与用途筛选。可在线识别的直接入库；开放文件服务端下载；
          需登录的文件列出清单，你在浏览器登录后一键批量下载到项目 <code className="font-mono">downloads/</code> 目录。
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="crawl-url">网址</Label>
            <Input
              id="crawl-url"
              placeholder="https://wiki.sipeed.com/ 或 https://dl.sipeed.com/ …"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="crawl-prompt">
              抓取目标 / 提示词 <span className="font-normal text-muted-foreground">（可留空，将自动按知识库标题与用途筛选）</span>
            </Label>
            <Textarea
              id="crawl-prompt"
              placeholder="例如：收集 Tang FPGA 的数据手册与引脚封装资料（留空则按知识库标题/用途自动筛选）"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={pending}
              rows={2}
            />
            {/* AI 建议提示词：点选即填入 */}
            {(loadingSug || suggestions.length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Lightbulb className="size-3.5" />
                  {loadingSug ? "AI 正在生成建议…" : "试试："}
                </span>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={pending}
                    onClick={() => setPrompt(s)}
                    className="rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-solid hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button onClick={() => runCrawl()} disabled={pending} className="gap-2 self-start">
            {pending && busyLabel.includes("分诊") ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            开始智能抓取
          </Button>
        </div>
      </Card>

      {busyLabel && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {busyLabel}
        </div>
      )}

      {/* 分诊结果 */}
      {site && (
        <Card className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="font-medium">{SITE_KIND_LABEL[site.siteKind] ?? site.siteKind}</Badge>
            {site.requiresLogin && (
              <Badge variant="outline" className="gap-1 text-amber-600 dark:text-amber-400">
                <LogIn className="size-3" />
                需登录
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">{site.rootUrl}</span>
          </div>
          <p className="text-sm leading-relaxed">{site.summary}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">遍历策略：</span>
            {site.strategy}
          </p>

          <Separator />

          {/* 抓取结果概览：各分类数量一目了然 */}
          {links.length > 0 && (
            <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <ListChecks className="size-4" />
                抓取结果概览
                <span className="text-muted-foreground">
                  · 共 {fetchable.length + serverDl.length + manualDl.length} 个文件、{traverse.length} 个子目录
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <CountChip cls={ACTION_META.fetch.cls} label="可在线识别" total={fetchable.length} picked={fetchable.filter((l) => l.picked && !l.ingested).length} done={fetchable.filter((l) => l.ingested).length} doneLabel="已入库" />
                <CountChip cls={ACTION_META.server_download.cls} label="开放可下载" total={serverDl.length} picked={serverDl.filter((l) => l.picked && !l.downloaded).length} done={serverDl.filter((l) => l.downloaded).length} doneLabel="已下载" />
                <CountChip cls={ACTION_META.manual_download.cls} label="需手动下载" total={manualDl.length} picked={manualDl.filter((l) => l.picked).length} />
                <CountChip cls={ACTION_META.traverse.cls} label="子目录" total={traverse.length} />
              </div>
              {/* 下一步建议横幅 */}
              <NextStep
                pendingFetch={fetchable.filter((l) => l.picked && !l.ingested).length}
                pendingServer={serverDl.filter((l) => l.picked && !l.downloaded).length}
                pendingManual={manualDl.filter((l) => l.picked).length}
                requiresLogin={site.requiresLogin}
                anyIngested={fetchable.some((l) => l.ingested) || serverDl.some((l) => l.downloaded)}
              />
            </div>
          )}

          {/* 入库结果回执：清楚展示"入了什么" */}
          {ingestResult && (
            <div className="flex flex-col gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="size-4" />
                已加入知识库 {ingestResult.names.length} 个页面
                {ingestResult.failed > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">（{ingestResult.failed} 个失败）</span>
                )}
              </div>
              {ingestResult.names.length > 0 && (
                <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
                  {ingestResult.names.slice(0, 30).map((n, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <FileSearch className="size-3 shrink-0" />
                      <span className="truncate">{n}</span>
                    </div>
                  ))}
                  {ingestResult.names.length > 30 && (
                    <span className="text-xs text-muted-foreground">…等共 {ingestResult.names.length} 个</span>
                  )}
                </div>
              )}
              <div className="flex items-center gap-1.5 rounded-md bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                <MessageSquare className="size-3.5 shrink-0" />
                下一步：关闭本窗口，直接在对话中向知识库提问；这些内容已可被检索引用。
              </div>
            </div>
          )}

          {/* 操作按钮区 */}
          <div className="flex flex-wrap gap-2">
            {fetchable.length > 0 && (
              <Button onClick={runIngest} disabled={pending} size="sm" className="gap-1.5">
                <FileSearch className="size-4" />
                在线识别入库（{fetchable.filter((l) => l.picked && !l.ingested).length}）
              </Button>
            )}
            {serverDl.length > 0 && (
              <Button onClick={runServerDownload} disabled={pending} size="sm" variant="secondary" className="gap-1.5">
                <HardDriveDownload className="size-4" />
                服务端下载（{serverDl.filter((l) => l.picked && !l.downloaded).length}）
              </Button>
            )}
            {manualDl.length > 0 && (
              <Button onClick={runBatchManualDownload} disabled={pending} size="sm" variant="secondary" className="gap-1.5">
                <FolderDown className="size-4" />
                一键批量下载到项目（{manualDl.filter((l) => l.picked).length}）
              </Button>
            )}
            <Button onClick={runRescan} disabled={pending} size="sm" variant="outline" className="gap-1.5">
              <RefreshCw className="size-4" />
              重扫 downloads/
            </Button>
          </div>

          {site.requiresLogin && manualDl.length > 0 && (
            <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                <LogIn className="size-4" />
                该站受保护文件需登录后下载
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                请先在浏览器<strong>新标签页登录该网站</strong>（同一浏览器登录态自动共享），登录后回到这里点
                「<strong>一键批量下载到项目</strong>」。浏览器会用你的登录态把勾选的文件写入项目
                <code className="font-mono"> downloads/</code> 目录，无需逐个点击、无需复制 Cookie。
              </p>
              <a
                href={site.loginUrl || site.rootUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-amber-700 underline underline-offset-2 dark:text-amber-300"
              >
                <ExternalLink className="size-3" />
                打开网站登录
              </a>
            </div>
          )}

          {/* 已分诊但尚未枚举（兜底手动触发） */}
          {links.length === 0 && !busyLabel && (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
              尚未枚举到链接。
              <Button onClick={runEnumerate} disabled={pending} size="sm" variant="link" className="h-auto px-1 py-0">
                点此重新遍历并筛选
              </Button>
            </div>
          )}

          {/* 链接分组清单：按 AI 主题分类聚合，可整组全选 */}
          <div className="flex flex-col gap-4">
            <LinkGroup title="可在线识别" links={fetchable} onToggle={togglePick} onToggleMany={toggleMany} />
            <LinkGroup title="开放可下载" links={serverDl} onToggle={togglePick} onToggleMany={toggleMany} />
            <LinkGroup title="需手动下载（登录/不可在线识别）" links={manualDl} onToggle={togglePick} onToggleMany={toggleMany} />
            <LinkGroup
              title="子目录（已自动深入，如需可再手动深入）"
              links={traverse}
              onToggle={togglePick}
              readonly
              onDeepCrawl={pending ? undefined : (u) => runCrawl(u)}
            />
          </div>
        </Card>
      )}
    </div>
  )
}

// 分类计数芯片：展示总数 / 已选待处理 / 已完成
function CountChip({
  cls,
  label,
  total,
  picked,
  done,
  doneLabel,
}: {
  cls: string
  label: string
  total: number
  picked?: number
  done?: number
  doneLabel?: string
}) {
  if (total === 0) return null
  return (
    <div className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ${cls}`}>
      <span>{label}</span>
      <span className="font-mono">{total}</span>
      {typeof picked === "number" && picked > 0 && (
        <span className="rounded bg-background/40 px-1 font-mono">待处理 {picked}</span>
      )}
      {typeof done === "number" && done > 0 && (
        <span className="rounded bg-background/40 px-1 font-mono">
          {doneLabel} {done}
        </span>
      )}
    </div>
  )
}

// 下一步建议横幅：根据当前可处理项给出最该做的动作
function NextStep({
  pendingFetch,
  pendingServer,
  pendingManual,
  requiresLogin,
  anyIngested,
}: {
  pendingFetch: number
  pendingServer: number
  pendingManual: number
  requiresLogin: boolean
  anyIngested: boolean
}) {
  let text = ""
  if (pendingFetch > 0) {
    text = `下一步：点下方「在线识别入库」，把 ${pendingFetch} 个可识别页面加入知识库。`
  } else if (pendingServer > 0) {
    text = `下一步：点下方「服务端下载」，把 ${pendingServer} 个开放文件下载到项目并入库。`
  } else if (pendingManual > 0) {
    text = requiresLogin
      ? `下一步：先在浏览器登录该网站，再点「一键批量下载到项目」下载 ${pendingManual} 个受保护文件。`
      : `下一步：点「一键批量下载到项目」下载 ${pendingManual} 个文件。`
  } else if (anyIngested) {
    text = "已处理完所选内容，可关闭本窗口在对话中提问，或勾选更多链接继续。"
  } else {
    text = "请在下方各主题分组中勾选想要的链接（可整组全选），再选择上方对应的处理动作。"
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-foreground/15 bg-background/60 px-3 py-2.5 text-sm">
      <ArrowRight className="mt-0.5 size-4 shrink-0 text-foreground" />
      <span className="leading-relaxed">{text}</span>
    </div>
  )
}

function LinkGroup({
  title,
  links,
  onToggle,
  onToggleMany,
  readonly,
  onDeepCrawl,
}: {
  title: string
  links: KbCrawlLink[]
  onToggle: (l: KbCrawlLink) => void
  onToggleMany?: (targets: KbCrawlLink[], next: boolean) => void
  readonly?: boolean
  onDeepCrawl?: (url: string) => void
}) {
  if (links.length === 0) return null

  // 按 AI 主题分组聚合（无 group 的归入「其它」）
  const groups = new Map<string, KbCrawlLink[]>()
  for (const l of links) {
    const g = (l.group || "其它").trim() || "其它"
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(l)
  }
  // 主题按数量降序，便于浏览
  const grouped = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        <Badge variant="outline" className="font-mono text-[10px]">
          {links.length}
        </Badge>
        {!readonly && <span className="text-[10px] text-muted-foreground">· {grouped.length} 个主题</span>}
      </div>

      {grouped.map(([groupName, groupLinks]) => (
        <TopicGroup
          key={groupName}
          name={groupName}
          links={groupLinks}
          onToggle={onToggle}
          onToggleMany={onToggleMany}
          readonly={readonly}
          onDeepCrawl={onDeepCrawl}
        />
      ))}
    </div>
  )
}

// 单个主题分组：标题行带「全选/取消」，下面是该主题的链接条目。
function TopicGroup({
  name,
  links,
  onToggle,
  onToggleMany,
  readonly,
  onDeepCrawl,
}: {
  name: string
  links: KbCrawlLink[]
  onToggle: (l: KbCrawlLink) => void
  onToggleMany?: (targets: KbCrawlLink[], next: boolean) => void
  readonly?: boolean
  onDeepCrawl?: (url: string) => void
}) {
  const pickedCount = links.filter((l) => l.picked).length
  const allPicked = pickedCount === links.length && links.length > 0
  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-muted/20 p-2.5">
      <div className="flex items-center gap-2">
        {!readonly && onToggleMany && (
          <Checkbox
            checked={allPicked}
            onCheckedChange={() => onToggleMany(links, !allPicked)}
            aria-label={`全选主题 ${name}`}
          />
        )}
        <Badge variant="secondary" className="text-[11px]">
          {name}
        </Badge>
        <span className="font-mono text-[10px] text-muted-foreground">
          {readonly ? `${links.length}` : `${pickedCount}/${links.length}`}
        </span>
        {!readonly && onToggleMany && (
          <Button
            size="sm"
            variant="link"
            className="ml-auto h-auto px-0 py-0 text-[11px]"
            onClick={() => onToggleMany(links, !allPicked)}
          >
            {allPicked ? "取消整组" : "全选整组"}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {links.map((l) => {
          const meta = ACTION_META[l.action]
          return (
            <div
              key={l.id}
              className="flex items-start gap-2.5 rounded-md border bg-card px-3 py-2 text-sm"
            >
              {!readonly && (
                <Checkbox
                  checked={!!l.picked}
                  onCheckedChange={() => onToggle(l)}
                  className="mt-0.5"
                  aria-label={`选择 ${l.title}`}
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{l.title || l.url}</span>
                  {l.ingested && <Badge className="bg-emerald-500/10 text-emerald-600 text-[10px] dark:text-emerald-400">已入库</Badge>}
                  {l.downloaded && <Badge className="bg-sky-500/10 text-sky-600 text-[10px] dark:text-sky-400">已下载</Badge>}
                </div>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:underline"
                >
                  <ExternalLink className="size-3 shrink-0" />
                  <span className="truncate">{l.url}</span>
                </a>
                {l.note && <span className="text-xs text-muted-foreground">{l.note}</span>}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {onDeepCrawl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-2 text-xs"
                    onClick={() => onDeepCrawl(l.url)}
                  >
                    <ArrowRightToLine className="size-3" />
                    深入
                  </Button>
                )}
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}>
                  {meta.label}
                  {typeof l.relevance === "number" && ` ${l.relevance.toFixed(2)}`}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
