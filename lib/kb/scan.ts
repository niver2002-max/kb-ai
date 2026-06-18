import { promises as fs } from "node:fs"
import type { Dirent } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import type { KbSource, SourceCategory, ScanResult } from "./types"

// 根据扩展名判断大分类
const EXT_CATEGORY: Record<string, SourceCategory> = {
  ".txt": "document",
  ".md": "document",
  ".markdown": "document",
  ".pdf": "document",
  ".docx": "document",
  ".doc": "document",
  ".rtf": "document",
  ".html": "webpage",
  ".htm": "webpage",
  ".json": "data",
  ".csv": "data",
  ".tsv": "data",
  ".yaml": "data",
  ".yml": "data",
  ".xml": "data",
  ".js": "code",
  ".ts": "code",
  ".tsx": "code",
  ".jsx": "code",
  ".py": "code",
  ".java": "code",
  ".c": "code",
  ".cpp": "code",
  ".h": "code",
  ".go": "code",
  ".rs": "code",
  ".rb": "code",
  ".php": "code",
  ".sh": "code",
  ".sql": "code",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".tiff": "image",
}

// 默认忽略的目录与文件，避免把垃圾扫进来
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".kb-data",
  "dist",
  "build",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
])

function categorize(ext: string): SourceCategory {
  return EXT_CATEGORY[ext.toLowerCase()] ?? "binary"
}

function makeId(location: string): string {
  return createHash("sha1").update(location).digest("hex").slice(0, 16)
}

async function walk(
  dir: string,
  maxDepth: number,
  depth: number,
  out: string[],
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[]
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.isDirectory()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      if (depth < maxDepth) await walk(full, maxDepth, depth + 1, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
}

// 扫描目录，返回每个文件的来源条目（尚未解析）
export async function scanDirectory(
  rootDir: string,
  maxDepth = 6,
): Promise<ScanResult> {
  const abs = path.resolve(rootDir)
  const stat = await fs.stat(abs) // 不存在会抛错，交由上层捕获
  if (!stat.isDirectory()) {
    throw new Error(`路径不是文件夹: ${abs}`)
  }

  const files: string[] = []
  await walk(abs, maxDepth, 0, files)

  const sources: KbSource[] = []
  let totalSize = 0
  for (const file of files) {
    let size = 0
    try {
      size = (await fs.stat(file)).size
    } catch {
      continue
    }
    const ext = path.extname(file)
    const category = categorize(ext)
    totalSize += size
    sources.push({
      id: makeId(file),
      kind: "file",
      location: file,
      name: path.relative(abs, file),
      category,
      ext,
      sizeBytes: size,
      status: "discovered",
      updatedAt: Date.now(),
    })
  }

  // 按分类与名称排序，便于展示
  sources.sort((a, b) => a.name.localeCompare(b.name))
  return { rootDir: abs, sources, totalSize }
}

export function makeWebSource(url: string): KbSource {
  return {
    id: makeId(url),
    kind: "web",
    location: url,
    name: url.replace(/^https?:\/\//, ""),
    category: "webpage",
    ext: ".html",
    sizeBytes: 0,
    status: "discovered",
    updatedAt: Date.now(),
  }
}
