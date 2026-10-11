import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLOR_SCAN_MODEL, DEFAULT_SCAN_SETTINGS, DINO_SCAN_MODEL, cropScanImage, extractScanFeature, normalizeScanImage, rankScanCandidates, needsScanEnhancement, scanCandidates } from '../src/index.js';

const red = () => sharp({ create: { width: 80, height: 120, channels: 3, background: '#c81818' } }).png().toBuffer();
afterEach(() => vi.unstubAllGlobals());
describe('scan preprocessing and retrieval', () => {
  it('removes transparent borders, preserves the complete subject and yields 224x224 RGB', async () => {
    const bag = await red();
    const padded = await sharp({ create: { width: 300, height: 400, channels: 4, background: '#00000000' } }).composite([{ input: bag, left: 30, top: 90 }]).png().toBuffer();
    const [a, b] = await Promise.all([normalizeScanImage(bag), normalizeScanImage(padded)]);
    expect(a.equals(b)).toBe(true);
    const metadata = await sharp(a).metadata();
    expect([metadata.width, metadata.height, metadata.channels]).toEqual([224, 224, 3]);
  });
  it('crops a derived buffer, leaving the original untouched', async () => {
    const source = await red(); const original = Buffer.from(source);
    const body = await cropScanImage(source, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    const meta = await sharp(body).metadata();
    expect([meta.width, meta.height]).toEqual([40, 60]); expect(source.equals(original)).toBe(true);
  });
  it('applies EXIF orientation before crop coordinates', async () => {
    const image = await sharp(await red()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await sharp(await cropScanImage(image, { x: 0, y: 0, width: 0.5, height: 1 })).metadata();
    expect([result.width, result.height]).toEqual([60, 80]);
  });
  it('rejects all-transparent/white input, rather than producing a misleading sentinel', async () => {
    const white = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#ffffff' } }).png().toBuffer();
    await expect(normalizeScanImage(white)).rejects.toThrow('主体');
  });
  it('uses grayscale inputs safely', async () => {
    const image = await sharp(await red()).greyscale().png().toBuffer();
    const feature = await extractScanFeature(image, 'color');
    expect(feature.vector).toHaveLength(389); expect(feature.vector.every(Number.isFinite)).toBe(true);
  });
  it('validates DINO model identity/dimension and sends canonical pixels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: DINO_SCAN_MODEL, vector: [1, ...Array(383).fill(0)] })));
    vi.stubGlobal('fetch', fetchMock);
    const feature = await extractScanFeature(await red(), 'dino', 'http://vision:8000');
    expect(feature.vector).toHaveLength(384);
    const meta = await sharp(Buffer.from(fetchMock.mock.calls[0]![1].body)).metadata(); expect(meta.width).toBe(224);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ model: COLOR_SCAN_MODEL, vector: [1] })));
    await expect(extractScanFeature(await red(), 'dino', 'http://vision:8000')).rejects.toThrow('版本或维度');
  });
  it('deduplicates reference images by bag, filters EVERY score and retains improvements from either query', () => {
    const queries = [{ vector: [1, 0], colorVector: [1, 0] }, { vector: [0, 1], colorVector: [0, 1] }];
    const entries = [
      { officialBagId: 'A', vector: [1, 0], colorVector: [1, 0] },
      { officialBagId: 'A', vector: [0.8, 0.2], colorVector: [0.8, 0.2] },
      { officialBagId: 'B', vector: [0, 1], colorVector: [0, 1] },
      { officialBagId: 'C', vector: [-1, -1], colorVector: [-1, -1] }
    ];
    const scores = rankScanCandidates(queries, entries, DEFAULT_SCAN_SETTINGS);
    expect(scores).toHaveLength(3);
    expect(scanCandidates(scores, DEFAULT_SCAN_SETTINGS).map(s => s.bagId)).toEqual(['A', 'B']);
    expect(needsScanEnhancement(scores, DEFAULT_SCAN_SETTINGS)).toBe(true);
    expect(needsScanEnhancement([{ bagId: 'A', score: 0.95 }, { bagId: 'B', score: 0.7 }], DEFAULT_SCAN_SETTINGS)).toBe(false);
  });
  it('does not compare incompatible coordinates', () => {
    expect(rankScanCandidates([{ vector: [1, 0], colorVector: [1] }], [{ officialBagId: 'A', vector: [1], colorVector: [1] }], DEFAULT_SCAN_SETTINGS)).toEqual([]);
  });
});
