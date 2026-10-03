import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  delete (globalThis as any).uni;
});

async function loadImages(downloadFile: (options: any) => void) {
  vi.stubEnv('VITE_API_BASE_URL', 'http://127.0.0.1:3001/api');
  (globalThis as any).uni = { downloadFile };
  vi.resetModules();
  return import('../src/services/images.js');
}

function summary(index: number, overrides: Record<string, string> = {}) {
  return {
    id: `item-${index}`,
    name: `纸袋 ${index}`,
    shelfId: 'shelf-1',
    shelfName: '旅行',
    processingStatus: 'READY' as const,
    thumbnailUrl: `http://127.0.0.1:3001/thumb-${index}.jpg`,
    addedAt: '2026-09-20T08:00:00.000Z',
    updatedAt: '2026-09-20T09:00:00.000Z',
    ...overrides
  };
}

describe('resolveCollectibleThumbnail', () => {
  it('limits local HTTP thumbnail downloads to ten concurrent tasks', async () => {
    let active = 0;
    let maximum = 0;
    const { resolveCollectibleThumbnail } = await loadImages((options) => {
      active += 1;
      maximum = Math.max(maximum, active);
      setTimeout(() => {
        active -= 1;
        options.success({ statusCode: 200, tempFilePath: `tmp://${options.url}` });
      }, 5);
    });

    await Promise.all(Array.from({ length: 15 }, (_, index) => resolveCollectibleThumbnail(summary(index))));

    expect(maximum).toBe(10);
  });

  it('reuses a thumbnail by collectible id and update version', async () => {
    const downloadFile = vi.fn((options) => {
      setTimeout(() => options.success({ statusCode: 200, tempFilePath: 'tmp://shared' }), 0);
    });
    const { resolveCollectibleThumbnail } = await loadImages(downloadFile);
    const first = summary(1);
    const refreshedSignature = summary(1, { thumbnailUrl: 'http://127.0.0.1:3001/thumb-1.jpg?token=new' });

    const [firstPath, secondPath] = await Promise.all([
      resolveCollectibleThumbnail(first),
      resolveCollectibleThumbnail(refreshedSignature)
    ]);

    expect(firstPath).toBe('tmp://shared');
    expect(secondPath).toBe('tmp://shared');
    expect(downloadFile).toHaveBeenCalledOnce();
  });

  it('isolates a failed thumbnail from successful thumbnails', async () => {
    const { resolveCollectibleThumbnail } = await loadImages((options) => {
      setTimeout(() => {
        if (options.url.includes('thumb-1')) options.fail({ errMsg: 'download failed' });
        else options.success({ statusCode: 200, tempFilePath: 'tmp://ok' });
      }, 0);
    });

    const results = await Promise.allSettled([
      resolveCollectibleThumbnail(summary(1)),
      resolveCollectibleThumbnail(summary(2))
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'tmp://ok' });
  });
});
