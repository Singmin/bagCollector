import { describe, expect, it } from 'vitest';
import { cropSchema, updateCollectibleSchema } from '../src/index.js';

describe('cropSchema', () => {
  it('accepts a normalized crop', () => {
    expect(cropSchema.parse({ x: 0.1, y: 0.2, width: 0.5, height: 0.6, rotation: 90 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.6,
      rotation: 90
    });
  });

  it('rejects a crop outside the image', () => {
    expect(() => cropSchema.parse({ x: 0.8, y: 0, width: 0.4, height: 1, rotation: 0 })).toThrow();
  });
});

describe('updateCollectibleSchema', () => {
  it('limits tags', () => {
    expect(() => updateCollectibleSchema.parse({ tags: Array.from({ length: 31 }, (_, index) => `tag-${index}`) })).toThrow();
  });
});
