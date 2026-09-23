import { describe, expect, it } from 'vitest';
import {
  COLLECTION_FRESHNESS_MS,
  collectionRevision,
  markCollectionDataStale,
  shouldRefreshCollection
} from '../src/services/collection-state.js';

describe('collection freshness', () => {
  it('keeps matching data fresh for thirty seconds', () => {
    expect(shouldRefreshCollection(1_000, 3, 1_000 + COLLECTION_FRESHNESS_MS - 1, 3)).toBe(false);
    expect(shouldRefreshCollection(1_000, 3, 1_000 + COLLECTION_FRESHNESS_MS, 3)).toBe(true);
  });

  it('refreshes when a successful mutation advances the revision', () => {
    const before = collectionRevision();
    markCollectionDataStale();
    expect(collectionRevision()).toBe(before + 1);
    expect(shouldRefreshCollection(Date.now(), before)).toBe(true);
  });
});
