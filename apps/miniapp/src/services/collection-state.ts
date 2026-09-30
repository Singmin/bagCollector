export const COLLECTION_FRESHNESS_MS = 30_000;

let revision = 0;

export function collectionRevision() {
  return revision;
}

export function markCollectionDataStale() {
  revision += 1;
}

export function shouldRefreshCollection(
  loadedAt: number,
  loadedRevision: number,
  now = Date.now(),
  currentRevision = collectionRevision()
) {
  return !loadedAt || loadedRevision !== currentRevision || now - loadedAt >= COLLECTION_FRESHNESS_MS;
}

/* ── 「拥有官方袋子」的落库延迟 ──
   标记已有走 POST /official-bags/:id/claim：接口立刻返回，但图片还在 worker 里复制，
   收藏记录此时是 NORMALIZING，收藏列表（只返回 READY）还查不到它。
   记下这次落库时间，收藏架页会在这之后补一次刷新 —— 否则用户刚标记完切过去
   看到空空如也，会以为「标记了却没进收藏架」。 */
const CLAIM_SETTLE_WINDOW_MS = 20_000;
let claimPendingAt = 0;

export function markClaimPending(now = Date.now()) {
  claimPendingAt = now;
}

export function claimPendingRecently(windowMs = CLAIM_SETTLE_WINDOW_MS, now = Date.now()) {
  return claimPendingAt > 0 && now - claimPendingAt <= windowMs;
}
