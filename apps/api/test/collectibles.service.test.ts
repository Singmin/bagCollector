import { describe, expect, it, vi } from 'vitest';
import { CollectiblesService } from '../src/collectibles/collectibles.service.js';

describe('CollectiblesService.list', () => {
  it('returns lightweight summaries, a stable total, and batch-loads thumbnail assets', async () => {
    const first = {
      id: 'collectible-1',
      name: '纸袋一号',
      shelfId: 'shelf-1',
      processingStatus: 'READY',
      addedAt: new Date('2026-09-20T08:00:00.000Z'),
      updatedAt: new Date('2026-09-20T09:00:00.000Z'),
      shelf: { name: '旅行' },
      imageAssets: [{ objectKey: 'thumb/one.jpg' }]
    };
    const second = {
      ...first,
      id: 'collectible-2',
      name: '纸袋二号',
      addedAt: new Date('2026-09-19T08:00:00.000Z'),
      imageAssets: []
    };
    const prisma = {
      collectible: {
        findMany: vi.fn().mockResolvedValue([first, second]),
        count: vi.fn().mockResolvedValue(7)
      }
    };
    const assets = {
      signedUrlForObjectKey: vi.fn().mockResolvedValue('https://assets.example/thumb-one.jpg'),
      urlsByKind: vi.fn()
    };
    const service = new CollectiblesService(prisma as any, assets as any, {} as any);

    const result = await service.list('user-1', {
      cursor: '2026-09-21T00:00:00.000Z',
      limit: 1
    });

    expect(result).toEqual({
      items: [{
        id: 'collectible-1',
        name: '纸袋一号',
        shelfId: 'shelf-1',
        shelfName: '旅行',
        quantity: 1,
        visibility: 'PUBLIC',
        processingStatus: 'READY',
        thumbnailUrl: 'https://assets.example/thumb-one.jpg',
        addedAt: '2026-09-20T08:00:00.000Z',
        updatedAt: '2026-09-20T09:00:00.000Z'
      }],
      nextCursor: '2026-09-20T08:00:00.000Z',
      totalCount: 7
    });
    expect(assets.signedUrlForObjectKey).toHaveBeenCalledOnce();
    expect(assets.urlsByKind).not.toHaveBeenCalled();
    expect(prisma.collectible.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        imageAssets: expect.objectContaining({ take: 1 })
      })
    }));
    expect(prisma.collectible.count.mock.calls[0][0].where).not.toHaveProperty('addedAt');
  });

  it('keeps an item without a thumbnail instead of failing the whole page', async () => {
    const prisma = {
      collectible: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'collectible-1',
          name: '等待缩略图',
          shelfId: 'shelf-1',
          processingStatus: 'READY',
          addedAt: new Date('2026-09-20T08:00:00.000Z'),
          updatedAt: new Date('2026-09-20T09:00:00.000Z'),
          shelf: { name: '默认架' },
          imageAssets: []
        }]),
        count: vi.fn().mockResolvedValue(1)
      }
    };
    const assets = { signedUrlForObjectKey: vi.fn(), urlsByKind: vi.fn() };
    const service = new CollectiblesService(prisma as any, assets as any, {} as any);

    const result = await service.list('user-1', {});

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty('thumbnailUrl');
    expect(result.items[0]).not.toHaveProperty('displayImageUrl');
    expect(result.items[0]).not.toHaveProperty('standardImageUrl');
    expect(assets.signedUrlForObjectKey).not.toHaveBeenCalled();
  });

  it('matches the shelf name in search, so a brand keyword still finds its bags', async () => {
    const prisma = {
      collectible: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0)
      }
    };
    const service = new CollectiblesService(
      prisma as any,
      { signedUrlForObjectKey: vi.fn(), urlsByKind: vi.fn() } as any,
      {} as any
    );

    await service.list('user-1', { search: '瑞幸' });

    const where = prisma.collectible.count.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      { shelf: { name: { contains: '瑞幸', mode: 'insensitive' } } }
    ]));
  });
});
