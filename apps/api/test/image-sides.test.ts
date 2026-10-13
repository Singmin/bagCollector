import { describe, expect, it, vi } from 'vitest';
import { CollectiblesService } from '../src/collectibles/collectibles.service.js';
import { parseSide } from '../src/common/image-sides.js';

function fixture(official = false) {
  const state = { sourceVersion: 1, processingVersion: 2, publishedVersion: 2, processingStatus: 'READY', mattedSourceVersion: null, crop: { x: 0, y: 0, width: 1, height: 1, rotation: 0, brightness: 1.2 } };
  const tx = {
    $queryRaw: vi.fn(), collectible: { findFirst: vi.fn().mockResolvedValue({ id: 'bag', sourceOfficialBagId: official ? 'official' : null }), update: vi.fn() },
    collectibleImageSide: { findUnique: vi.fn().mockResolvedValue(state), update: vi.fn() },
    processingJob: { create: vi.fn().mockResolvedValue({ id: 'job' }) }
  };
  const prisma = { $transaction: (callback: (tx: unknown) => unknown) => callback(tx) };
  const queues = { add: vi.fn() };
  const service = new CollectiblesService(prisma as never, {} as never, {} as never, queues as never, {} as never, {} as never);
  return { service, tx, queues, state };
}
describe('image processing permissions and state', () => {
  it('rejects official crop, matte and B deletion before changing images', async () => {
    const { service, tx } = fixture(true);
    await expect(service.crop('user', 'bag', { side: 'BACK', x: 0, y: 0, width: 1, height: 1, rotation: 0 })).rejects.toMatchObject({ status: 403 });
    await expect(service.matte('user', 'bag', { side: 'BACK' })).rejects.toMatchObject({ status: 403 });
    await expect(service.removeImage('user', 'bag', 'BACK')).rejects.toMatchObject({ status: 403 });
    expect(tx.collectibleImageSide.update).not.toHaveBeenCalled();
  });
  it('snapshots B crop and leaves the bag-level A projection untouched', async () => {
    const { service, tx, queues } = fixture();
    await service.crop('user', 'bag', { side: 'BACK', x: .1, y: 0, width: .8, height: 1, rotation: 90 });
    expect(tx.collectible.update).not.toHaveBeenCalled();
    expect(queues.add).toHaveBeenCalledWith('crop', expect.objectContaining({ side: 'BACK', version: 3, sourceVersion: 1, crop: expect.objectContaining({ brightness: 1.2, rotation: 90 }) }), 'crop:bag:BACK:v3');
  });
  it('prevents duplicate processing on one face and preserves FRONT defaults', async () => {
    const { service, state } = fixture(); state.processingStatus = 'CROPPING';
    await expect(service.crop('user', 'bag', { x: 0, y: 0, width: 1, height: 1, rotation: 0 })).rejects.toMatchObject({ status: 409 });
    expect(parseSide()).toBe('FRONT'); expect(() => parseSide('LEFT')).toThrow();
  });
});
