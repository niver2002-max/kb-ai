// 知识库核心类型定义

export type SourceKind = "file" | "web"

// 文件 / 网页的大分类，由扫描阶段推断
export type SourceCategory =
  | "document" // 文本型文档：txt/md/pdf(文本层)/docx
  | "webpage" // 网页抓取
  | "code" // 源代码
  | "data" // 结构化数据：json/csv
  | "image" // 图片型文件（含扫描件，需视觉分析）
  | "binary" // 无法直接解析的二进制
  | "unknown"

export type SourceStatus =
  | "discovered" // 已发现，未处理
  | "queued" // 已排队等待构建
  | "parsing" // 解析中
  | "embedded" // 已切块并入库
  | "skipped" // 被筛选跳过
  | "error" // 处理失败

export interface KbSource {
  id: string
  kind: SourceKind
  // 文件用绝对路径；网页用 URL
  location: string
  name: string
  category: SourceCategory
  ext: string
  sizeBytes: number
  status: SourceStatus
  // 解析得到的纯文本长度
  charCount?: number
  chunkCount?: number
  error?: string
  // LLM 初筛给出的相关性/重要性（0-1）与一句话说明
  relevance?: number
  note?: string
  updatedAt: number
}

export interface KbChunk {
  id: string
  sourceId: string
  // 在该来源内的序号
  index: number
  text: string
  // 来源定位信息（页码 / 段落等），用于引用溯源
  loc?: string
  embedding: number[]
}

// ===== 多阶段自适应构建流程（human-in-the-loop）=====

// 工作流所处阶段
export type WorkflowStage =
  | "idle" // 尚未开始
  | "scanned" // 已扫描 + 初筛，已生成第一批问题，等待用户回答
  | "built" // 已二筛 + 建目录 + 精细化，已生成第一份报告与第二批问题，等待回答
  | "reviewing" // 已生成第二份报告，等待用户验收
  | "ready" // 验收通过，进入对话提升模式

// 一道选择题（支持单选 / 多选）
export interface KbQuestion {
  id: string
  question: string
  options: string[]
  multiSelect: boolean
  answer?: string[] // 用户的选择（保存所选 option 文本）
  freeText?: string // 用户的补充说明（可选）
}

// 一轮问答
export interface KbQuestionRound {
  round: number
  intro: string // LLM 对本轮提问的说明 / 初筛或报告概述
  questions: KbQuestion[]
  answeredAt?: number
}

// 一份阶段报告
export interface KbReport {
  round: number
  markdown: string
  createdAt: number
}

// 知识库目录树中的一个分类
export interface KbCategory {
  id: string
  name: string
  description: string
  sourceIds: string[]
}

// 整个构建工作流的状态
export interface KbWorkflow {
  stage: WorkflowStage
  userPrompt: string // 用户的总体目标 / 提示词
  rounds: KbQuestionRound[]
  reports: KbReport[]
  categories: KbCategory[] // 二筛后构建的知识库目录树
  busy?: string // 正在进行的后台动作描述（用于 UI 显示）
  updatedAt: number
}

// ===== 站点智能抓取（运行时由 Gemini 分诊，不按 URL 写死）=====

// 站点类型：由 Gemini 在运行时分诊得出
export type SiteKind =
  | "wiki" // 文档/百科类，正文可直接在线识别
  | "open_download" // 开放下载站，文件无需登录即可下载
  | "login_download" // 需登录的下载站
  | "generic" // 普通网页/其它
  | "unknown"

// 一条被发现的链接及其处理判定
export type LinkAction =
  | "fetch" // 可在线抓取识别（网页/PDF 等）
  | "server_download" // 服务端可直接下载（开放二进制文件）
  | "manual_download" // 需用户在浏览器端下载（受登录保护或无法在线识别）
  | "traverse" // 子目录/子页面，需继续遍历
  | "skip" // 与目标无关，跳过

