// 站点智能抓取核心：运行时由 Gemini 分诊站点类型并自适应处理。
// 绝不按 URL 硬编码判断——所有"这是什么站点/这个链接怎么处理"都交给模型在运行时决策。
//
// 流程：classifySite(分诊) → enumerateSite(快速遍历枚举链接) →
//       selectLinks(按用户目标 AI 选取) → 按 action 分流：
//       fetch(在线识别) / server_download(服务端下载) / manual_download(用户端下载)

import { promises as fs } from "node:fs"
import path from "node:path"
import type { KbCrawlSite, KbCrawlLink, SiteKind, LinkAction } from "./types"
import { geminiJson, geminiUrlContext } from "./gemini"
import { mapLimit } from "./concurrency"

const UA =
  "Mozilla/5.0 (compatible; LocalKnowledgeBase/1.0; +local)"

// 项目内统一下载目录
export const DOWNLOADS_DIR = path.join(process.cwd(), "downloads")

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

// 把相对链接解析为绝对 URL（容错）
function absolutize(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}

// 轻量抓取一个 URL 的原始内容（带超时），用于枚举链接 / 探测登录。
async function rawFetch(
  url: string,
  timeoutMs = 20000,
): Promise<{ ok: boolean; status: number; contentType: string; body: string; finalUrl: string }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
      signal: ctrl.signal,
    })
    const contentType = res.headers.get("content-type") || ""
    // 只读文本类内容；二进制不读 body（避免大文件）
    let body = ""
    if (contentType.includes("html") || contentType.includes("xml") || contentType.includes("json") || contentType.includes("text")) {
      body = await res.text()
    }
    return { ok: res.ok, status: res.status, contentType, body, finalUrl: res.url }
  } catch {
    return { ok: false, status: 0, contentType: "", body: "", finalUrl: url }
  } finally {
    clearTimeout(t)
  }
}

// 从 HTML / sitemap 中提取候选链接（href、loc）。纯结构提取，不做语义判断。
function extractRawLinks(base: string, body: string, contentType: string): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = []
  const seen = new Set<string>()
  const push = (href: string, title: string) => {
    const abs = absolutize(base, href)
    if (!abs) return
    // 去掉 fragment
    const clean = abs.split("#")[0]
    if (seen.has(clean)) return
    seen.add(clean)
    out.push({ url: clean, title: title.trim().slice(0, 160) })
  }

  if (contentType.includes("xml") || body.includes("<urlset") || body.includes("<sitemapindex")) {
    // sitemap：提取 <loc>
    for (const m of body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      push(m[1], "")
    }
    return out
  }

  // HTML：提取 <a href>，标题取链接文本
  for (const m of body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1]
    if (href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) continue
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
    push(href, text)
  }
  return out
}

// 文件扩展名推断
function guessExt(url: string): string {
  const clean = url.split("?")[0].split("#")[0]
  const m = clean.match(/\.([a-z0-9]{1,6})$/i)
  return m ? "." + m[1].toLowerCase() : ""
}

// ============ 1) 站点分诊 ============
// 抓取首页 + 探测 sitemap，让 Gemini 判断站点类型、是否需要登录、遍历策略。
export async function classifySite(rootUrl: string): Promise<KbCrawlSite> {
  const home = await rawFetch(rootUrl)
  // 探测常见 sitemap
  let sitemapHint = ""
  try {
    const origin = new URL(rootUrl).origin
    const sm = await rawFetch(origin + "/sitemap.xml", 12000)
    if (sm.ok && (sm.body.includes("<urlset") || sm.body.includes("<sitemapindex"))) {
      const count = (sm.body.match(/<loc>/g) || []).length
      sitemapHint = `存在 sitemap.xml，约 ${count} 个 URL。`
    }
  } catch {
    // 忽略
  }

  // 登录线索：页面文本中的关键词 + set-cookie 会话
  const loginSignals = /登录|登陆|sign\s?in|log\s?in|账号|账户|password|登錄|회원|ログイン/i.test(home.body)
    ? "页面包含登录相关字样。"
    : ""

  const sample = home.body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 3000)

  const out = await geminiJson<{
    siteKind: SiteKind
    requiresLogin: boolean
    summary: string
    strategy: string
  }>(
    `你是网站分诊专家。请判断下面这个站点的类型，不要臆测。\n` +
      `URL：${rootUrl}\n` +
      `HTTP 状态：${home.status}，Content-Type：${home.contentType}\n` +
      `${sitemapHint}\n${loginSignals}\n` +
      `页面文本样本（已去标签，截断）：\n"""${sample}"""\n\n` +
      `请返回：\n` +
      `- siteKind：wiki(文档/百科) | open_download(开放下载站) | login_download(需登录下载站) | generic(普通网页) | unknown\n` +
      `- requiresLogin：下载其内容是否需要登录\n` +
      `- summary：一句话概述该站点是什么、有什么内容\n` +
      `- strategy：用一两句中文描述应如何遍历它（如"用 sitemap 枚举全部页面再按需抓取"/"逐层读取目录页提取文件链接"）`,
    {
      type: "OBJECT",
      properties: {
        siteKind: { type: "STRING" },
        requiresLogin: { type: "BOOLEAN" },
        summary: { type: "STRING" },
        strategy: { type: "STRING" },
      },
      required: ["siteKind", "requiresLogin", "summary", "strategy"],
    },
    { thinking: "adaptive" },
  )

  return {
    id: rid("crawl"),
    rootUrl,
    siteKind: out.siteKind,
    requiresLogin: out.requiresLogin,
    summary: out.summary,
    strategy: out.strategy,
    links: [],
    updatedAt: Date.now(),
  }
}

