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
