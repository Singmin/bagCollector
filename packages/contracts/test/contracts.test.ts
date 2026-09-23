import { describe, expect, it } from 'vitest';
import { createCollectibleSchema, createShelfSchema, cropSchema, updateCollectibleSchema } from '../src/index.js';

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

describe('required creation fields', () => {
  it('requires a collectible name and shelf', () => {
    expect(() => createCollectibleSchema.parse({})).toThrow();
    expect(() => createCollectibleSchema.parse({ name: '纸袋' })).toThrow();
    expect(createCollectibleSchema.parse({ name: '纸袋', shelfId: 'shelf-1' })).toEqual({
      name: '纸袋',
      shelfId: 'shelf-1'
    });
  });

  it('requires an explicit shelf theme', () => {
    expect(() => createShelfSchema.parse({ name: '旅行' })).toThrow();
    expect(createShelfSchema.parse({ name: '旅行', theme: 'SAGE' })).toEqual({ name: '旅行', theme: 'SAGE' });
  });
});
