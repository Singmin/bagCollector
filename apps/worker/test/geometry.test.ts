import { describe, expect, it } from 'vitest';
import { computeCropRect } from '../src/geometry.js';

describe('computeCropRect', () => {
  it('turns normalized coordinates into bounded pixels', () => {
    expect(computeCropRect(1000, 800, { x: 0.1, y: 0.25, width: 0.5, height: 0.5 })).toEqual({
      left: 100,
      top: 200,
      width: 500,
      height: 400
    });
  });

  it('clamps floating point overflow at the edge', () => {
    expect(computeCropRect(100, 100, { x: 0.8, y: 0.8, width: 0.200001, height: 0.200001 })).toEqual({
      left: 80,
      top: 80,
      width: 20,
      height: 20
    });
  });
});
