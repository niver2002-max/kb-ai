// 受控并发执行：在保持最多 limit 个任务同时进行的前提下，按输入顺序返回结果。
// 用于并行解析/嵌入/打分等 IO 密集任务，大幅缩短整体耗时，同时避免一次性打爆端点。
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const n = Math.max(1, Math.min(limit, items.length))

  async function run(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }

  await Promise.all(Array.from({ length: n }, () => run()))
  return results
}
