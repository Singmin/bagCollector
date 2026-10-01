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

/* 「拥有官方袋子」走 POST /official-bags/:id/claim：接口立刻返回，但图片还在 worker 里复制，
   收藏记录此时是 NORMALIZING，收藏列表（只返回 READY）暂时查不到它 ——
   页面不做自动补刷（2026-09-30 用户明确要求「自己下拉刷新」），
   只靠 revision 变化在下次进入页面时取一次，之后由用户手动下拉。 */
