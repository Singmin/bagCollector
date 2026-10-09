/** 向量比对：匹配接口与（将来的）任何检索场景共用。 */

export type VectorLike = Float32Array | number[];

/**
 * 余弦相似度。
 *
 * 写入库里的向量、以及查询向量都已经 L2 归一化，此时余弦相似度等价于点积；
 * 这里仍然算完整的余弦，是为了让调用方传进未归一化的向量时也能得到正确结果
 * （归一化是提取阶段的内部约定，不该成为比对接口的隐藏前提）。
 */
export function cosineSimilarity(a: VectorLike, b: VectorLike): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA < 1e-12 || normB < 1e-12) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankedCandidate<T> {
  item: T;
  /** 余弦相似度。可能为负（方向相反），调用方按自己的阈值判断。 */
  score: number;
}

/**
 * 按相似度取前 k 个（降序）。
 *
 * 全量线性扫一遍即可：官方袋子是人工维护的规模（百到千级），
 * 几百维向量做一次全量点积是毫秒级，不需要向量索引。
 */
export function rankBySimilarity<T>(
  query: VectorLike,
  entries: { item: T; vector: VectorLike }[],
  k: number
): RankedCandidate<T>[] {
  const scored: RankedCandidate<T>[] = entries.map(({ item, vector }) => ({
    item,
    score: cosineSimilarity(query, vector)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}
