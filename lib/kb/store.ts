import { promises as fs } from "node:fs"
import path from "node:path"
import type {
  KbIndex,
  KbSource,
  KbChunk,
  KbWorkflow,
  KbCrawlSite,
  KbCrawlLink,
} from "./types"

// 知识库数据全部存放在项目根目录下的 .kb-data 文件夹（纯本地，无需任何云数据库）
const DATA_DIR = path.join(process.cwd(), ".kb-data")
const INDEX_FILE = path.join(DATA_DIR, "index.json")

// 向量模型走 Gemini 原生端点（见 lib/kb/gemini.ts）
const EMBEDDING_MODEL = "gemini-embedding-001"

export function emptyWorkflow(): KbWorkflow {
  return {
    stage: "idle",
    userPrompt: "",
    rounds: [],
    reports: [],
    categories: [],
    updatedAt: Date.now(),
  }
}

function emptyIndex(): KbIndex {
  return {
    rootDir: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    embeddingModel: EMBEDDING_MODEL,
    sources: [],
    chunks: [],
    workflow: emptyWorkflow(),
    crawls: [],
  }
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

// 并发写保护：用一个简单的串行队列避免同时写入损坏文件
let writeChain: Promise<unknown> = Promise.resolve()

export async function readIndex(): Promise<KbIndex> {
  try {
    const raw = await fs.readFile(INDEX_FILE, "utf8")
    const parsed = JSON.parse(raw) as KbIndex
    // 兜底字段
    if (!parsed.sources) parsed.sources = []
    if (!parsed.chunks) parsed.chunks = []
    if (!parsed.workflow) parsed.workflow = emptyWorkflow()
    if (!parsed.crawls) parsed.crawls = []
    return parsed
  } catch {
    return emptyIndex()
  }
}

export async function writeIndex(index: KbIndex): Promise<void> {
  index.updatedAt = Date.now()
  writeChain = writeChain.then(async () => {
    await ensureDir()
    // 先写临时文件再原子替换，避免半截写入
    const tmp = INDEX_FILE + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(index), "utf8")
    await fs.rename(tmp, INDEX_FILE)
  })
  await writeChain
}

// 以下为常用的增量更新封装

export async function upsertSources(sources: KbSource[]): Promise<KbIndex> {
  const index = await readIndex()
  const byId = new Map(index.sources.map((s) => [s.id, s]))
  for (const s of sources) byId.set(s.id, s)
  index.sources = Array.from(byId.values())
  await writeIndex(index)
  return index
}

export async function updateSource(
  id: string,
  patch: Partial<KbSource>,
): Promise<void> {
  const index = await readIndex()
  const i = index.sources.findIndex((s) => s.id === id)
  if (i === -1) return
  index.sources[i] = { ...index.sources[i], ...patch, updatedAt: Date.now() }
  await writeIndex(index)
}

// 替换某来源的所有 chunk（重新解析时先删旧再加新）
export async function replaceChunks(
  sourceId: string,
  chunks: KbChunk[],
): Promise<void> {
  const index = await readIndex()
  index.chunks = index.chunks.filter((c) => c.sourceId !== sourceId)
  index.chunks.push(...chunks)
  await writeIndex(index)
}

export async function removeSource(id: string): Promise<void> {
  const index = await readIndex()
  index.sources = index.sources.filter((s) => s.id !== id)
  index.chunks = index.chunks.filter((c) => c.sourceId !== id)
  await writeIndex(index)
}

export async function setRootDir(dir: string): Promise<void> {
  const index = await readIndex()
  index.rootDir = dir
  await writeIndex(index)
}

// 局部更新工作流状态
export async function patchWorkflow(
  patch: Partial<KbWorkflow>,
): Promise<KbWorkflow> {
  const index = await readIndex()
  index.workflow = { ...index.workflow, ...patch, updatedAt: Date.now() }
  await writeIndex(index)
  return index.workflow
}

// 直接读取工作流
export async function readWorkflow(): Promise<KbWorkflow> {
  const index = await readIndex()
  return index.workflow
}

export async function resetIndex(): Promise<void> {
  await writeIndex(emptyIndex())
}

// ===== 站点抓取会话的读写 =====

// 新增或整体替换一个抓取会话（按 id）
export async function upsertCrawl(site: KbCrawlSite): Promise<KbCrawlSite> {
  const index = await readIndex()
  const i = index.crawls.findIndex((c) => c.id === site.id)
  site.updatedAt = Date.now()
  if (i >= 0) index.crawls[i] = site
  else index.crawls.push(site)
  await writeIndex(index)
  return site
}

// 局部更新一个抓取会话
export async function patchCrawl(
  id: string,
  patch: Partial<KbCrawlSite>,
): Promise<KbCrawlSite | null> {
  const index = await readIndex()
  const i = index.crawls.findIndex((c) => c.id === id)
  if (i < 0) return null
  index.crawls[i] = { ...index.crawls[i], ...patch, id, updatedAt: Date.now() }
  await writeIndex(index)
  return index.crawls[i]
}

// 更新某抓取会话内的若干链接（按 link id 合并 patch）
export async function patchCrawlLinks(
  id: string,
  patches: Array<{ id: string } & Partial<KbCrawlLink>>,
): Promise<KbCrawlSite | null> {
  const index = await readIndex()
  const site = index.crawls.find((c) => c.id === id)
  if (!site) return null
  const byId = new Map(patches.map((p) => [p.id, p]))
  site.links = site.links.map((l) => {
    const p = byId.get(l.id)
    return p ? { ...l, ...p, id: l.id } : l
  })
  site.updatedAt = Date.now()
  await writeIndex(index)
  return site
}

export async function readCrawl(id: string): Promise<KbCrawlSite | null> {
  const index = await readIndex()
  return index.crawls.find((c) => c.id === id) ?? null
}

export { EMBEDDING_MODEL }
