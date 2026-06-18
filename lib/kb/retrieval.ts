// 工业级本地关键词检索：BM25 + 短语精确匹配加权 + MMR 多样性去重。
// 在嵌入向量不可用时作为主检索（当前第三方中转不提供向量服务即走此路径），
// 质量远高于简单的词重合计数。全部在内存本地计算，无外部依赖。

export interface ScoredText {
  text: string
  score: number
}

// 分词：英文/型号按字母数字串；中文按相邻双字（bigram）。bigram 能近似短语匹配，
// 比单字更精准（“逻辑”“辑单”…），同时保留连续 ASCII 词（如 LUT、FPGA、gemini-3.5）。
export function tokenize(s: string): string[] {
  const lower = s.toLowerCase()
  const tokens: string[] = []
  for (const m of lower.match(/[a-z0-9]+/g) ?? []) {
    if (m.length >= 2) tokens.push(m)
  }
  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens
}

interface Doc {
  idx: number
  tokens: string[]
  tf: Map<string, number>
  len: number
}

// BM25 检索器：预处理一组文档，支持按查询打分。
export class Bm25 {
  private docs: Doc[]
  private df = new Map<string, number>()
  private avgLen = 0
  private readonly k1 = 1.5
  private readonly b = 0.75

  constructor(texts: string[]) {
    this.docs = texts.map((t, idx) => {
      const tokens = tokenize(t)
      const tf = new Map<string, number>()
      for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1)
      return { idx, tokens, tf, len: tokens.length }
    })
    for (const d of this.docs) {
      for (const term of d.tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1)
    }
    const totalLen = this.docs.reduce((n, d) => n + d.len, 0)
    this.avgLen = this.docs.length > 0 ? totalLen / this.docs.length : 0
  }

  private idf(term: string): number {
    const n = this.docs.length
    const df = this.df.get(term) ?? 0
    // BM25 IDF（带平滑），罕见词权重更高
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  // 对单个文档按查询词计算 BM25 分
  score(queryTokens: string[], doc: Doc): number {
    let s = 0
    for (const qt of queryTokens) {
      const tf = doc.tf.get(qt)
      if (!tf) continue
      const idf = this.idf(qt)
      const denom = tf + this.k1 * (1 - this.b + (this.b * doc.len) / (this.avgLen || 1))
      s += idf * ((tf * (this.k1 + 1)) / denom)
    }
    return s
  }

  getDoc(idx: number): Doc {
    return this.docs[idx]
  }

  get size(): number {
    return this.docs.length
  }
}

// 两个 token 集合的 Jaccard 相似度（用于 MMR 去冗余）
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// 归一化文本用于短语精确匹配（去多余空白、小写）
function normalizePhrase(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim()
}

// 主检索：BM25 打底 + 短语精确匹配加权，再用 MMR 在相关性与多样性间平衡选出 topK。
// 返回命中的文档下标与综合得分（已归一到 0~1 区间附近，便于阈值判断）。
export function keywordSearch(
  query: string,
  texts: string[],
  topK = 8,
  opts: { mmrLambda?: number; phraseBoost?: number } = {},
): { index: number; score: number }[] {
  if (texts.length === 0) return []
  const mmrLambda = opts.mmrLambda ?? 0.7 // 越大越偏相关性，越小越偏多样性
  const phraseBoost = opts.phraseBoost ?? 0.5

  const bm25 = new Bm25(texts)
  const qTokens = tokenize(query)
  if (qTokens.length === 0) {
    // 查询无有效 token：返回前 topK 兜底
    return texts.slice(0, topK).map((_, i) => ({ index: i, score: 0 }))
  }

  const phrase = normalizePhrase(query)
  const phraseOk = phrase.length >= 2

  // 1) 计算每个文档的基础分（BM25 + 短语命中加权）
  const raw: { index: number; base: number; tokens: Set<string> }[] = []
  let maxBase = 0
  for (let i = 0; i < texts.length; i++) {
    const doc = bm25.getDoc(i)
    let base = bm25.score(qTokens, doc)
    if (phraseOk && normalizePhrase(texts[i]).includes(phrase)) {
      base += phraseBoost * (1 + base) // 整段命中查询短语，显著加权
    }
    maxBase = Math.max(maxBase, base)
    raw.push({ index: i, base, tokens: new Set(doc.tokens) })
  }

  if (maxBase === 0) {
    // 完全无命中：返回前 topK 兜底，保证总有上下文
    return texts.slice(0, topK).map((_, i) => ({ index: i, score: 0 }))
  }

  // 归一化基础分
  for (const r of raw) r.base = r.base / maxBase

  // 2) MMR 选择：兼顾相关性与多样性，避免返回近重复块
  const candidates = raw.filter((r) => r.base > 0).sort((a, b) => b.base - a.base)
  // 仅在较优候选中做 MMR（控制计算量）
  const pool = candidates.slice(0, Math.max(topK * 4, 20))
  const selected: { index: number; score: number; tokens: Set<string> }[] = []

  while (selected.length < topK && pool.length > 0) {
    let bestI = -1
    let bestVal = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i]
      let maxSim = 0
      for (const sel of selected) {
        maxSim = Math.max(maxSim, jaccard(cand.tokens, sel.tokens))
      }
      const mmr = mmrLambda * cand.base - (1 - mmrLambda) * maxSim
      if (mmr > bestVal) {
        bestVal = mmr
        bestI = i
      }
    }
    if (bestI === -1) break
    const chosen = pool.splice(bestI, 1)[0]
    selected.push({ index: chosen.index, score: chosen.base, tokens: chosen.tokens })
  }

  return selected.map((s) => ({ index: s.index, score: s.score }))
}
