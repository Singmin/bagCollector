import { computed, onScopeDispose, ref } from 'vue';
import type { Collectible, CollectibleSummary, Shelf } from '../types';
import { dataService } from './data';
import { collectionRevision, shouldRefreshCollection } from './collection-state';
import { resolveCollectibleThumbnail } from './images';
import type { LibraryDisplayItem } from './library-card-events';

export const GRID_STEP = 120;
export const SHELF_IMAGE_HEIGHT = 240;
export interface LibraryShelfGroup extends Shelf { entries: LibraryDisplayItem[] }
interface Dependencies {
  data?: Pick<typeof dataService, 'collectibles' | 'shelves' | 'wishlist' | 'removeCollectible' | 'removeWishlist'>;
  thumbnail?: typeof resolveCollectibleThumbnail;
  onLoaded?: () => void;
}
const imageVersion = (item: CollectibleSummary) => item.imageRevision ?? item.updatedAt;

export function useLibraryCollection(dependencies: Dependencies = {}) {
  const data = dependencies.data ?? dataService;
  const thumbnail = dependencies.thumbnail ?? resolveCollectibleThumbnail;
  const loading = ref(true);
  const initialized = ref(false);
  const refreshing = ref(false);
  const loadError = ref('');
  const loadingMore = ref(false);
  const nextCursor = ref<string | null>(null);
  const shelves = ref<Shelf[]>([]);
  const items = ref<CollectibleSummary[]>([]);
  const totalCount = ref(0);
  const segment = ref<'mine' | 'wish'>('mine');
  const displayMode = ref<'shelf' | 'grid'>('shelf');
  const wishlistItems = ref<Collectible[]>([]);
  const searchText = ref('');
  const keyword = ref('');
  const hasSearch = computed(() => !!keyword.value);
  const thumbnailUrls = ref<Record<string, string>>({});
  const thumbnailAspect = ref<Record<string, number>>({});
  const failedThumbnails = ref<Record<string, boolean>>({});
  const knownTagCounts = ref<Map<string, number>>(new Map());
  const gridRenderCount = ref(GRID_STEP);
  const wishRenderCount = ref(GRID_STEP);
  const itemIndex = computed(() => new Map(items.value.map(item => [item.id, item])));
  const thumbnailVersions = new Map<string, string>();
  const tagSets = new Map<string, string[]>();
  let generation = 0;
  let alive = true;
  let loadedAt = 0;
  let loadedRevision = -1;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { keyword: string; revision: number; promise: Promise<void> } | undefined;

  function currentImage(item: CollectibleSummary) {
    const current = itemIndex.value.get(item.id);
    return alive && !!current && imageVersion(current) === imageVersion(item);
  }
  function displayItem(item: CollectibleSummary): LibraryDisplayItem {
    return { item, imageUrl: failedThumbnails.value[item.id] ? '' : thumbnailUrls.value[item.id] ?? '',
      imageWidth: Math.round(SHELF_IMAGE_HEIGHT * (thumbnailAspect.value[item.id] ?? 0.75)) };
  }
  const groups = computed<LibraryShelfGroup[]>(() => {
    const byShelf = new Map<string, LibraryDisplayItem[]>();
    for (const item of items.value) {
      const group = byShelf.get(item.shelfId) ?? [];
      group.push(displayItem(item));
      byShelf.set(item.shelfId, group);
    }
    return shelves.value.filter(shelf => byShelf.has(shelf.id))
      .map(shelf => ({ ...shelf, entries: byShelf.get(shelf.id)! }));
  });
  const visibleWishlist = computed(() => {
    const kw = keyword.value.toLowerCase();
    return wishlistItems.value.filter(item => !kw || item.name.toLowerCase().includes(kw)
      || (item.ownerName ?? '').toLowerCase().includes(kw) || item.tags.some(tag => tag.toLowerCase().includes(kw)));
  });
  const gridItems = computed(() => items.value.slice(0, gridRenderCount.value).map(displayItem));
  const wishGridItems = computed<LibraryDisplayItem[]>(() => visibleWishlist.value.slice(0, wishRenderCount.value)
    .map(item => ({ item, imageUrl: item.displayImageUrl || item.thumbnailUrl || '', imageWidth: 0 })));
  const gridOverflow = computed(() => items.value.length - gridItems.value.length);
  const emptyChips = computed(() => [
    ...shelves.value.filter(shelf => shelf.itemCount > 0).map(shelf => ({ kind: 'shelf' as const, text: shelf.name, count: shelf.itemCount })),
    ...Array.from(knownTagCounts.value, ([text, count]) => ({ kind: 'tag' as const, text, count }))
  ].sort((a, b) => b.count - a.count || (a.kind === b.kind ? 0 : a.kind === 'shelf' ? -1 : 1)
    || a.text.length - b.text.length).slice(0, 4));

  function rememberTags(detail: Collectible) {
    tagSets.set(detail.id, detail.tags);
    rebuildTagCounts();
  }
  function rebuildTagCounts() {
    const counts = new Map<string, number>();
    for (const tags of tagSets.values()) for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    knownTagCounts.value = counts;
  }
  function assertRenderable(nextItems: CollectibleSummary[], nextShelves: Shelf[]) {
    const ids = new Set(nextShelves.map(shelf => shelf.id));
    for (const item of nextItems) if (!ids.has(item.shelfId)) throw new Error(`收藏“${item.name}”的展示架不存在`);
  }
  function query(key: string, cursor?: string) {
    return ['limit=1000', ...(key ? [`search=${encodeURIComponent(key)}`] : []),
      ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])].join('&');
  }
  function settleThumbnail(item: CollectibleSummary) {
    const version = imageVersion(item);
    if (thumbnailVersions.get(item.id) === version && thumbnailUrls.value[item.id] && !failedThumbnails.value[item.id]) return Promise.resolve();
    return thumbnail(item).then(url => {
      if (!url || !currentImage(item)) return;
      thumbnailVersions.set(item.id, version);
      thumbnailUrls.value[item.id] = url;
      delete failedThumbnails.value[item.id];
      uni.getImageInfo({ src: url, success(info) {
        if (currentImage(item) && info.height > 0) thumbnailAspect.value[item.id] = info.width / info.height;
      } });
    }).catch(() => { if (currentImage(item)) failedThumbnails.value[item.id] = true; });
  }
  function hydrateThumbnails(nextItems: CollectibleSummary[]) {
    // Preserve the displayed shelf order when prioritizing the first twelve images.
    const byShelf = new Map<string, CollectibleSummary[]>();
    for (const item of nextItems) {
      const entries = byShelf.get(item.shelfId) ?? [];
      entries.push(item); byShelf.set(item.shelfId, entries);
    }
    const ordered = displayMode.value === 'shelf'
      ? shelves.value.flatMap(shelf => byShelf.get(shelf.id) ?? []) : nextItems;
    void Promise.all(ordered.slice(0, 12).map(settleThumbnail))
      .then(() => { if (alive) return Promise.all(ordered.slice(12).filter(currentImage).map(settleThumbnail)); });
  }
  function pruneImages() {
    for (const id of Object.keys(thumbnailUrls.value)) {
      const item = itemIndex.value.get(id);
      if (!item || thumbnailVersions.get(id) !== imageVersion(item)) {
        delete thumbnailUrls.value[id]; delete thumbnailAspect.value[id]; delete failedThumbnails.value[id]; thumbnailVersions.delete(id);
      }
    }
  }
  function needsRefresh() { return !initialized.value || shouldRefreshCollection(loadedAt, loadedRevision); }
  function load(force = false): Promise<void> {
    const key = keyword.value;
    const revision = collectionRevision();
    if (pending?.keyword === key && pending.revision === revision) return pending.promise;
    if (!force && !needsRefresh()) return Promise.resolve();
    const request = ++generation;
    const isCurrent = () => alive && request === generation && key === keyword.value;
    loadingMore.value = false;
    if (initialized.value) refreshing.value = true; else loading.value = true;
    loadError.value = '';
    const promise = (async () => {
      try {
        const [page, nextShelves, wish] = await Promise.all([data.collectibles(query(key)), data.shelves(), data.wishlist()]);
        if (!isCurrent()) return;
        assertRenderable(page.items, nextShelves);
        items.value = page.items; shelves.value = nextShelves; wishlistItems.value = wish;
        nextCursor.value = page.nextCursor; totalCount.value = page.totalCount;
        initialized.value = true;
        gridRenderCount.value = wishRenderCount.value = GRID_STEP;
        loadedAt = Date.now(); loadedRevision = revision;
        pruneImages(); hydrateThumbnails(page.items); dependencies.onLoaded?.();
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : '全部收藏加载失败';
        if (initialized.value) uni.showToast({ title: message, icon: 'none' }); else loadError.value = message;
      } finally {
        if (isCurrent()) { loading.value = false; refreshing.value = false; pending = undefined; }
      }
    })();
    pending = { keyword: key, revision, promise };
    return promise;
  }
  async function loadMore() {
    if (pending || !nextCursor.value || loadingMore.value || segment.value !== 'mine') return;
    const request = generation;
    const key = keyword.value;
    const cursor = nextCursor.value;
    const isCurrent = () => alive && request === generation && key === keyword.value;
    loadingMore.value = true;
    try {
      const page = await data.collectibles(query(key, cursor));
      if (!isCurrent()) return;
      assertRenderable(page.items, shelves.value);
      const added = page.items.filter(item => !itemIndex.value.has(item.id));
      items.value = [...items.value, ...added]; nextCursor.value = page.nextCursor; totalCount.value = page.totalCount;
      hydrateThumbnails(added); dependencies.onLoaded?.();
    } catch (error) {
      if (isCurrent()) uni.showToast({ title: error instanceof Error ? error.message : '加载更多失败', icon: 'none' });
    } finally { if (isCurrent()) loadingMore.value = false; }
  }
  function applySearch(value: string) {
    clearTimeout(searchTimer);
    const next = value.trim();
    if (next === keyword.value) return;
    keyword.value = next;
    wishRenderCount.value = GRID_STEP;
    if (segment.value === 'mine') void load(true);
    else { generation += 1; pending = undefined; loadingMore.value = false; loading.value = false; refreshing.value = false; loadedAt = 0; }
  }
  function onSearchInput(event: Event) {
    searchText.value = (event as unknown as { detail?: { value?: string } }).detail?.value ?? '';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applySearch(searchText.value), 300);
  }
  function searchFor(text: string) { searchText.value = text; applySearch(text); }
  function clearSearch() { searchText.value = ''; applySearch(''); }
  function switchSegment(next: 'mine' | 'wish') {
    if (segment.value === next) return;
    const wasSearching = !!keyword.value;
    segment.value = next; clearSearch();
    if (next === 'mine' && !wasSearching && needsRefresh()) void load(true);
  }
  function appendGridRender() {
    if (segment.value === 'wish') wishRenderCount.value = Math.min(visibleWishlist.value.length, wishRenderCount.value + GRID_STEP);
    else if (displayMode.value === 'grid') gridRenderCount.value = Math.min(items.value.length, gridRenderCount.value + GRID_STEP);
  }
  function upsertShelf(shelf: Shelf) {
    const existing = shelves.value.findIndex(current => current.id === shelf.id);
    if (existing < 0) shelves.value = [...shelves.value, shelf]; else shelves.value[existing] = shelf;
  }
  function invalidatePending() {
    generation += 1; pending = undefined; loadedAt = 0;
    loadingMore.value = false; refreshing.value = false; loading.value = false;
  }
  function applyUpdated(updated: Collectible) {
    invalidatePending();
    const previous = itemIndex.value.get(updated.id);
    if (previous && previous.shelfId !== updated.shelfId) shelves.value = shelves.value.map(shelf => ({ ...shelf,
      itemCount: shelf.itemCount + (shelf.id === updated.shelfId ? 1 : shelf.id === previous.shelfId ? -Math.min(1, shelf.itemCount) : 0) }));
    items.value = items.value.map(item => item.id === updated.id ? { ...item, ...updated } : item);
    rememberTags(updated); pruneImages();
    if (previous) void settleThumbnail(updated);
  }
  function removeLocal(item: CollectibleSummary) {
    invalidatePending();
    const previous = itemIndex.value.get(item.id);
    items.value = items.value.filter(current => current.id !== item.id);
    if (previous) {
      totalCount.value = Math.max(0, totalCount.value - 1);
      shelves.value = shelves.value.map(shelf => shelf.id === previous.shelfId ? { ...shelf, itemCount: Math.max(0, shelf.itemCount - 1) } : shelf);
    }
    tagSets.delete(item.id);
    rebuildTagCounts();
    pruneImages();
  }
  async function confirmRemove(item: CollectibleSummary) {
    if (!item || !item.name || !item.id) return false;
    const confirmed = await new Promise<boolean>(resolve => uni.showModal({ title: '删除收藏',
      content: `确定删除「${item.name}」？删除后不可恢复`, confirmText: '删除', confirmColor: '#c50405',
      success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
    if (!confirmed) return false;
    try { await data.removeCollectible(item.id); removeLocal(item); uni.showToast({ title: '已删除', icon: 'none' }); return true; }
    catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '删除失败', icon: 'none' }); return false; }
  }
  function removeWishLocal(id: string) { invalidatePending(); wishlistItems.value = wishlistItems.value.filter(item => item.id !== id); }
  async function removeWish(item: CollectibleSummary) {
    const confirmed = await new Promise<boolean>(resolve => uni.showModal({ title: '取消心愿',
      content: `把「${item.name}」移出心愿袋？`, confirmText: '移出', success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
    if (!confirmed) return false;
    try { await data.removeWishlist(item.id); removeWishLocal(item.id); uni.showToast({ title: '已移出心愿袋', icon: 'none' }); return true; }
    catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' }); return false; }
  }
  function collectibleNo(item: CollectibleSummary) {
    const index = items.value.findIndex(current => current.id === item.id);
    return totalCount.value && index >= 0 ? `NO.${String(Math.max(1, totalCount.value - index)).padStart(3, '0')}` : '';
  }
  function onImageError(item: CollectibleSummary) { if (currentImage(item)) failedThumbnails.value[item.id] = true; }
  function cancelSearchTimer() { clearTimeout(searchTimer); }
  onScopeDispose(() => { alive = false; generation += 1; cancelSearchTimer(); });
  return { loading, initialized, refreshing, loadError, loadingMore, nextCursor, shelves, items, totalCount,
    segment, displayMode, wishlistItems, searchText, keyword, hasSearch, knownTagCounts, groups, visibleWishlist,
    gridItems, wishGridItems, gridOverflow, emptyChips, load, loadMore, needsRefresh, applySearch, onSearchInput,
    searchFor, clearSearch, switchSegment, appendGridRender, upsertShelf, applyUpdated, rememberTags, removeLocal,
    confirmRemove, removeWish, removeWishLocal, collectibleNo, onImageError, cancelSearchTimer };
}