export interface KbCrawlLink {
  id: string
  url: string
  title: string
  // 链接指向的内容类型推断
  kind: "page" | "file" | "dir"
  ext?: string
  action: LinkAction
  relevance?: number // 0-1，AI 按提示词目标评估
  note?: string
  // 处理状态
  picked?: boolean // 用户是否勾选
  ingested?: boolean // 是否已抓取入库
  downloaded?: boolean // 是否已下载到项目目录
}

// 一次站点抓取会话
export interface KbCrawlSite {
  id: string
  rootUrl: string
  siteKind: SiteKind
  requiresLogin: boolean
  // 登录页 URL（requiresLogin 时由分诊给出，供服务端登录）
  loginUrl?: string
  // 是否已在服务端登录该站点（本次运行内）
  loggedIn?: boolean
  // 分诊说明 + 采用的遍历策略描述
  summary: string
  strategy: string
  links: KbCrawlLink[]
  busy?: string
  updatedAt: number
}

export interface KbIndex {
  // 知识库元信息
  rootDir: string | null
  createdAt: number
  updatedAt: number
  embeddingModel: string
  sources: KbSource[]
  chunks: KbChunk[]
  workflow: KbWorkflow
  crawls: KbCrawlSite[]
}

export interface ScanResult {
  rootDir: string
  sources: KbSource[]
  totalSize: number
}

// ===== 多知识库（每库 = 独立目录 + 独立 git + 独立会话 + 独立索引）=====

// 后台自迭代任务类型
export type AutoIterateTask =
  | "notes" // 生成/补全笔记与摘要
  | "gaps" // 找知识缺口并联网补充
  | "reindex" // 重建索引 / 去重 / 优化分类

// 后台自迭代配置（默认关闭，开启会持续消耗 token）
export interface AutoIterateConfig {
  enabled: boolean // 总开关，默认 false
  tasks: AutoIterateTask[] // 要执行的任务（轮流执行）
  intervalMinutes: number // 两次迭代最小间隔
  idleMinutes: number // 多久无前台互动才算"空闲"可迭代
  lastRunAt?: number // 上次迭代时间
  lastTaskIndex?: number // 上次执行到的任务下标（用于轮转）
  lastResult?: string // 上次迭代结果摘要（UI 展示）
  running?: boolean // 是否正在迭代
}

// 知识库元信息（保存在 libraries.json 的注册表里，也冗余存一份在库目录）
export interface KbLibrary {
  id: string
  title: string // 标题
  audience: string // 主要面向什么 / 用途
  rootDir: string // 知识库根目录（绝对路径）
  hasGit: boolean // 是否已 git init
  initialized: boolean // 目录分层 + 初始化是否完成
  // 无资料口头建库：标记是否走联网检索建库
  sourceMode: "materials" | "web" | "mixed"
  // 后台自迭代配置（可选，缺省视为关闭）
  autoIterate?: AutoIterateConfig
  // 最近一次前台互动时间（用于空闲判定）
  lastActiveAt?: number
  createdAt: number
  updatedAt: number
}

// ===== 持久化主会话（Gemini 无状态，持久化与压缩由我们实现）=====

export type ChatRole = "user" | "assistant" | "system"

export interface KbMessage {
  id: string
  role: ChatRole
  content: string
  // 本条回答引用到的来源 chunk（用于溯源展示）
  citations?: Array<{ sourceId: string; name: string; loc?: string }>
  // @某层级：本条消息限定的检索范围（分类 id 或来源 id）
  scope?: { type: "category" | "source"; id: string; label: string } | null
  createdAt: number
}

export interface KbSession {
  libraryId: string
  messages: KbMessage[]
  // 滚动摘要：把超出窗口的旧对话压缩成一段不断更新的摘要
  rollingSummary: string
  // 已被纳入摘要的消息条数（之前的消息不再逐条发送给模型）
  summarizedCount: number
  updatedAt: number
}
