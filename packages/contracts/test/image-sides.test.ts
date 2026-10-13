import { describe, expect, it } from 'vitest';
import { cropSchema, matteSchema, uploadPolicySchema } from '../src/index.js';
import { imageRevision, selectSideAssets } from '../src/image-sides.js';

describe('image side isolation', () => {
  it('reads only the committed rendition version of the requested face', () => {
    const assets = [
      { side: 'FRONT' as const, kind: 'DISPLAY', version: 2, objectKey: 'front' },
      { side: 'BACK' as const, kind: 'DISPLAY', version: 2, objectKey: 'back' },
      { side: 'FRONT' as const, kind: 'DISPLAY', version: 3, objectKey: 'unfinished' },
      { side: 'FRONT' as const, kind: 'STANDARD', version: 1, objectKey: 'source' }
    ];
    const selected = selectSideAssets(assets, { side: 'FRONT', sourceVersion: 1, processingVersion: 3, publishedVersion: 2 });
    expect(selected.DISPLAY?.objectKey).toBe('front');
    expect(selected.STANDARD?.objectKey).toBe('source');
  });
  it('does not expose unfinished or removed back renditions', () => {
    expect(selectSideAssets([{ side: 'BACK', kind: 'DISPLAY', version: 1 }], { side: 'BACK', sourceVersion: 0, processingVersion: 2, publishedVersion: null }).DISPLAY).toBeUndefined();
  });
  it('invalidates revisions for official replacement and B removal', () => {
    const front = { side: 'FRONT' as const, sourceVersion: 1, processingVersion: 2, publishedVersion: 2 };
    const back = { ...front, side: 'BACK' as const };
    expect(imageRevision('official-1', [front, back])).not.toBe(imageRevision('official-1', [front]));
    expect(imageRevision('official-1', [front])).not.toBe(imageRevision('official-1', [{ ...front, publishedVersion: 3 }]));
  });
  it('accepts B on upload, crop and empty matte while rejecting arbitrary faces', () => {
    expect(cropSchema.parse({ side: 'BACK', x: 0, y: 0, width: 1, height: 1, rotation: 0 }).side).toBe('BACK');
    expect(matteSchema.parse({ side: 'BACK' }).side).toBe('BACK');
    expect(uploadPolicySchema.safeParse({ side: 'LEFT', collectibleId: 'a', fileName: 'a.jpg', contentType: 'image/jpeg', size: 1 }).success).toBe(false);
  });
});
