import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

const cosEnv = {
  STORAGE_DRIVER: 'cos',
  COS_SECRET_ID: 'secret-id',
  COS_SECRET_KEY: 'secret-key',
  COS_BUCKET: 'bagcollect-1250000000',
  COS_REGION: 'ap-guangzhou'
};

async function loadConfig(overrides: Record<string, string | undefined>) {
  process.env = {
    ...originalEnv,
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...cosEnv,
    ...overrides
  };
  vi.resetModules();
  return import('../src/config.js');
}

describe('worker configuration', () => {
  it('selects 数据万象通用抠图 by default', async () => {
    const { config } = await loadConfig({});
    expect(config.CI_MATTING_PROCESS).toBe('AIPicMatting');
    expect(config.CI_MATTING_SIZE_MODE).toBe('rescale');
    expect(config.CI_MATTING_MAX_CONCURRENCY).toBe(4);
  });

  it('accepts the local storage driver for local development（图片统一代理，仅万象不可用）', async () => {
    const { config } = await loadConfig({ STORAGE_DRIVER: 'local' });
    expect(config.STORAGE_DRIVER).toBe('local');
  });

  it('rejects 数据万象抠图 without COS credentials', async () => {
    await expect(loadConfig({ COS_SECRET_ID: '', COS_SECRET_KEY: '', COS_BUCKET: '' })).rejects.toThrow(
      '数据万象抠图需要 COS_SECRET_ID'
    );
  });

  it('accepts the 商品抠图 interface as an alternative to 通用抠图', async () => {
    const { config } = await loadConfig({ CI_MATTING_PROCESS: 'GoodsMatting', CI_MATTING_SIZE_MODE: 'strict' });
    expect(config.CI_MATTING_PROCESS).toBe('GoodsMatting');
    expect(config.CI_MATTING_SIZE_MODE).toBe('strict');
  });
});
