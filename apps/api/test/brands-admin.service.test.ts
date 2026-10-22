import { describe, expect, it, vi } from 'vitest';
import { BrandsAdminService } from '../src/official-bags/brands-admin.service.js';

function brand(overrides: Record<string, unknown> = {}) {
  return {
    id: 'brand-1',
    name: '星巴克',
    sortOrder: 0,
    displayImageKey: null,
    displayImageVersion: 0,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    _count: { bags: 2 },
    ...overrides
  };
}

function setup(overrides: { brand?: Record<string, unknown>; cos?: Record<string, unknown>; queues?: Record<string, unknown> } = {}) {
  const prisma = {
    brand: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) }
  };
  const cos = { signedUrl: vi.fn().mockResolvedValue('https://cdn.test/brand/brand-1/display/v1.jpg'), putObject: vi.fn().mockResolvedValue(undefined), ...(overrides.cos ?? {}) };
  const queues = { add: vi.fn().mockResolvedValue(undefined), ...(overrides.queues ?? {}) };
  const service = new BrandsAdminService(prisma as never, cos as never, queues as never);
  return { service, prisma, cos, queues };
}

describe('BrandsAdminService.list', () => {
  it('maps a brand with a display image to a signed displayImageUrl', async () => {
    const { service, prisma, cos } = setup();
    prisma.brand.findMany.mockResolvedValue([brand({ displayImageKey: 'brand/brand-1/display/v1.jpg', displayImageVersion: 1 })]);

    const result = await service.list();

    expect(result).toEqual([{
      id: 'brand-1',
      name: '星巴克',
      sortOrder: 0,
      displayImageUrl: 'https://cdn.test/brand/brand-1/display/v1.jpg',
      bagCount: 2,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z'
    }]);
    expect(cos.signedUrl).toHaveBeenCalledWith('brand/brand-1/display/v1.jpg');
  });

  it('omits displayImageUrl and skips signing when the brand has no image', async () => {
    const { service, prisma, cos } = setup();
    prisma.brand.findMany.mockResolvedValue([brand()]);

    const result = await service.list();

    expect(result[0]).not.toHaveProperty('displayImageUrl');
    expect(cos.signedUrl).not.toHaveBeenCalled();
  });
});

describe('BrandsAdminService.uploadImage', () => {
  const file = { body: Buffer.from('png-bytes'), contentType: 'image/png' };

  it('rejects unsupported content types or empty bodies', async () => {
    const { service } = setup();
    await expect(service.uploadImage('admin-1', 'brand-1', { body: Buffer.from('x'), contentType: 'image/gif' }))
      .rejects.toMatchObject({ response: { error: { code: 'UPLOAD_INVALID', message: '图片格式或大小不正确' } } });
    await expect(service.uploadImage('admin-1', 'brand-1', { body: Buffer.alloc(0), contentType: 'image/png' }))
      .rejects.toMatchObject({ response: { error: { code: 'UPLOAD_INVALID', message: '图片格式或大小不正确' } } });
  });

  it('rejects a missing brand', async () => {
    const { service, prisma } = setup();
    prisma.brand.findUnique.mockResolvedValue(null);
    await expect(service.uploadImage('admin-1', 'brand-1', file))
      .rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND', message: '品牌不存在' } } });
  });

  it('uploads with a versioned key, updates the record, logs, and cleans up the old image', async () => {
    const { service, prisma, cos, queues } = setup();
    const oldKey = 'brand/brand-1/display/v1.png';
    const existing = brand({ displayImageKey: oldKey, displayImageVersion: 1 });
    const updated = brand({ displayImageKey: 'brand/brand-1/display/v2.png', displayImageVersion: 2 });
    prisma.brand.findUnique.mockResolvedValue(existing);
    prisma.brand.update.mockResolvedValue(updated);

    const result = await service.uploadImage('admin-1', 'brand-1', file);

    expect(cos.putObject).toHaveBeenCalledWith('brand/brand-1/display/v2.png', file.body, 'image/png');
    expect(prisma.brand.update).toHaveBeenCalledWith({
      where: { id: 'brand-1' },
      data: { displayImageKey: 'brand/brand-1/display/v2.png', displayImageVersion: 2 },
      include: { _count: { select: { bags: true } } }
    });
    expect(queues.add).toHaveBeenCalledWith('cleanup', { keys: [oldKey] });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'admin-1', action: 'BRAND_UPDATE_IMAGE', targetId: 'brand-1', metadata: { name: '星巴克', version: 2 } }
    });
    expect(result.displayImageUrl).toBe('https://cdn.test/brand/brand-1/display/v1.jpg');
  });

  it('starts versioning at v1 and skips cleanup for a first upload', async () => {
    const { service, prisma, queues } = setup();
    const existing = brand({ displayImageKey: null, displayImageVersion: 0 });
    prisma.brand.findUnique.mockResolvedValue(existing);
    prisma.brand.update.mockResolvedValue(brand({ displayImageKey: 'brand/brand-1/display/v1.jpg', displayImageVersion: 1 }));

    await service.uploadImage('admin-1', 'brand-1', { body: Buffer.from('jpeg'), contentType: 'image/jpeg' });

    expect(prisma.brand.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { displayImageKey: 'brand/brand-1/display/v1.jpg', displayImageVersion: 1 }
    }));
    expect(queues.add).not.toHaveBeenCalled();
  });
});

describe('BrandsAdminService.removeDisplayImage', () => {
  it('clears the key, enqueues cleanup of the old object, and logs the change', async () => {
    const { service, prisma, queues } = setup();
    const oldKey = 'brand/brand-1/display/v3.png';
    prisma.brand.findUnique.mockResolvedValue(brand({ displayImageKey: oldKey, displayImageVersion: 3 }));
    prisma.brand.update.mockResolvedValue(brand({ displayImageKey: null, displayImageVersion: 3 }));

    const result = await service.removeDisplayImage('admin-1', 'brand-1');

    expect(prisma.brand.update).toHaveBeenCalledWith({
      where: { id: 'brand-1' },
      data: { displayImageKey: null },
      include: { _count: { select: { bags: true } } }
    });
    expect(queues.add).toHaveBeenCalledWith('cleanup', { keys: [oldKey] });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'admin-1', action: 'BRAND_REMOVE_IMAGE', targetId: 'brand-1', metadata: { name: '星巴克' } }
    });
    expect(result).not.toHaveProperty('displayImageUrl');
  });

  it('rejects a missing brand', async () => {
    const { service, prisma } = setup();
    prisma.brand.findUnique.mockResolvedValue(null);
    await expect(service.removeDisplayImage('admin-1', 'brand-1'))
      .rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND', message: '品牌不存在' } } });
  });
});

describe('BrandsAdminService.remove', () => {
  it('cleans up the display image after deleting a brand that has one', async () => {
    const { service, prisma, queues } = setup();
    const oldKey = 'brand/brand-1/display/v1.jpg';
    prisma.brand.findUnique.mockResolvedValue(brand({ displayImageKey: oldKey, _count: { bags: 0 } }));

    await service.remove('admin-1', 'brand-1');

    expect(prisma.brand.delete).toHaveBeenCalledWith({ where: { id: 'brand-1' } });
    expect(queues.add).toHaveBeenCalledWith('cleanup', { keys: [oldKey] });
  });

  it('skips cleanup when the brand has no display image', async () => {
    const { service, prisma, queues } = setup();
    prisma.brand.findUnique.mockResolvedValue(brand({ displayImageKey: null, _count: { bags: 0 } }));

    await service.remove('admin-1', 'brand-1');

    expect(queues.add).not.toHaveBeenCalled();
  });
});
