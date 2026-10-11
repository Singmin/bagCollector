import { describe, expect, it } from 'vitest';
import { createMatchScanSchema, scanSettingsSchema, scanFeedbackSchema } from '../src/index.js';
describe('scan contracts', () => {
  it('rejects crop overflows and rejects illegal quotas', () => {
    expect(createMatchScanSchema.safeParse({ collectibleId: 'a', source: 'camera', requestId: 'request-1', crop: { x: 0.9, y: 0, width: 0.5, height: 1 } }).success).toBe(false);
    expect(scanSettingsSchema.safeParse({ dailyUserEnhancements: -1 }).success).toBe(false);
  });
  it('allows coarse plus fine rotation and requires a selected style', () => {
    expect(createMatchScanSchema.safeParse({ collectibleId: 'a', source: 'album', requestId: 'request-1', crop: { x: 0, y: 0, width: 1, height: 1, rotation: 290 } }).success).toBe(true);
    expect(scanFeedbackSchema.safeParse({ feedback: 'SELECTED' }).success).toBe(false);
  });
});
