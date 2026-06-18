import { promises as fs } from "node:fs"
import path from "node:path"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import type { KbLibrary } from "./types"
import { DATA_DIR, deleteIndexData } from "./store"

const execAsync = promisify(exec)

// 多库注册表：.kb-data/libraries.json
const REGISTRY_FILE = path.join(DATA_DIR, "libraries.json")

function rid(): string {
  return `lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

let writeChain: Promise<unknown> = Promise.resolve()

export async function listLibraries(): Promise<KbLibrary[]> {
  try {
    const raw = await fs.readFile(REGISTRY_FILE, "utf8")
    const libs = JSON.parse(raw) as KbLibrary[]
    return Array.isArray(libs) ? libs.sort((a, b) => b.updatedAt - a.updatedAt) : []
  } catch {
    return []
  }
}

async function writeRegistry(libs: KbLibrary[]): Promise<void> {
  writeChain = writeChain.then(async () => {
    await ensureDataDir()
    const tmp = REGISTRY_FILE + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(libs, null, 2), "utf8")
    await fs.rename(tmp, REGISTRY_FILE)
  })
  await writeChain
}

export async function getLibrary(id: string): Promise<KbLibrary | null> {
  const libs = await listLibraries()
  return libs.find((l) => l.id === id) ?? null
}

export async function createLibrary(input: {
  title: string
  audience: string
  rootDir: string
  sourceMode: KbLibrary["sourceMode"]
}): Promise<KbLibrary> {
  const libs = await listLibraries()
  const lib: KbLibrary = {
    id: rid(),
    title: input.title.trim() || "未命名知识库",
    audience: input.audience.trim(),
    rootDir: input.rootDir.trim(),
    hasGit: false,
    initialized: false,
    sourceMode: input.sourceMode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  libs.push(lib)
  await writeRegistry(libs)
  return lib
}

export async function patchLibrary(
  id: string,
  patch: Partial<KbLibrary>,
): Promise<KbLibrary | null> {
  const libs = await listLibraries()
  const i = libs.findIndex((l) => l.id === id)
  if (i < 0) return null
  libs[i] = { ...libs[i], ...patch, id, updatedAt: Date.now() }
  await writeRegistry(libs)
  return libs[i]
}

export async function deleteLibrary(id: string): Promise<void> {
  const libs = await listLibraries()
  await writeRegistry(libs.filter((l) => l.id !== id))
  await deleteIndexData(id)
}

// 知识库标准目录分层
const SUBDIRS = ["sources", "raw", "imports", "exports", "notes"]

// 初始化知识库目录：建立分层结构 + README + 可选 git init
export async function initLibraryDir(
  lib: KbLibrary,
): Promise<{ hasGit: boolean }> {
  // 1) 建根目录与分层子目录
  await fs.mkdir(lib.rootDir, { recursive: true })
  for (const sub of SUBDIRS) {
    await fs.mkdir(path.join(lib.rootDir, sub), { recursive: true })
  }

  // 2) 写 README（知识库说明）
  const readme = `# ${lib.title}

> 面向：${lib.audience || "（未填写）"}

本目录由本地知识库工具自动初始化。

## 目录结构
- \`sources/\`  已纳入知识库的整理后资料
- \`raw/\`      原始未处理材料
- \`imports/\`  导入暂存（单文件/抓取下载落地）
- \`exports/\`  导出内容
- \`notes/\`    对话沉淀的笔记

创建时间：${new Date(lib.createdAt).toLocaleString()}
`
  await fs.writeFile(path.join(lib.rootDir, "README.md"), readme, "utf8")

  // 3) git init（若环境可用）
  let hasGit = false
  try {
    await fs.writeFile(
      path.join(lib.rootDir, ".gitignore"),
      ".DS_Store\n*.tmp\n",
      "utf8",
    )
    await execAsync("git init && git add -A && git commit -m 'init knowledge base'", {
      cwd: lib.rootDir,
      timeout: 30000,
    })
    hasGit = true
  } catch {
    // git 不可用则跳过（不影响主流程）
    hasGit = false
  }

  return { hasGit }
}
