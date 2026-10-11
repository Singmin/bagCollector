import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { compressLearningSample, LEARNING_MAX_BYTES } from '../src/learning.js';
describe('learning JPEG', () => {
  it('bounds size, keeps aspect ratio and flattens transparent pixels white', async () => {
    const source = await sharp({ create: { width: 1024, height: 2048, channels: 4, background: '#00000000' } }).png().toBuffer();
    const image = await compressLearningSample(source);
    const info = await sharp(image).metadata();
    expect(info.width).toBe(256); expect(info.height).toBe(512); expect(info.hasAlpha).toBe(false);
    expect(image.length).toBeLessThanOrEqual(LEARNING_MAX_BYTES);
    const pixel = await sharp(image).raw().toBuffer(); expect([...pixel.subarray(0, 3)]).toEqual([255, 255, 255]);
  });
  it('does not upscale small images or silently accept undecodable data', async () => {
    const source = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#a22034' } }).png().toBuffer();
    const info = await sharp(await compressLearningSample(source)).metadata(); expect(info.width).toBe(20); expect(info.height).toBe(30);
    await expect(compressLearningSample(Buffer.from('not an image'))).rejects.toThrow();
  });
});
