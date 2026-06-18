"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import {
  classifyOnly,
  enumerateAndSelect,
  ingestFetchable,
  serverDownload,
  getDownloadManifest,
  setCrawlLinkPicked,
  rescanDownloads,
  loginCrawlSite,
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
  state,
  setState,
}: {
  state: KbState
  setState: (s: KbState) => void
}) {
  const [url, setUrl] = useState("")
  const [prompt, setPrompt] = useState(state.workflow.userPrompt ?? "")
  const [site, setSite] = useState<KbCrawlSite | null>(null)
  const [pending, startTransition] = useTransition()
  const [busyLabel, setBusyLabel] = useState("")
  const [loginEmail, setLoginEmail] = useState("")
  const [loginPassword, setLoginPassword] = useState("")

  const links = site?.links ?? []
  const fetchable = links.filter((l) => l.action === "fetch")
  const serverDl = links.filter((l) => l.action === "server_download")
  const manualDl = links.filter((l) => l.action === "manual_download")
  const traverse = links.filter((l) => l.action === "traverse")

  // 步骤一：分诊（快速）。识别站点类型/是否需登录后立即反馈；
  // 开放站点直接继续枚举，需登录站点则停下等用户先登录。
  function runCrawl(targetUrl?: string) {
    const u = (targetUrl ?? url).trim()
    if (!/^https?:\/\//i.test(u)) {
      toast.error("请输入有效的 http(s) 网址")
      return
    }
    if (targetUrl) setUrl(targetUrl) // 深入子目录时同步输入框
    setBusyLabel("分诊站点类型中…")
    startTransition(async () => {
      try {
        const classified = await classifyOnly(u)
        setSite(classified)
        toast.success(`分诊完成：${SITE_KIND_LABEL[classified.siteKind]}${classified.requiresLogin ? "（需登录）" : ""}`)
        // 需登录站点：先停下，等用户登录后再枚举（登录后才看得到完整清单）
        if (classified.requiresLogin && !classified.loggedIn) {
          setBusyLabel("")
          return
        }
        // 开放站点：直接枚举并筛选
        setBusyLabel("遍历站点并按目标筛选中…")
        const result = await enumerateAndSelect(classified.id, prompt.trim())
        if (result) setSite(result)
        toast.success(`发现 ${result?.links.length ?? 0} 条相关链接`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "抓取失败")
      } finally {
        setBusyLabel("")
      }
    })
  }

  // 手动触发枚举（需登录站点登录后，或用户想跳过登录直接枚举开放部分时）
  function runEnumerate() {
    if (!site) return
    setBusyLabel("遍历站点并按目标筛选中…")
    startTransition(async () => {
      try {
        const result = await enumerateAndSelect(site.id, prompt.trim())
        if (result) setSite(result)
        toast.success(`发现 ${result?.links.length ?? 0} 条相关链接`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "枚举失败")
      } finally {
        setBusyLabel("")
      }
    })
  }

  // 服务端登录（账号密码）→ 登录成功后自动重新遍历，需登录文件转为服务端可下载
  function runLogin() {
    if (!site) return
    setBusyLabel("服务端登录中…")
    startTransition(async () => {
      try {
        const r = await loginCrawlSite(site.id, loginEmail.trim(), loginPassword)
        if (!r.ok) {
          toast.error(r.message)
          if (r.site) setSite(r.site)
          setBusyLabel("")
          return
        }
        if (r.site) setSite(r.site)
        toast.success(r.message)
        setBusyLabel("登录成功，遍历站点中…")
        const updated = await enumerateAndSelect(site.id, prompt.trim())
        if (updated) setSite(updated)
        toast.success("已用登录态枚举，受保护文件现可服务端下载")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "登录失败")
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
      await setCrawlLinkPicked(site.id, link.id, next)
    })
  }

  function runIngest() {
    if (!site) return
    setBusyLabel("在线抓取识别并入库中…")
    startTransition(async () => {
      try {
        const r = await ingestFetchable(site.id)
        if (r.site) setSite(r.site)
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
        const r = await serverDownload(site.id)
        if (r.site) setSite(r.site)
        // 下载后重扫 downloads/ 并入库
        const s = await rescanDownloads()
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
    const { items, host } = await getDownloadManifest(site.id)
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
            // 同域已登录 → 浏览器自动带 cookie；跨域无 CORS 时用 no-cors 兜底（拿不到内容则失败）
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
          const s = await rescanDownloads()
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
        const s = await rescanDownloads()
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
          先快速遍历，再按你的目标挑出相关链接。可在线识别的直接入库；开放文件服务端下载；
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
            <Label htmlFor="crawl-prompt">抓取目标 / 提示词</Label>
            <Textarea
              id="crawl-prompt"
              placeholder="例��：收集 Tang FPGA 的数据手册与引脚封装资料"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={pending}
              rows={2}
            />
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

          {site.requiresLogin && (
            <div className="flex flex-col gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                <LogIn className="size-4" />
                {site.loggedIn ? "已登录该站点" : "该站需要登录后才能下载受保护文件"}
              </div>
              {!site.loggedIn && (
                <>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    在服务端登录该网站（账号密码由 AI 自动识别表单字段后提交），登录态保留在本次运行内，
                    之后受保护文件可由服务端直接下载到 <code className="font-mono">downloads/</code>。留空则使用环境变量中的默认账号。
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      placeholder="账号 / 邮箱"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      disabled={pending}
                      className="sm:max-w-[220px]"
                    />
                    <Input
                      type="password"
                      placeholder="密码"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      disabled={pending}
                      className="sm:max-w-[220px]"
                    />
                    <Button onClick={runLogin} disabled={pending} size="sm" className="gap-1.5">
                      <LogIn className="size-4" />
                      登录并遍历
                    </Button>
                    <Button onClick={runEnumerate} disabled={pending} size="sm" variant="outline">
                      跳过登录，仅枚举公开部分
                    </Button>
                  </div>
                </>
              )}
              {manualDl.length > 0 && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  也可在浏览器<strong>新标签页登录该网站</strong>后，点下方「一键批量下载到项目」，
                  浏览器用同域登录态把文件写入 <code className="font-mono">downloads/</code>（被 CORS 拦截时降级为逐个下载）。
                </p>
              )}
            </div>
          )}

          {/* 已分诊但尚未枚举（需登录站点登录后会自动枚举；这里兜底提供手动触发） */}
          {links.length === 0 && !site.requiresLogin && !busyLabel && (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
              尚未枚举链接。
              <Button onClick={runEnumerate} disabled={pending} size="sm" variant="link" className="h-auto px-1 py-0">
                点此遍历并筛选
              </Button>
            </div>
          )}

          {/* 链接分组清单 */}
          <div className="flex flex-col gap-4">
            <LinkGroup title="可在线识别" links={fetchable} onToggle={togglePick} />
            <LinkGroup title="开放可下载" links={serverDl} onToggle={togglePick} />
            <LinkGroup title="需手动下载（登录/不可在线识别）" links={manualDl} onToggle={togglePick} />
            <LinkGroup
              title="子目录（点「深入」继续抓取）"
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

function LinkGroup({
  title,
  links,
  onToggle,
  readonly,
  onDeepCrawl,
}: {
  title: string
  links: KbCrawlLink[]
  onToggle: (l: KbCrawlLink) => void
  readonly?: boolean
  onDeepCrawl?: (url: string) => void
}) {
  if (links.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        <Badge variant="outline" className="font-mono text-[10px]">
          {links.length}
        </Badge>
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
