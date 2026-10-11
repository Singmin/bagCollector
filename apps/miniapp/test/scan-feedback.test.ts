import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ store: new Map<string, unknown>(), api: vi.fn(), user: 'user-a' }));
vi.mock('../src/services/http', () => ({ api: fixture.api, ensureLogin: vi.fn(async () => {}) }));
vi.mock('../src/services/auth-storage', () => ({ readTokens: () => ({ accessToken: `header.${Buffer.from(JSON.stringify({ sub: fixture.user })).toString('base64url')}.signature` }) }));
import { retryScanFeedback, submitScanFeedback } from '../src/services/scan-feedback';
beforeEach(() => {
  fixture.store.clear(); fixture.api.mockReset(); fixture.user = 'user-a';
  vi.stubGlobal('uni', { getStorageSync: (key: string) => fixture.store.get(key), setStorageSync: (key: string, value: unknown) => fixture.store.set(key, value),
    base64ToArrayBuffer: (value: string) => Uint8Array.from(Buffer.from(value, 'base64')).buffer });
});
describe('durable scan feedback', () => {
  it('keeps offline feedback and retries without duplicate submission records', async () => {
    fixture.api.mockRejectedValue(new Error('offline'));
    await submitScanFeedback('scan-a', 'CORRECTED', 'bag-a');
    await submitScanFeedback('scan-a', 'CORRECTED', 'bag-a');
    expect([...fixture.store.values()][0]).toHaveLength(1);
    fixture.api.mockResolvedValue({ success: true }); await retryScanFeedback();
    expect([...fixture.store.values()][0]).toEqual([]);
    expect(fixture.api).toHaveBeenLastCalledWith('/official-bags/match-scans/scan-a/feedback', expect.objectContaining({ data: { feedback: 'CORRECTED', bagId: 'bag-a' } }));
  });
  it('does not submit one account feedback as another user and expires records after 24 hours', async () => {
    fixture.api.mockRejectedValue(new Error('offline')); await submitScanFeedback('scan-a', 'SELECTED', 'bag-a');
    fixture.api.mockClear(); fixture.user = 'user-b'; await retryScanFeedback(); expect(fixture.api).not.toHaveBeenCalled();
    const rows = [...fixture.store.values()][0] as { createdAt: number }[]; rows[0]!.createdAt = Date.now() - 86400_001;
    fixture.user = 'user-a'; await retryScanFeedback(); expect(fixture.api).not.toHaveBeenCalled(); expect([...fixture.store.values()][0]).toEqual([]);
  });
  it('drops terminal errors without reporting collection failure', async () => {
    fixture.api.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 404 }));
    await expect(submitScanFeedback('gone', 'NONE')).resolves.toBeUndefined(); expect([...fixture.store.values()][0]).toEqual([]);
  });
});
