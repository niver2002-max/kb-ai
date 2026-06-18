// 高性能本地向量检索：归一化向量 + Float32 紧凑存储 + Top-K 最小堆。
// 设计取舍：刻意不用 HNSW/原生模块（hnswlib-node 之类需按平台编译，
// 会破坏“ubuntu 构建、Windows 运行”的一键发布包）。改用纯 JS 精确扫描——
// 对单用户本地知识库（数千~数万块）完全够快（数十毫秒级），且精确检索没有 ANN 的召回损失。

// 把原始向量归一化为单位向量并转 Float32（缓存行更友好、内积即余弦）。
function normalize(vec: number[]): Float32Array {
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  const out = new Float32Array(vec.length)
  if (norm === 0) return out
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm
  return out
}

// 两个等长单位向量的内积（即余弦相似度）。
function dot(a: Float32Array, b: Float32Array): number {
  const len = a.length < b.length ? a.length : b.length
  let s = 0
  for (let i = 0; i < len; i++) s += a[i] * b[i]
  return s
}

export interface VectorMatch {
  index: number // 在 build 时传入数组里的下标
  score: number // 余弦相似度 0~1
}

// 一个内存向量索引：构建一次，可多次按查询向量检索 Top-K。
export class VectorIndex {
  private vectors: Float32Array[] = []
  private indices: number[] = [] // 对应原数组下标（跳过空向量后保持映射）

  // embeddings：与原 chunk 数组等长，可能含空向量（嵌入不可用的块）。
  constructor(embeddings: number[][]) {
    for (let i = 0; i < embeddings.length; i++) {
      const e = embeddings[i]
      if (e && e.length > 0) {
        this.vectors.push(normalize(e))
        this.indices.push(i)
      }
    }
  }

  get size(): number {
    return this.vectors.length
  }

  // 检索 Top-K：用定长最小堆维护当前最高的 K 个，避免对全量排序。
  search(queryVec: number[], topK: number): VectorMatch[] {
    if (this.vectors.length === 0 || topK <= 0) return []
    const q = normalize(queryVec)
    const k = Math.min(topK, this.vectors.length)

    // 最小堆（按 score 升序，堆顶为当前 Top-K 中的最小值）
    const heapScore = new Float64Array(k)
    const heapIdx = new Int32Array(k)
    let count = 0

    const siftDown = (start: number) => {
      let root = start
      while (true) {
        let child = root * 2 + 1
        if (child >= count) break
        if (child + 1 < count && heapScore[child + 1] < heapScore[child]) child++
        if (heapScore[root] <= heapScore[child]) break
        const ts = heapScore[root]
        heapScore[root] = heapScore[child]
        heapScore[child] = ts
        const ti = heapIdx[root]
        heapIdx[root] = heapIdx[child]
        heapIdx[child] = ti
        root = child
      }
    }
    const siftUp = (start: number) => {
      let node = start
      while (node > 0) {
        const parent = (node - 1) >> 1
        if (heapScore[parent] <= heapScore[node]) break
        const ts = heapScore[parent]
        heapScore[parent] = heapScore[node]
        heapScore[node] = ts
        const ti = heapIdx[parent]
        heapIdx[parent] = heapIdx[node]
        heapIdx[node] = ti
        node = parent
      }
    }

    for (let v = 0; v < this.vectors.length; v++) {
      const score = dot(q, this.vectors[v])
      if (count < k) {
        heapScore[count] = score
        heapIdx[count] = v
        count++
        siftUp(count - 1)
      } else if (score > heapScore[0]) {
        heapScore[0] = score
        heapIdx[0] = v
        siftDown(0)
      }
    }

    const out: VectorMatch[] = []
    for (let i = 0; i < count; i++) {
      out.push({ index: this.indices[heapIdx[i]], score: heapScore[i] })
    }
    // 堆内非全序，最终按分数降序返回
    out.sort((a, b) => b.score - a.score)
    return out
  }
}
