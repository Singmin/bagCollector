import { api, ensureLogin } from './http';
import { readTokens } from './auth-storage';

const KEY = 'bagcollect:v1:pending-scan-feedback';
const TTL = 86400_000;
type Feedback = 'SELECTED' | 'CORRECTED' | 'NONE';
interface Pending { scanId: string; feedback: Feedback; bagId?: string; userId: string; createdAt: number }
let flushing: Promise<void> | undefined;

function currentUser() {
  try {
    const payload = readTokens()?.accessToken.split('.')[1];
    if (!payload) return '';
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = new Uint8Array(uni.base64ToArrayBuffer(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return (JSON.parse(Array.from(bytes, b => String.fromCharCode(b)).join('')) as { sub: string }).sub;
  } catch { return ''; }
}
function read(): Pending[] {
  const rows = uni.getStorageSync(KEY);
  return Array.isArray(rows) ? rows.filter((r: Pending) => r.createdAt > Date.now() - TTL && typeof r.scanId === 'string') : [];
}

export function retryScanFeedback(): Promise<void> {
  flushing ??= (async () => {
    await ensureLogin();
    const userId = currentUser();
    for (const row of read().filter(r => r.userId === userId)) {
      try {
        await api(`/official-bags/match-scans/${row.scanId}/feedback`, { method: 'POST', data: { feedback: row.feedback, bagId: row.bagId }, timeout: 5000 });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (!status || status === 429 || status >= 500) break;
        // Terminal validation/ownership failures must not retry on another account.
      }
      uni.setStorageSync(KEY, read().filter(r => r.scanId !== row.scanId || r.userId !== row.userId));
    }
    uni.setStorageSync(KEY, read());
  })().catch(error => console.warn('scan feedback retry pending', error)).finally(() => { flushing = undefined; });
  return flushing;
}

/** Persist before sending. Failure never changes the successful collection result. */
export async function submitScanFeedback(scanId: string, feedback: Feedback, bagId?: string) {
  try {
    const userId = currentUser();
    if (!userId) return;
    const existing = read();
    const createdAt = existing.find(r => r.scanId === scanId && r.userId === userId)?.createdAt ?? Date.now();
    const rows = existing.filter(r => r.scanId !== scanId || r.userId !== userId);
    rows.push({ scanId, feedback, ...(bagId ? { bagId } : {}), userId, createdAt });
    uni.setStorageSync(KEY, rows);
    await retryScanFeedback();
  } catch (error) { console.warn('scan feedback could not be persisted', error); }
}
