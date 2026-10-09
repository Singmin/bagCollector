import { describe, expect, it } from 'vitest';
import { cosineSimilarity, rankBySimilarity } from '../src/index.js';

describe('cosineSimilarity', () => {
  it('同向为 1、正交为 0、反向为 -1', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('零向量不产生 NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('只按重叠长度计算，长度不等不报错', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBeCloseTo(1, 6);
  });
});

describe('rankBySimilarity', () => {
  it('按相似度降序并截取前 k 个', () => {
    const ranked = rankBySimilarity(
      [1, 0],
      [
        { item: 'orthogonal', vector: [0, 1] },
        { item: 'same', vector: [1, 0] },
        { item: 'opposite', vector: [-1, 0] }
      ],
      2
    );
    expect(ranked.map((entry) => entry.item)).toEqual(['same', 'orthogonal']);
    expect(ranked[0]?.score).toBeCloseTo(1, 6);
  });

  it('k 超过条目数时返回全部', () => {
    const ranked = rankBySimilarity([1, 0], [{ item: 'only', vector: [1, 0] }], 5);
    expect(ranked).toHaveLength(1);
  });
});