// ============ 2) 快速遍历枚举 ============
// 根据站点类型选择枚举方式：
//  - wiki：优先 sitemap 全量枚举；无 sitemap 则抓首页链接
//  - 下载站/普通：抓目录页/首页链接（可逐层，由 maxDepth 控制）
export async function enumerateSite(
  site: KbCrawlSite,
  opts: { maxLinks?: number; maxDepth?: number } = {},
): Promise<KbCrawlLink[]> {
  const maxLinks = opts.maxLinks ?? 2000
  const maxDepth = opts.maxDepth ?? 1
  const origin = new URL(site.rootUrl).origin
  const collected = new Map<string, { url: string; title: string }>()

  // wiki 优先 sitemap
  if (site.siteKind === "wiki") {
    const sm = await rawFetch(origin + "/sitemap.xml")
    if (sm.ok && (sm.body.includes("<urlset") || sm.body.includes("<sitemapindex"))) {
      // sitemapindex：再抓子 sitemap（最多前几个，避免过量）
      if (sm.body.includes("<sitemapindex")) {
        const subs = extractRawLinks(origin, sm.body, "xml").slice(0, 10)
        for (const s of subs) {
          const sub = await rawFetch(s.url)
          for (const l of extractRawLinks(origin, sub.body, "xml")) {
            if (collected.size >= maxLinks) break
            collected.set(l.url, l)
          }
        }
      } else {
        for (const l of extractRawLinks(origin, sm.body, "xml")) {
          if (collected.size >= maxLinks) break
          collected.set(l.url, l)
        }
      }
    }
  }

  // 没有从 sitemap 拿到（或非 wiki）：BFS 抓目录/首页链接
  if (collected.size === 0) {
    let frontier = [site.rootUrl]
    const visited = new Set<string>()
    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: string[] = []
      await mapLimit(frontier, 5, async (u) => {
        if (visited.has(u) || collected.size >= maxLinks) return
        visited.add(u)
        const r = await rawFetch(u)
        const links = extractRawLinks(r.finalUrl || u, r.body, r.contentType)
        for (const l of links) {
          // 只跟随同源链接
          if (!l.url.startsWith(origin)) continue
          if (collected.size >= maxLinks) break
          collected.set(l.url, l)
          // 子目录用于下一层遍历（以 / 结尾或无扩展名视作目录/页面）
          if (depth < maxDepth && !guessExt(l.url)) next.push(l.url)
        }
      })
      frontier = next
    }
  }

  // JS 渲染降级：若静态 HTML 枚举结果过少（典型如 layui/SPA 下载站，文件列表由 JS 动态加载），
  // 用 Gemini url_context 读取渲染后的目录页，提取文件/子目录链接。
  if (collected.size <= 2) {
    try {
      const rendered = await extractLinksViaLLM(site.rootUrl)
      for (const l of rendered) {
        if (collected.size >= maxLinks) break
        const abs = absolutize(site.rootUrl, l.url)
        if (abs) collected.set(abs.split("#")[0], { url: abs.split("#")[0], title: l.title })
      }
    } catch {
      // 忽略，保留已有结果
    }
  }

  // 转成 KbCrawlLink（先不分类，action 待 selectLinks 决定）
  const links: KbCrawlLink[] = Array.from(collected.values()).map((l) => {
    const ext = guessExt(l.url)
    return {
      id: rid("link"),
      url: l.url,
      title: l.title || l.url,
      kind: ext ? "file" : l.url.endsWith("/") ? "dir" : "page",
      ext: ext || undefined,
      action: "skip",
    }
  })
  return links
}

