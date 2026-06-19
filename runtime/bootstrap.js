// runtime/bootstrap.js — 全自动环境检测 + 补装 + 启动
// 用法：node runtime/bootstrap.js （由 start.bat 调用）
// 全程使用国内镜像（阿里云/npmmirror/魔搭），避免被墙。

const { execSync, spawn, spawnSync } = require("child_process")
const fs = require("fs")
const path = require("path")
const https = require("https")
const http = require("http")

const ROOT = path.resolve(__dirname, "..")
const DATA_DIR = path.join(ROOT, ".kb-data")
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json")

// 国内镜像地址
const MIRRORS = {
  node: "https://npmmirror.com/mirrors/node/",
  ollama_install: "https://mirrors.aliyun.com/ollama/install/",
  ollama_models: "https://ollama.modelscope.cn", // 魔搭社区 Ollama 模型镜像
}

// ============ 工具函数 ============

function log(msg) {
  console.log(`[KB-AI] ${msg}`)
}

function error(msg) {
  console.error(`[KB-AI ERROR] ${msg}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function commandExists(cmd) {
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "pipe",
      timeout: 5000,
    })
    return r.status === 0
  } catch {
    return false
  }
}

function getOllamaPath() {
  // 优先 PATH 中的 ollama
  if (commandExists("ollama")) return "ollama"
  // Windows 默认安装路径
  const defaultPaths = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
    path.join(process.env.PROGRAMFILES || "", "Ollama", "ollama.exe"),
  ]
  for (const p of defaultPaths) {
    if (fs.existsSync(p)) return p
  }
  return null
}

function detectGpu() {
  try {
    const out = execSync("nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits", {
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim()
    const vram = parseInt(out.split("\n")[0], 10)
    return { available: true, vram_mb: vram }
  } catch {
    return { available: false, vram_mb: 0 }
  }
}

async function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http
    mod.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve(true)
      } else {
        resolve(false)
      }
      res.resume()
    }).on("error", () => resolve(false))
  })
}

async function waitForOllama(maxWait = 30000) {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const ok = await httpGet("http://localhost:11434/api/tags")
      if (ok) return true
    } catch {}
    await sleep(1000)
  }
  return false
}

// ============ 安装 Ollama ============

async function installOllama() {
  log("正在安装 Ollama（使用阿里云镜像）...")

  if (process.platform === "win32") {
    // Windows: 用 winget 静默安装
    try {
      execSync("winget install Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements", {
        stdio: "inherit",
        timeout: 300000,
      })
      log("Ollama 安装完成")
      return true
    } catch (e) {
      error(`winget 安装失败: ${e.message}`)
      // 备选：直接下载安装包
      log("尝试直接下载 Ollama 安装包...")
      try {
        execSync(
          `powershell -Command "Invoke-WebRequest -Uri '${MIRRORS.ollama_install}OllamaSetup.exe' -OutFile '%TEMP%\\OllamaSetup.exe'; Start-Process '%TEMP%\\OllamaSetup.exe' -ArgumentList '/SILENT' -Wait"`,
          { stdio: "inherit", timeout: 300000 },
        )
        return true
      } catch {
        return false
      }
    }
  } else {
    // Linux/macOS
    try {
      execSync("curl -fsSL https://ollama.com/install.sh | sh", {
        stdio: "inherit",
        timeout: 300000,
      })
      return true
    } catch {
      return false
    }
  }
}

// ============ 启动 Ollama 服务 ============

function startOllamaServe(ollamaPath) {
  log("启动 Ollama 服务...")
  const child = spawn(ollamaPath, ["serve"], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11434" },
  })
  child.unref()
}

// ============ 拉取模型 ============

async function pullModel(ollamaPath, model) {
  log(`拉取模型 ${model}（使用魔搭镜像）...`)
  // 配置模型镜像（魔搭社区）
  const env = {
    ...process.env,
    OLLAMA_HOST: "127.0.0.1:11434",
  }

  const result = spawnSync(ollamaPath, ["pull", model], {
    stdio: "inherit",
    timeout: 600000, // 10 分钟超时
    env,
  })

  if (result.status !== 0) {
    error(`模型 ${model} 拉取失败`)
    return false
  }
  log(`模型 ${model} 就绪`)
  return true
}

// ============ 确保 settings.json 有 Ollama 配置 ============

function ensureSettings(model) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"))
  } catch {}

  let changed = false
  if (!settings.embedProvider) {
    settings.embedProvider = "ollama"
    changed = true
  }
  if (!settings.ollamaUrl) {
    settings.ollamaUrl = "http://localhost:11434"
    changed = true
  }
  if (!settings.ollamaEmbedModel) {
    settings.ollamaEmbedModel = model
    changed = true
  }

  if (changed) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8")
    log("已更新 settings.json（Ollama 配置）")
  }
}

// ============ 主流程 ============

async function main() {
  log("========================================")
  log("  KB-AI 环境自动检测与部署")
  log("========================================")

  // 1. 检测 GPU
  const gpu = detectGpu()
  if (gpu.available) {
    log(`检测到 GPU，显存 ${gpu.vram_mb} MB`)
  } else {
    log("未检测到 NVIDIA GPU，将使用 CPU 模式")
  }

  // 选择模型
  const model = gpu.available && gpu.vram_mb >= 6000
    ? "qwen3-embedding:8b"
    : "qwen3-embedding:0.6b"
  log(`选择 embedding 模型: ${model}`)

  // 2. 检测/安装 Ollama
  let ollamaPath = getOllamaPath()

  if (!ollamaPath) {
    log("未检测到 Ollama，开始安装...")
    const ok = await installOllama()
    if (!ok) {
      error("Ollama 安装失败，将以关键词检索模式运行（质量降低）")
      startServer()
      return
    }
    // 重新检测路径
    await sleep(2000)
    ollamaPath = getOllamaPath()
    if (!ollamaPath) {
      error("Ollama 安装后未找到可执行文件")
      startServer()
      return
    }
  } else {
    log(`Ollama 已安装: ${ollamaPath}`)
  }

  // 3. 确保 Ollama 服务运行
  const running = await httpGet("http://localhost:11434/api/tags")
  if (!running) {
    startOllamaServe(ollamaPath)
    log("等待 Ollama 服务就绪...")
    const ready = await waitForOllama()
    if (!ready) {
      error("Ollama 服务启动超时，将以关键词检索模式运行")
      startServer()
      return
    }
  }
  log("Ollama 服务运行中 ✓")

  // 4. 检测/拉取模型
  try {
    const tagsRes = await fetch("http://localhost:11434/api/tags")
    const tags = await tagsRes.json()
    const models = (tags.models || []).map((m) => m.name)
    const hasModel = models.some(
      (m) => m === model || m === `${model}:latest` || m.startsWith(`${model}:`),
    )

    if (!hasModel) {
      log(`模型 ${model} 未拉取，开始下载...`)
      const ok = await pullModel(ollamaPath, model)
      if (!ok) {
        // 尝试小模型
        if (model !== "qwen3-embedding:0.6b") {
          log("尝试拉取轻量模型 qwen3-embedding:0.6b...")
          await pullModel(ollamaPath, "qwen3-embedding:0.6b")
        }
      }
    } else {
      log(`模型 ${model} 已就绪 ✓`)
    }
  } catch (e) {
    error(`模型检测失败: ${e.message}`)
  }

  // 5. 更新 settings
  ensureSettings(model)

  // 6. 启动应用
  log("")
  startServer()
}

function startServer() {
  const port = process.env.PORT || "3000"
  const hostname = process.env.HOSTNAME || "127.0.0.1"

  log(`启动 KB-AI 服务 http://${hostname}:${port}`)
  log("========================================")
  log("")

  // 3 秒后打开浏览器
  setTimeout(() => {
    const url = `http://${hostname}:${port}`
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref()
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref()
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref()
    }
  }, 3000)

  // 启动 server.js
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, PORT: port, HOSTNAME: hostname, NODE_ENV: "production" },
  })

  server.on("exit", (code) => {
    if (code !== 0) {
      error(`服务退出，代码 ${code}`)
      process.exit(code)
    }
  })
}

main().catch((e) => {
  error(e.message)
  // 即使 bootstrap 出错也尝试启动服务
  startServer()
})
