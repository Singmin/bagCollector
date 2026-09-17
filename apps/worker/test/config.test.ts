import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

async function loadConfig(overrides: Record<string, string | undefined>) {
  process.env = {
    ...originalEnv,
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    STORAGE_DRIVER: 'local',
    ...overrides
  };
  vi.resetModules();
  return import('../src/config.js');
}

describe('worker configuration', () => {
  it('requires a rembg URL when rembg is selected', async () => {
    await expect(loadConfig({ MATTING_DRIVER: 'rembg', REMBG_URL: '' })).rejects.toThrow(
      'REMBG_URL is required for rembg matting'
    );
  });

  it('rejects passthrough matting in production', async () => {
    await expect(
      loadConfig({ NODE_ENV: 'production', MATTING_DRIVER: 'passthrough', REMBG_URL: '' })
    ).rejects.toThrow('MATTING_DRIVER cannot be passthrough in production');
  });

  it('loads the pinned local rembg settings', async () => {
    const { config } = await loadConfig({
      MATTING_DRIVER: 'rembg',
      REMBG_URL: 'http://127.0.0.1:7000',
      REMBG_MODEL: 'birefnet-general-lite'
    });
    expect(config.REMBG_MODEL).toBe('birefnet-general-lite');
    expect(config.REMBG_MAX_CONCURRENCY).toBe(1);
    expect(config.REMBG_MAX_RESPONSE_BYTES).toBe(83_886_080);
  });
});
