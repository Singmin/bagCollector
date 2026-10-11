import { describe, expect, it } from 'vitest';
import { previewCrop } from '../src/services/scan-crop.js';
describe('camera cover projection', () => {
  it('maps a portrait preview into a wider captured photograph', () => {
    const crop = previewCrop({ left: 10, top: 20, width: 300, height: 600 }, { left: 60, top: 120, width: 200, height: 400 }, 1200, 1600);
    expect(crop.x).toBeCloseTo(5 / 18); expect(crop.y).toBeCloseTo(1 / 6);
    expect(crop.width).toBeCloseTo(4 / 9); expect(crop.height).toBeCloseTo(2 / 3);
  });
  it('clamps a guide extending beyond a small-screen stage', () => {
    const crop = previewCrop({ left: 0, top: 0, width: 300, height: 400 }, { left: -10, top: 20, width: 400, height: 600 }, 600, 800);
    expect(crop).toEqual({ x: 0, y: 0.05, width: 1, height: 0.95, rotation: 0 });
  });
});
