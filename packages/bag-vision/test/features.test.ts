import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { BAG_FEATURE_DIM, cosineSimilarity, extractBagFeature } from '../src/index.js';

/** 程序化造图，避免测试依赖外部素材。 */
function solid(size: number, background: { r: number; g: number; b: number }) {
  return sharp({ create: { width: size, height: size, channels: 3, background } }).png().toBuffer();
}

const RED = { r: 200, g: 24, b: 24 };
const BLUE = { r: 24, g: 48, b: 200 };
const WHITE = { r: 255, g: 255, b: 255 };

const norm = (vector: Float32Array) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

describe('extractBagFeature', () => {
  it('产出声明维度的单位向量', async () => {
    const vector = await extractBagFeature(await solid(96, RED));
    expect(vector).toHaveLength(BAG_FEATURE_DIM);
    expect(norm(vector)).toBeCloseTo(1, 5);
  });

  it('确定性：同一张图两次提取得到完全相同的向量', async () => {
    const source = await solid(96, RED);
    const [a, b] = await Promise.all([extractBagFeature(source), extractBagFeature(source)]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('跨分辨率稳定：同一只袋子拍出的像素尺寸不同，不该被判成两只', async () => {
    const [small, large] = await Promise.all([
      extractBagFeature(await solid(80, RED)),
      extractBagFeature(await solid(320, RED))
    ]);
    expect(cosineSimilarity(small, large)).toBeGreaterThan(0.95);
  });

  it('能区分不同颜色', async () => {
    const [red, blue] = await Promise.all([
      extractBagFeature(await solid(96, RED)),
      extractBagFeature(await solid(96, BLUE))
    ]);
    expect(cosineSimilarity(red, blue)).toBeLessThan(0.9);
  });

  it('整张图都是背景时给出哨兵向量，而不是 NaN', async () => {
    // 纯白图没有任何可用信号：必须返回确定的向量，
    // 否则一旦产生 NaN，整轮相似度排序都会被带崩。
    const vector = await extractBagFeature(await solid(64, WHITE));
    expect(vector.every((value) => Number.isFinite(value))).toBe(true);
    expect(vector[0]).toBe(1);
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 5);
  });
});