// 用 Gemini url_context 读取渲染后的页面，提取其中的链接（应对 JS 动态列表）。
// 注意：responseSchema 与 tools 互斥，故这里让模型直接以 Markdown 列表输出「标题 | URL」，再用正则解析。
async function extractLinksViaLLM(
  url: string,
): Promise<Array<{ url: string; title: string }>> {
  const text = await geminiUrlContext(
    url,
    "这个页面可能由 JavaScript 动态渲染（文件列表/目录页）。" +
      "请提取页面上所有可见的文件下载链接、子目录链接、文档条目链接，忽略导航/页脚/广告/社交分享。" +
      "严格按每行一条输出，格式为：标题 ||| 绝对URL。不要输出其它任何内容。",
  )
  const out: Array<{ url: string; title: string }> = []
  for (const line of text.split("\n")) {
    const idx = line.indexOf("|||")
    if (idx === -1) continue
    const title = line.slice(0, idx).trim().replace(/^[-*\d.\s]+/, "")
    const u = line.slice(idx + 3).trim().replace(/[)\]]+$/, "")
    if (/^https?:\/\//i.test(u)) out.push({ url: u, title })
  }
  return out
}

// ============ 3) AI 按用户目标选取 + 分类动作 ============
// 把枚举到的链接（可能上千条）交给 Gemini，按用户提示词目标挑出相关的，
// 并为每条判定处理动作（fetch / server_download / manual_download / traverse / skip）。
export async function selectLinks(
  site: KbCrawlSite,
  links: KbCrawlLink[],
  userPrompt: string,
  maxPick: number,
): Promise<KbCrawlLink[]> {
  if (links.length === 0) return []

  // 分批送（每批 80 条），避免超长上下文
  const BATCH = 80
  const batches: KbCrawlLink[][] = []
  for (let i = 0; i < links.length; i += BATCH) batches.push(links.slice(i, i + BATCH))

  const decided: KbCrawlLink[] = []
  await mapLimit(batches, 4, async (batch) => {
    const listing = batch
      .map((l, i) => `${i}. [${l.kind}${l.ext ? " " + l.ext : ""}] ${l.title} -> ${l.url}`)
      .join("\n")

    const out = await geminiJson<{
      items: Array<{ index: number; action: LinkAction; relevance: number; note: string }>
    }>(
      `用户的知识库目标：「${userPrompt || "通用整理"}」。\n` +
        `站点类型：${site.siteKind}，是否需要登录下载：${site.requiresLogin}。\n` +
        `下面是从该站枚举到的一批链接。请为每条判定：\n` +
        `- action：fetch(网页/PDF等可在线抓取识别) | server_download(开放且无需登录的二进制文件，服务端可直接下载) | ` +
        `manual_download(需登录或无法在线识别，需用户在浏览器端下载) | traverse(子目录/列表页，需进一步遍历) | skip(无关)\n` +
        `- relevance：与用户目标的相关性 0-1\n` +
        `- note：一句话中文说明\n` +
        `判定原则：若站点需要登录，其文件类链接多为 manual_download；开放下载站的文件用 server_download；` +
        `文档/正文页用 fetch；目录/列表页用 traverse；与目标明显无关的用 skip。\n\n${listing}`,
      {
        type: "OBJECT",
        properties: {
          items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                index: { type: "INTEGER" },
                action: { type: "STRING" },
                relevance: { type: "NUMBER" },
                note: { type: "STRING" },
              },
              required: ["index", "action", "relevance", "note"],
            },
          },
        },
        required: ["items"],
      },
      { thinking: "adaptive" },
    )

    for (const item of out.items) {
      const link = batch[item.index]
      if (!link) continue
      decided.push({
        ...link,
        action: item.action,
        relevance: item.relevance,
        note: item.note,
      })
    }
  })

  // 按相关性排序，保留 action 非 skip 的，截断到 maxPick
  const useful = decided
    .filter((l) => l.action !== "skip")
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
    .slice(0, maxPick)
  return useful
}

// ============ 4) 服务端下载（开放文件）============
// 把一个开放可下载的 URL 保存到项目 downloads/ 目录。返回保存的绝对路径。
export async function downloadToProject(url: string, subdir = ""): Promise<string> {
  const dir = subdir ? path.join(DOWNLOADS_DIR, subdir) : DOWNLOADS_DIR
  await fs.mkdir(dir, { recursive: true })
  // 文件名取 URL 末段，去查询串
  const base = decodeURIComponent(url.split("?")[0].split("/").pop() || "download.bin")
  const safe = base.replace(/[^\w.\-]+/g, "_").slice(0, 180) || "download.bin"
  const dest = path.join(dir, safe)

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 120000)
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`下载失败 ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(dest, buf)
    return dest
  } finally {
    clearTimeout(t)
  }
}

// 在线抓取识别一个网页/文档链接（复用 url_context），返回 Markdown 正文。
export async function fetchLinkContent(url: string): Promise<string> {
  return (
    await geminiUrlContext(
      url,
      "请抓取该网页并把正文完整转写为结构化 Markdown：保留标题层级、列表、表格、代码块；" +
        "剔除导航、页脚、广告。只输出正文本身。",
    )
  ).trim()
}
