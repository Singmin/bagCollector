<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, ref, watch } from 'vue';
import { onHide, onShow, onShareAppMessage, onShareTimeline } from '@dcloudio/uni-app';
import type { Collectible, CollectibleSummary, Shelf } from '../../types';
import { dataService } from '../../services/data';
import { collectionRevision, shouldRefreshCollection, markCollectionDataStale } from '../../services/collection-state';
import { daysAgoText, formattedDate } from '../../services/format';
import { resolveCollectibleThumbnail } from '../../services/images';
import { maskPageChrome } from '../../services/overlay';
import { syncTabBar, setTabBarHidden } from '../../services/tab-bar';

interface ShelfGroup extends Shelf { items: CollectibleSummary[] }

const loading = ref(true);
const initialized = ref(false);
const refreshing = ref(false);
const loadError = ref('');
const loadingMore = ref(false);
const nextCursor = ref<string | null>(null);
const shelves = ref<Shelf[]>([]);
const items = ref<CollectibleSummary[]>([]);
const totalCount = ref(0);
const thumbnailUrls = ref<Record<string, string>>({});
const failedThumbnails = ref<Record<string, boolean>>({});
const displayMode = ref<'shelf' | 'grid'>('shelf');
/* 自定义导航：标题区顶部与右上角微信胶囊按钮顶部对齐 —— 用胶囊矩形取 Y。
   getMenuButtonBoundingClientRect 仅微信小程序可用，其他端回落 0。 */
const headerTop = ref(0);
/* 设置钮固定在微信胶囊左侧：right = 屏宽 − 胶囊左缘 + 8px 间隙，尺寸 = 胶囊高度 */
const settingsRight = ref(10);
const settingsSize = ref(32);
// #ifdef MP-WEIXIN
try {
  const capsule = uni.getMenuButtonBoundingClientRect();
  const win = uni.getSystemInfoSync();
  headerTop.value = capsule.top;
  settingsRight.value = win.windowWidth - capsule.left + 8;
  settingsSize.value = capsule.height;
} catch {
  headerTop.value = 0;
}
// #endif
/* 搜索分两个值：
   - searchText 是输入框里的原文，随每次击键更新，只喂给界面；
   - keyword 是防抖后真正生效、并且会进请求的搜索词。
   分开是为了「打字时不必等接口，但也不按每个字符发一次请求」。 */
const searchText = ref('');
const keyword = ref('');
const hasSearch = computed(() => keyword.value.length > 0);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let loadedAt = 0;
let loadedRevision = -1;
let refreshPromise: Promise<void> | undefined;

/* ── 展架横滑（对齐 H5 bindShelfScrollHints / updateShelfHintState）──
   箭头点一下横滑一屏（80% 行宽，带动画）；行滚动时同步两端箭头的置灰态。
   mp-weixin 的 scrollOffset 拿不到 scrollWidth，max 由卡片槽几何推算：
   内容宽 = 左右内边距(40rpx×2) + n×175rpx + (n−1)×18rpx。 */
const shelfScrollLeft = ref<Record<string, number>>({});
const shelfEdge = ref<Record<string, { start: boolean; end: boolean }>>({});
const shelfMetrics = new Map<string, { width: number; max: number; left: number }>();
let shelfUserScrolling = false;
const pageInstance = getCurrentInstance();

function shelfMaxScroll(itemCount: number, viewportWidth: number) {
  const content = uni.upx2px(80) + uni.upx2px(175) * itemCount + uni.upx2px(18) * Math.max(0, itemCount - 1);
  return Math.max(0, content - viewportWidth);
}

function measureShelves() {
  nextTick(() => {
    const ids = groups.value.map((group) => group.id);
    if (!ids.length) return;
    const query = uni.createSelectorQuery().in(pageInstance?.proxy);
    for (const id of ids) query.select(`#shelf-scroll-${id}`).boundingClientRect();
    query.exec((rows) => {
      ids.forEach((id, index) => {
        const rect = rows?.[index] as { width?: number } | null;
        if (!rect?.width) return;
        const group = groups.value.find((current) => current.id === id);
        if (!group) return;
        shelfMetrics.set(id, { width: rect.width, max: shelfMaxScroll(group.items.length, rect.width), left: shelfMetrics.get(id)?.left ?? 0 });
        const left = shelfMetrics.get(id)!.left;
        shelfEdge.value = { ...shelfEdge.value, [id]: { start: left <= 2, end: left >= shelfMetrics.get(id)!.max - 2 } };
      });
    });
  });
}

function onShelfScroll(groupId: string, event: { detail: { scrollLeft: number } }) {
  const left = event.detail.scrollLeft;
  const metrics = shelfMetrics.get(groupId);
  if (metrics) metrics.left = left;
  shelfScrollLeft.value = { ...shelfScrollLeft.value, [groupId]: left };
  shelfEdge.value = { ...shelfEdge.value, [groupId]: { start: left <= 2, end: left >= (metrics?.max ?? 0) - 2 } };
}

function scrollShelfBy(groupId: string, direction: 1 | -1) {
  const metrics = shelfMetrics.get(groupId);
  if (!metrics || metrics.max <= 0) return;
  const target = Math.min(metrics.max, Math.max(0, metrics.left + metrics.width * 0.8 * direction));
  metrics.left = target;
  shelfScrollLeft.value = { ...shelfScrollLeft.value, [groupId]: target };
  shelfEdge.value = { ...shelfEdge.value, [groupId]: { start: target <= 2, end: target >= metrics.max - 2 } };
}

/* 松手吸附（对齐 H5 的 scroll-snap: start）：对齐到最近的卡片槽左缘 */
function shelfTouchStart() { shelfUserScrolling = true; }

function snapShelf(groupId: string) {
  if (!shelfUserScrolling) return;
  shelfUserScrolling = false;
  const metrics = shelfMetrics.get(groupId);
  if (!metrics || metrics.max <= 0) return;
  const slot = uni.upx2px(175) + uni.upx2px(18);
  const aligned = Math.round((metrics.left + uni.upx2px(40)) / slot) * slot - uni.upx2px(40);
  const target = Math.min(metrics.max, Math.max(0, aligned));
  metrics.left = target;
  shelfScrollLeft.value = { ...shelfScrollLeft.value, [groupId]: target };
}

const groups = computed<ShelfGroup[]>(() => {
  return shelves.value.map((shelf) => ({
    ...shelf,
    items: items.value.filter((item) => item.shelfId === shelf.id)
  })).filter((group) => group.items.length);
});

watch(groups, () => measureShelves());

function query(cursor?: string) {
  const params = ['limit=30'];
  if (keyword.value) params.push(`search=${encodeURIComponent(keyword.value)}`);
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  return params.join('&');
}

/* 「拥有官方袋子」（发现页标记已有）落库后图片还在 worker 里复制，收藏列表只返回 READY，
   刚标记完切过来它可能还没现身 —— 不做任何自动补刷（2026-09-30 用户明确要求），
   用户自己下拉刷新即可。 */

function assertRenderable(nextItems: CollectibleSummary[], nextShelves: Shelf[]) {
  const shelfIds = new Set(nextShelves.map((shelf) => shelf.id));
  for (const item of nextItems) {
    if (!shelfIds.has(item.shelfId)) throw new Error(`收藏“${item.name}”的展示架不存在`);
  }
}

/* 展架袋图尺寸：高度固定 240rpx，宽度 = 高度 × 图片真实宽高比（等比缩放）。
   heightFix 在部分基础库上表现不稳，改为读图后显式计算（读不到回落 3:4）。
   2026-10-01 调整记录：270 → 200 → 240rpx。 */
const thumbnailAspect = ref<Record<string, number>>({});
const SHELF_IMAGE_HEIGHT = 240;

function shelfImageWidth(id: string) {
  const aspect = thumbnailAspect.value[id] ?? 0.75;
  return Math.round(SHELF_IMAGE_HEIGHT * aspect);
}

function loadImageAspect(id: string, url: string) {
  uni.getImageInfo({
    src: url,
    success(info) {
      if (info.height > 0) {
        thumbnailAspect.value = { ...thumbnailAspect.value, [id]: info.width / info.height };
      }
    },
    fail() {
      /* 读不到尺寸就用默认 3:4，不阻塞列表 */
    }
  });
}

/* ── 缩略图分两批入队：首屏优先 ──
   下载通道并发有限（见 services/images.ts），整页 30 张一起入队时，
   首屏的图要和整页的图抢槽位。先下前 FIRST_SCREEN_ITEMS 张（展架视图最上面的
   一两个展架 / 宫格从左起一屏），这一批完事（无论成败）再排其余的。
   2026-10-03 与陈列页按需下载一起改：陈列页此前把 feed 全量 1000 条塞进同一队列，
   切到本页时图排在千张之后，是「进页面久久不出图」的主因。 */
const FIRST_SCREEN_ITEMS = 12;

function settleThumbnail(item: CollectibleSummary) {
  return resolveCollectibleThumbnail(item).then((url) => {
    if (!url || !items.value.some((current) => current.id === item.id && current.updatedAt === item.updatedAt)) return;
    thumbnailUrls.value[item.id] = url;
    delete failedThumbnails.value[item.id];
    loadImageAspect(item.id, url);
  }).catch(() => {
    failedThumbnails.value[item.id] = true;
  });
}

function hydrateThumbnails(nextItems: CollectibleSummary[]) {
  void Promise.all(nextItems.slice(0, FIRST_SCREEN_ITEMS).map(settleThumbnail))
    .then(() => Promise.all(nextItems.slice(FIRST_SCREEN_ITEMS).map(settleThumbnail)));
}

/* ── 收藏架分段：我的 / 心愿袋 ──
   心愿袋里是「官方精选」里标记喜欢的别人的纸袋；只支持移出（不做编辑/删除） */
const segment = ref<'mine' | 'wish'>('mine');
const wishlistItems = ref<Collectible[]>([]);

function removeWish(item: CollectibleSummary) {
  if (multiTouchActive) return;
  uni.showModal({
    title: '取消心愿',
    content: `把「${item.name}」移出心愿袋？`,
    confirmText: '移出',
    success: async (result) => {
      if (!result.confirm) return;
      try {
        await dataService.removeWishlist(item.id);
        wishlistItems.value = wishlistItems.value.filter((current) => current.id !== item.id);
        uni.showToast({ title: '已移出心愿袋', icon: 'none' });
      } catch (error) {
        uni.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' });
      }
    }
  });
}

function goDiscover() { uni.switchTab({ url: '/pages/showcase/index' }); }

function load(force = false) {
  if (refreshPromise) return refreshPromise;
  if (!force && initialized.value && !shouldRefreshCollection(loadedAt, loadedRevision)) return Promise.resolve();
  const requestRevision = collectionRevision();
  if (initialized.value) refreshing.value = true;
  else loading.value = true;
  loadError.value = '';
  refreshPromise = (async () => {
    try {
      const [page, nextShelves, wish] = await Promise.all([dataService.collectibles(query()), dataService.shelves(), dataService.wishlist()]);
      wishlistItems.value = wish;
      assertRenderable(page.items, nextShelves);
      items.value = page.items;
      shelves.value = nextShelves;
      nextCursor.value = page.nextCursor;
      totalCount.value = page.totalCount;
      initialized.value = true;
      /* 新结果重新从一批开始渲染 */
      gridRenderCount.value = GRID_STEP;
      wishRenderCount.value = GRID_STEP;
      loadedAt = Date.now();
      loadedRevision = requestRevision;
      hydrateThumbnails(page.items);
    } catch (error) {
      const message = error instanceof Error ? error.message : '全部收藏加载失败';
      if (initialized.value) uni.showToast({ title: message, icon: 'none' });
      else loadError.value = message;
    } finally {
      loading.value = false;
      refreshing.value = false;
    }
  })().finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}

async function loadMore() {
  if (refreshPromise || !nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const page = await dataService.collectibles(query(nextCursor.value));
    assertRenderable(page.items, shelves.value);
    const known = new Set(items.value.map((item) => item.id));
    const added = page.items.filter((item) => !known.has(item.id));
    items.value = [...items.value, ...added];
    nextCursor.value = page.nextCursor;
    totalCount.value = page.totalCount;
    hydrateThumbnails(added);
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '加载更多失败', icon: 'none' });
  } finally {
    loadingMore.value = false;
  }
}

/* ── 搜索无结果的建议出口（对齐 H5 rankEmptyStateOptions / renderEmptyState）──
   给「当前还能搜到的」出口：品牌（来自展示架件数）+ 已知标签（来自看过的详情）。
   原型按 countBefore/countNow/countAll 打分；小程序搜索在服务端，
   拿不到全量数据，退化为按件数排序 —— 品牌优先于标签、再按文本长度。 */
const MAX_EMPTY_CHIPS = 4;
const knownTagCounts = ref<Map<string, number>>(new Map());

function bumpTagCounts(tags: string[]) {
  if (!tags.length) return;
  const next = new Map(knownTagCounts.value);
  for (const tag of tags) next.set(tag, (next.get(tag) ?? 0) + 1);
  knownTagCounts.value = next;
}

const emptyChips = computed(() => {
  const candidates: Array<{ kind: 'shelf' | 'tag'; text: string; count: number }> = [];
  for (const shelf of shelves.value) {
    if (shelf.itemCount > 0) candidates.push({ kind: 'shelf', text: shelf.name, count: shelf.itemCount });
  }
  for (const [text, count] of knownTagCounts.value) candidates.push({ kind: 'tag', text, count });
  return candidates
    .sort((a, b) =>
      b.count - a.count
      || (a.kind === b.kind ? 0 : a.kind === 'shelf' ? -1 : 1)
      || a.text.length - b.text.length)
    .slice(0, MAX_EMPTY_CHIPS);
});

function searchFor(text: string) {
  /* 点出口 = 把它填回搜索框（整体替换，语义是「换成搜这个」），对齐 H5 */
  searchText.value = text;
  applySearch(text);
}

/* ── 详情滚动底部渐隐（对齐 H5 syncDetailFade）：滚到底撕掉遮罩 ── */
const detailAtEnd = ref(false);
let detailClientHeight = 0;

function onDetailScroll(event: { detail: { scrollTop: number; scrollHeight: number } }) {
  if (!detailClientHeight) return;
  detailAtEnd.value = event.detail.scrollHeight - event.detail.scrollTop - detailClientHeight <= 2;
}

function measureDetailScroll() {
  nextTick(() => {
    const query = uni.createSelectorQuery().in(pageInstance?.proxy);
    query.select('.detail-scroll').boundingClientRect();
    query.exec((rows) => {
      const rect = rows?.[0] as { height?: number } | null;
      if (rect?.height) detailClientHeight = rect.height;
    });
  });
}

/* ── 编辑态候选下拉（对齐 H5 refreshShelfSuggest / refreshTagSuggest / ef-suggest）──
   面板在 scroll-view 内容里做成流内块：绝对定位浮层会被 scroll-view 裁掉，
   流内展开则永远完整可见 —— 这是与 H5 唯一的渲染差异。 */
interface SuggestSegments extends Array<{ t: string; hit: boolean }> {}
interface SuggestState {
  hint: string;
  keyword: string;
  exact: boolean;
  rows: Array<{ text: string; count: number; segs: SuggestSegments }>;
}

function highlightSegments(source: string, key: string): SuggestSegments {
  const at = source.toLowerCase().indexOf(key.toLowerCase());
  if (at < 0) return [{ t: source, hit: false }];
  return [
    { t: source.slice(0, at), hit: false },
    { t: source.slice(at, at + key.length), hit: true },
    { t: source.slice(at + key.length), hit: false }
  ].filter((segment) => segment.t);
}

const shelfSuggestVisible = ref(false);
const tagSuggestVisible = ref(false);
let suggestHideTimer: ReturnType<typeof setTimeout> | undefined;

/* blur 先于面板 tap 触发，延迟收起才能让点选落地 */
function hideSuggestsSoon() {
  if (suggestHideTimer) clearTimeout(suggestHideTimer);
  suggestHideTimer = setTimeout(() => {
    shelfSuggestVisible.value = false;
    tagSuggestVisible.value = false;
  }, 150);
}

function hideSuggests() {
  if (suggestHideTimer) clearTimeout(suggestHideTimer);
  shelfSuggestVisible.value = false;
  tagSuggestVisible.value = false;
}

const shelfSuggest = computed<SuggestState | null>(() => {
  const keyword = editShelf.value.trim();
  if (!keyword) return null;
  const lower = keyword.toLowerCase();
  const rows = [...shelves.value]
    .sort((a, b) => b.itemCount - a.itemCount || a.name.localeCompare(b.name, 'zh'))
    .filter((shelf) => shelf.name.toLowerCase().includes(lower) && shelf.name !== keyword)
    .slice(0, 5)
    .map((shelf) => ({ text: shelf.name, count: shelf.itemCount, segs: highlightSegments(shelf.name, keyword) }));
  const exact = shelves.value.some((shelf) => shelf.name.toLowerCase() === lower);
  if (!rows.length && exact) return null;
  return { hint: rows.length ? '已有品牌' : '没有匹配的已有品牌', keyword, exact, rows };
});

const tagSuggest = computed<SuggestState | null>(() => {
  const keyword = editTagDraft.value.trim();
  if (!keyword) return null;
  const lower = keyword.toLowerCase();
  const rows = [...knownTagCounts.value.entries()]
    .filter(([tag]) => tag.toLowerCase().includes(lower) && !editTags.value.includes(tag))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, 6)
    .map(([tag, count]) => ({ text: tag, count, segs: highlightSegments(tag, keyword) }));
  const exact = [...knownTagCounts.value.keys()].some((tag) => tag.toLowerCase() === lower);
  if (!rows.length && exact) return null;
  return { hint: rows.length ? '已有标签' : '没有匹配的已有标签', keyword, exact, rows };
});

function commitShelfPick(value: string) {
  editShelf.value = value.trim();
  shelfSuggestVisible.value = false;
}

function pickTag(tag: string) {
  const value = tag.trim().slice(0, 12);
  if (value && !editTags.value.includes(value)) {
    editTags.value = [...editTags.value, value].slice(0, 30);
  }
  editTagDraft.value = '';
}

/* ── 详情卡：轻点某一件收藏，原地弹出（对齐 H5 的 .detail-card）──
   原先是跳 package-library/pages/detail；改成浮层后，看信息不必离开收藏架。
   列表接口只给摘要，标签 / 备注 / 大图要补拉一次详情 —— 打开先用摘要把
   卡片画出来（名字、品牌、日期都在摘要里），详情回来后再补标签与备注，
   拉失败就静默降级（卡片照常可看可关），不打断浏览。 */
const detailItem = ref<CollectibleSummary | null>(null);
const detailData = ref<Collectible | null>(null);
const detailArtwork = ref('');
const detailLoading = ref(false);
/* 详情缓存按「id + updatedAt」存：收藏被改名/换架后 updatedAt 会变，
   旧缓存自然失效，不会在卡片里显示上一次的内容。 */
const detailCache = new Map<string, Collectible>();
/* 连点不同袋子时，先发的详情请求可能后到 —— 用序号丢弃过期的响应。 */
let detailToken = 0;

/* ── 编辑态：卡片原地从「看」切成「改」（对齐 H5 的 .detail-card.is-editing）──
   H5 是给卡片挂一个 .is-editing，靠一组规则把图区收小、只读区隐藏、表单展开、
   按钮从 [编辑][完成] 换成 [取消][保存]；这里用 editing 做同一套切换。

   表单字段按我们真实的数据给，没有照抄 H5 的那五行：
     · 只读条三格 = 编号 / 收藏日期 / 入库时长。H5 中间那格是「上传地点」，
       我们库里根本没有这个字段（添加入口也没采集），直接去掉；
     · 可编辑四行 = 名称 / 品牌·店铺 / 标签 / 备注。H5 的「收藏日期」不进表单 ——
       更新接口只收 name / notes / tags / shelfId，改不了 addedAt，
       要放进来得先动 contracts + api，这一版不做。 */
const editing = ref(false);
const saving = ref(false);
const editName = ref('');
const editShelf = ref('');
const editTags = ref<string[]>([]);
const editTagDraft = ref('');
const editNote = ref('');
/* 下划线变红用「聚焦类」而不是 :focus —— 小程序端 input / textarea 的 :focus
   不可靠，H5 那套 .ef-input:focus 直接搬过来多半不生效，改由 focus/blur 切类。 */
const focusedField = ref('');
const editNameFocused = ref(false);
/* 品牌候选下拉（shelfSuggest）已恢复成原型的完整交互（见下方 ef-suggest 段） */
const detailNo = computed(() => (detailItem.value ? collectibleNo(detailItem.value) : ''));
const detailTags = computed(() => detailData.value?.tags ?? []);
const detailNote = computed(() => detailData.value?.notes?.trim() ?? '');
const detailFacts = computed(() => {
  const item = detailItem.value;
  if (!item) return [];
  /* 心愿条目：addedAt 是官方上架时间，「收藏日期/入库时长」不适用，换成上架口径；
     品牌取 ownerName（feed 条目没有 shelfName）；心愿无编号（编号只在自有收藏里倒推） */
  const wish = isWishDetail.value;
  return [
    { label: '品牌 / 店铺', value: wish ? (item.ownerName ?? '官方精选') : item.shelfName },
    { label: wish ? '上架日期' : '收藏日期', value: formattedDate(item.addedAt, '-') },
    { label: wish ? '上架天数' : '入库时长', value: daysAgoText(item.addedAt) },
    { label: '编号', value: wish ? '' : detailNo.value }
  ].filter((row) => row.value);
});

/* 编号：对齐 H5 的 NO.003。后端没有 no 字段，用「总数 − 倒序下标」倒推
   （列表按 addedAt desc 返回）。注意两点：删除收藏会让后续编号前移；
   带搜索词时下标是筛选后的位置，编号会偏大 —— 与首页卡背面同一套口径，
   等后端补上 no 字段后两处一起改成直读。 */
function collectibleNo(item: CollectibleSummary) {
  if (!totalCount.value) return '';
  const index = items.value.findIndex((current) => current.id === item.id);
  if (index < 0) return '';
  return `NO.${String(Math.max(1, totalCount.value - index)).padStart(3, '0')}`;
}

/* 补拉详情（标签 / 备注 / 大图）。返回 null 表示这次没拿到。
   打开卡片的「先画后用详情补」和点「编辑」前的「必须拿到才能进表单」都走这里，
   两处只有「拿不到怎么办」不同，取数逻辑别再写第二遍。 */
async function loadDetail(item: CollectibleSummary) {
  const cacheKey = `${item.id}:${item.updatedAt}`;
  const cached = detailCache.get(cacheKey);
  if (cached) return cached;
  const token = ++detailToken;
  try {
    const detail = await dataService.collectible(item.id);
    detailCache.set(cacheKey, detail);
    /* 序号或目标藏品对不上说明用户已经换了一张（或关了卡片），这份就当没取过 */
    if (token !== detailToken || detailItem.value?.id !== item.id) return detail;
    detailData.value = detail;
    if (detail.displayImageUrl) detailArtwork.value = detail.displayImageUrl;
    detailLoading.value = false;
    bumpTagCounts(detail.tags);
    return detail;
  } catch {
    if (token === detailToken) {
      detailLoading.value = false;
      uni.showToast({ title: '标签与备注加载失败', icon: 'none' });
    }
    return null;
  }
}

/* 详情对象是否来自心愿袋：心愿条目只读，详情卡里不提供编辑入口 */
const isWishDetail = computed(() => wishlistItems.value.some((w) => w.id === detailItem.value?.id));

/* 详情卡右上角快捷钮（同首页大卡）：♥ 红实心=已在心愿袋；靶心 红环=已拥有 / 黑◎=未拥有可标记。
   已拥有（「我的」条目）不显示 ♥ —— 心愿袋语义是「想要的别人的纸袋」，自己的藏品不适用 */
const justMarkedMap = ref<Map<string, string>>(new Map());
const isOwnedDetail = computed(() => !isWishDetail.value || justMarkedMap.value.has(detailItem.value?.id ?? ''));

function detailSource(): Collectible | null {
  const item = detailItem.value;
  if (!item) return null;
  return detailData.value && detailData.value.id === item.id ? detailData.value : (item as Collectible);
}

/* ── 心愿袋动效（方案 A）：加入=♥弹跳+小爱心飞散；取消=轻微缩回 ── */
const wishPop = ref(false);
const wishShrink = ref(false);
function playWishEffect(added: boolean) {
  if (added) {
    wishPop.value = false;
    nextTick(() => {
      wishPop.value = true;
      setTimeout(() => { wishPop.value = false; }, 560);
    });
    return;
  }
  wishShrink.value = false;
  nextTick(() => {
    wishShrink.value = true;
    setTimeout(() => { wishShrink.value = false; }, 340);
  });
}
async function toggleDetailWish() {
  const item = detailItem.value; if (!item) return;
  if (isWishDetail.value) { playWishEffect(false); return void removeWish(item); }
  const source = detailSource(); if (!source) return;
  try {
    await dataService.addWishlist(source.id);
    wishlistItems.value = [source, ...wishlistItems.value];
    playWishEffect(true);
    uni.showToast({ title: '已加入心愿袋', icon: 'none' });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' });
  }
}

/* 标记已有：与其他页面统一 —— 拉起共享 mark-sheet 编辑半窗（先核对后入库） */
const markShow = ref(false);
const markItem = ref<Collectible | null>(null);
function markFromDetail() {
  const item = detailItem.value; if (!item) return;
  /* 靶心点击语义与右上角图标（isOwnedDetail）严格一致 ——
     旧版只认 justMarkedMap（仅记录本次会话刚标记的心愿条目），导致「我的」收藏条目
     明明显示红环「已拥有」，点下去却拉起「标记已有」半窗再建一条重复收藏。
     · 心愿条目本次刚标记 → 删掉标记时创建的那条收藏（撤回标记，详情卡保持打开）
     · 本来就是「我的」收藏 → 走与长按删除同一套 confirmRemove（关详情 / 出列表 / 展架件数 −1）
     · 心愿条目且未标记 → 拉起「标记已有」半窗 */
  const createdId = justMarkedMap.value.get(item.id);
  if (createdId) {
    return void uni.showModal({
      title: '删除这条收藏？',
      content: `将从收藏架删除「${item.name}」的记录。`,
      confirmText: '删除',
      confirmColor: '#9d3d36',
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await dataService.removeCollectible(createdId);
          justMarkedMap.value.delete(item.id);
          uni.showToast({ title: '已从收藏架移除', icon: 'none' });
        } catch (error) {
          uni.showToast({ title: error instanceof Error ? error.message : '移除失败', icon: 'none' });
        }
      }
    });
  }
  if (!isWishDetail.value) return void confirmRemove(item);
  markItem.value = item as Collectible;
  markShow.value = true;
}
function onMarkSaved(source: Collectible, createdId: string) {
  /* 组件已落库并自动移出心愿袋；这里同步本地心愿列表与已拥有标记 */
  justMarkedMap.value.set(source.id, createdId);
  wishlistItems.value = wishlistItems.value.filter((current) => current.id !== source.id);
}

function open(item: CollectibleSummary) {
  const cached = detailCache.get(`${item.id}:${item.updatedAt}`);
  detailItem.value = item;
  detailData.value = cached ?? null;
  /* 大图先用列表已下好的缩略图顶着（秒出），详情回来再换 displayImageUrl；
     心愿条目不在 thumbnailUrls 里，回退用条目自带图 */
  detailArtwork.value = thumbnailUrls.value[item.id] ?? item.thumbnailUrl ?? (item as Collectible).displayImageUrl ?? '';
  detailLoading.value = !cached;
  editing.value = false;
  detailAtEnd.value = false;
  measureDetailScroll();
  /* 底栏与原生导航栏在页面之外，遮罩盖不到，交给 maskPageChrome 一起蒙上 */
  maskPageChrome(true);
  if (!cached) void loadDetail(item);
}

function closeDetail() {
  detailToken += 1;
  if (detailItem.value) maskPageChrome(false);
  setTabBarHidden(false);
  detailItem.value = null;
  detailData.value = null;
  detailArtwork.value = '';
  detailLoading.value = false;
  editing.value = false;
  saving.value = false;
  editNameFocused.value = false;
  focusedField.value = '';
  hideSuggests();
}

/* ── 长按删除（展架槽 / 宫格两视图共用）──
   确认弹窗 → DELETE 接口 → 本地四处铺平：列表、展架件数、详情缓存、
   若正开着的详情卡属于它则一并关闭；markCollectionDataStale 让首页下次进入时刷新 */
/* 多指手势（双指缩放 / 两指误触）不应触发长按删除：
   touchstart 记录指头数，>1 指则本次交互屏蔽删除（longpress 在手指按住时触发） */
let multiTouchActive = false;
function onItemTouchStart(event: Event) {
  const touches = (event as unknown as { touches?: unknown[] }).touches;
  multiTouchActive = (touches?.length ?? 0) > 1;
}
function onItemTouchEnd() { multiTouchActive = false; }

async function confirmRemove(item: CollectibleSummary) {
  if (multiTouchActive) return;
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: '删除收藏',
      content: `确定删除「${item.name}」？删除后不可恢复`,
      confirmText: '删除',
      confirmColor: '#c50405',
      success: (result) => resolve(Boolean(result.confirm)),
      fail: () => resolve(false)
    });
  });
  if (!confirmed) return;
  try {
    await dataService.removeCollectible(item.id);
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '删除失败', icon: 'none' });
    return;
  }
  if (detailItem.value?.id === item.id) closeDetail();
  detailCache.delete(`${item.id}:${item.updatedAt}`);
  items.value = items.value.filter((current) => current.id !== item.id);
  shelves.value = shelves.value.map((shelf) => (shelf.id === item.shelfId && shelf.itemCount > 0
    ? { ...shelf, itemCount: shelf.itemCount - 1 }
    : shelf));
  markCollectionDataStale();
  uni.showToast({ title: '已删除', icon: 'none' });
}

function goAdd() {
  uni.navigateTo({ url: '/package-editor/pages/add/index' });
}

/* ── 进 / 出编辑态 ──
   表单里要填标签与备注，而列表摘要里没有这两样：详情还没回来就先去取一份，
   取不到就不进编辑态 —— 否则一保存会把标签和备注一起清空（这是最贵的一种失手）。 */
async function startEdit() {
  const item = detailItem.value;
  if (!item) return;
  const detail = detailData.value ?? await loadDetail(item);
  if (!detail) return void uni.showToast({ title: '标签与备注还没读出来，稍后再试', icon: 'none' });
  if (detailItem.value?.id !== item.id) return;
  editName.value = detail.name;
  editShelf.value = detail.shelfName;
  editTags.value = [...detail.tags];
  editTagDraft.value = '';
  editNote.value = detail.notes ?? '';
  focusedField.value = '';
  editing.value = true;
  /* 底栏是框架层，页面 z-index 压不住：半窗打开时整条隐藏，关闭时还原 */
  setTabBarHidden(true);
  hideSuggests();
  /* H5 也是「等切换的样式落定再聚焦」（它等 140ms），
     立刻聚焦会在布局变化中途触发滚动，卡片会先跳一下。 */
  setTimeout(() => { if (editing.value) editNameFocused.value = true; }, 150);
}

/* 退出编辑态：不写回任何值，表单内容丢弃；半窗与详情卡一并关闭回列表 */
function cancelEdit() {
  commitTags();
  closeDetail();
}

/* 「名称 / 品牌 / 备注」三个输入框共用一个取值写法：
   vue-tsc 拿的是 HTML <input> 的类型，参数标成 uni 的 { detail: { value } }
   会被判成「与 Event 无交集」，只能按 Event 收再自己取 detail.value。 */
function inputValue(event: Event) {
  return (event as unknown as { detail?: { value?: string } }).detail?.value ?? '';
}

function onEditNameInput(event: Event) { editName.value = inputValue(event); }
function onEditShelfInput(event: Event) {
  editShelf.value = inputValue(event);
  shelfSuggestVisible.value = Boolean(editShelf.value.trim());
}
function onEditNoteInput(event: Event) { editNote.value = inputValue(event); }

/* 标签输入：打字期间**不**按空格切分。
   小程序的 input 没有 compositionstart / end，中文输入法下「空格」是在选字，
   边打边切会把「霸王茶姬」断成两个标签（H5 专门写了 composition 守卫处理这件事）。
   分词改在回车 / 失焦 / 保存这几个时点做 —— 粘贴进来的「茶饮 国风」照样拆成两个。 */
function onTagInput(event: Event) {
  editTagDraft.value = inputValue(event);
  tagSuggestVisible.value = Boolean(editTagDraft.value.trim());
}

function commitTags() {
  const parts = editTagDraft.value.split(/[\s,，、;；]+/)
    .map((tag) => tag.trim().slice(0, 12))
    .filter(Boolean);
  if (parts.length) {
    const next = [...editTags.value];
    for (const tag of parts) if (!next.includes(tag)) next.push(tag);
    editTags.value = next.slice(0, 30);
  }
  editTagDraft.value = '';
}

function removeTag(tag: string) {
  editTags.value = editTags.value.filter((current) => current !== tag);
}

/* 保存成功后把改动铺回三处，不然卡片、列表、展架件数会各说各话。 */
function applyUpdated(updated: Collectible) {
  const previous = detailItem.value;
  if (previous) {
    /* 旧缓存键跟着 updatedAt 走，改完就失效了，顺手清掉别留在 Map 里 */
    detailCache.delete(`${previous.id}:${previous.updatedAt}`);
    detailItem.value = {
      ...previous,
      name: updated.name,
      shelfId: updated.shelfId,
      shelfName: updated.shelfName,
      updatedAt: updated.updatedAt
    };
    /* 换了展示架就按差值挪件数。这里不用「本地重算」：items 只装了已加载的那几页，
       重算会把没加载到的收藏漏掉，件数越用越小。 */
    if (previous.shelfId !== updated.shelfId) {
      shelves.value = shelves.value.map((shelf) => {
        if (shelf.id === previous.shelfId) return { ...shelf, itemCount: Math.max(0, shelf.itemCount - 1) };
        if (shelf.id === updated.shelfId) return { ...shelf, itemCount: shelf.itemCount + 1 };
        return shelf;
      });
    }
  }
  detailCache.set(`${updated.id}:${updated.updatedAt}`, updated);
  detailData.value = updated;
  bumpTagCounts(updated.tags);
  /* 列表里的摘要也要跟着改：宫格 / 展架两套视图、还有分组都读它。
     shelfId 一动，这件收藏在新展示架的分组里就自动出现了（groups 是按 shelfId 现算的）。 */
  items.value = items.value.map((current) => (current.id === updated.id
    ? { ...current, name: updated.name, shelfId: updated.shelfId, shelfName: updated.shelfName, updatedAt: updated.updatedAt }
    : current));
}

async function saveEdit() {
  const item = detailItem.value;
  if (!item || saving.value) return;
  /* 输入框里可能还留着没敲回车的半截词，保存时一并收走（H5 的 commitTagsFromInput），
     否则「打了字直接点保存」这个词会静默丢掉 */
  commitTags();
  const name = editName.value.trim();
  if (!name) return void uni.showToast({ title: '请填写收藏名称', icon: 'none' });
  /* 品牌清空则回落到原展示架：H5 同样这么做，避免误删之后整条收藏挂到空分组下 */
  const shelfName = editShelf.value.trim() || item.shelfName;
  const tags = [...editTags.value];
  const notes = editNote.value.trim();
  saving.value = true;
  try {
    let shelf = shelves.value.find((current) => current.name === shelfName);
    if (!shelf) {
      /* 写的是新品牌 → 建一个（后端 Shelf 有 @@unique([userId, name])，所以先按名字找、
         找不到才建，重复建会直接 500）。主题给默认的 SAGE，颜色可在设置里改。 */
      shelf = await dataService.createShelf({ name: shelfName, theme: 'SAGE' });
      shelves.value = [...shelves.value, shelf];
    }
    const updated = await dataService.updateCollectible(item.id, { name, notes, tags, shelfId: shelf.id });
    applyUpdated(updated);
    /* 保存后半窗与卡片一并关闭，回到列表（applyUpdated 已把改动铺进列表） */
    closeDetail();
    uni.showToast({ title: `“${name}”已更新`, icon: 'none' });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' });
  } finally {
    saving.value = false;
  }
}

/* 遮罩上吞掉 touchmove：页面在浮层后面不再跟着手指滚 */
function blockScroll() {}

/* 底栏护垫（.tab-shield）的 tap 处理：故意什么都不做 ——
   它存在的唯一意义就是把「穿透下来的点击」接住，别让它落到收藏卡上。 */
function swallowTabBarTap() {}

function add() {
  uni.navigateTo({ url: '/package-editor/pages/add/index' });
}

function toggleMode() {
  displayMode.value = displayMode.value === 'shelf' ? 'grid' : 'shelf';
  /* 切回展架视图时行 DOM 是重新挂载的，重新量一次行宽与滚动位置 */
  if (displayMode.value === 'shelf') measureShelves();
}

/* ── 宫格画廊 ──
   固定 4 列起步、无横向滚动，双指捏合在 4~8 列间缩放：
   卡宽 = (屏宽 − 左右留白 − 列间距) ÷ 列数，其余尺寸随卡宽等比派生（视觉口径不变）。
   列数 = 4 时：4×卡宽 + 3×间距 + 2×左右留白 = 750rpx。 */
const GRID_COLS_MAX_CARD = 4;
const GRID_COLS_MIN_CARD = 8;
const GRID_PAD = 24;
const GRID_GAP = 18;
const gridCols = ref(GRID_COLS_MAX_CARD);
let pinchStartDist = 0;
let pinchStartCols = GRID_COLS_MAX_CARD;

function pinchDistance(touches: Array<{ x: number; y: number }>) {
  const dx = touches[0].x - touches[1].x;
  const dy = touches[0].y - touches[1].y;
  return Math.hypot(dx, dy);
}
function gridTouchStart(event: Event) {
  const touches = (event as unknown as { touches?: Array<{ x?: number; clientX?: number; y?: number; clientY?: number }> }).touches;
  if (!touches || touches.length !== 2) return;
  pinchStartDist = pinchDistance(touches.map((t) => ({ x: t.x ?? t.clientX ?? 0, y: t.y ?? t.clientY ?? 0 })));
  pinchStartCols = gridCols.value;
}
function gridTouchMove(event: Event) {
  if (!pinchStartDist) return;
  const touches = (event as unknown as { touches?: Array<{ x?: number; clientX?: number; y?: number; clientY?: number }> }).touches;
  if (!touches || touches.length !== 2) return;
  const dist = pinchDistance(touches.map((t) => ({ x: t.x ?? t.clientX ?? 0, y: t.y ?? t.clientY ?? 0 })));
  /* 双指张开 = 放大 = 列数变少；捏合 = 缩小 = 列数变多 */
  const next = Math.round(pinchStartCols / (dist / pinchStartDist));
  gridCols.value = Math.min(GRID_COLS_MIN_CARD, Math.max(GRID_COLS_MAX_CARD, next));
}
function gridTouchEnd() { pinchStartDist = 0; }
/* 宫格改为增量渲染：首屏渲染一批，滚到底部再追加一批（避免一次性渲染上千个节点卡顿）。
   不再有「只显示前 N 件」的硬上限 */
const GRID_STEP = 120;
const gridRenderCount = ref(GRID_STEP);
const wishRenderCount = ref(GRID_STEP);
function appendGridRender() {
  if (segment.value === 'wish') {
    if (wishRenderCount.value < visibleWishlist.value.length) wishRenderCount.value += GRID_STEP;
    return;
  }
  if (displayMode.value === 'grid' && gridRenderCount.value < items.value.length) gridRenderCount.value += GRID_STEP;
}
/* 卡宽 = (屏宽 − 左右留白 − 列间距) ÷ 列数（向下取整，避免合计超出屏宽） */
const gridW = computed(() => Math.floor((750 - 2 * GRID_PAD - (gridCols.value - 1) * GRID_GAP) / gridCols.value));
/* 尺寸比例沿用原最大档（卡高/图高 ÷ 卡宽 = 1.416 / 1.195），随卡宽等比缩放 */
const gridCardH = computed(() => Math.round(gridW.value * 1.4161));
const gridArtH = computed(() => Math.round(gridW.value * 1.1946));
const gridArtPad = computed(() => Math.round(gridW.value * 0.0732));
const gridRadius = computed(() => Math.round(gridW.value * 0.17073));
const gridGap = computed(() => GRID_GAP);
const gridPadX = computed(() => GRID_PAD);
const gridItems = computed(() => items.value.slice(0, gridRenderCount.value));
const wishGridItems = computed(() => visibleWishlist.value.slice(0, wishRenderCount.value));
const gridOverflow = computed(() => items.value.length - gridItems.value.length);

/* ── 展架配色对齐 H5：按行序轮换三色（3n+1 琥珀 / 3n+2 天蓝 / 3n 鼠尾草），
   品牌特例：瑞幸 → ROSE 正粉（H5 对瑞幸写死的特例口径，覆盖行序） ── */
const SHELF_CYCLE = ['AMBER', 'SKY', 'SAGE'] as const;

function shelfToneClass(shelfName: string, index: number) {
  return `acrylic-shelf--${shelfName.includes('瑞幸') ? 'ROSE' : SHELF_CYCLE[index % SHELF_CYCLE.length]}`;
}

/* 生效搜索词。「我的」分段 = 重取第一页（服务端搜索）；「心愿袋」分段 = 本地过滤
   （心愿条目全量在内存里，不值得为一两个词打接口）。keyword 没变就直接返回 ——
   否则输入框「打完最后一个字」和「回车」会各触发一次同样的请求。 */
function applySearch(value: string) {
  const next = value.trim();
  if (next === keyword.value) return;
  keyword.value = next;
  if (segment.value === 'mine') void load(true);
}

/* 心愿袋本地过滤：名称 / 品牌（ownerName）/ 标签任一命中即保留 */
const visibleWishlist = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return wishlistItems.value;
  return wishlistItems.value.filter((item) =>
    item.name.toLowerCase().includes(kw) ||
    (item.ownerName ?? '').toLowerCase().includes(kw) ||
    item.tags.some((tag) => tag.toLowerCase().includes(kw)));
});

/* 切分段时清掉上一段的搜索词：两段共用一个输入框，残留关键词语义会串 */
function switchSegment(next: 'mine' | 'wish') {
  if (segment.value === next) return;
  segment.value = next;
  clearSearch();
}

/* 事件按原生 Event 收参：vue-tsc 拿的是 HTML <input> 的类型，
   直接把参数标成 uni 的 { detail: { value } } 会被判成「与 Event 无交集」。
   运行时（小程序/uni 的 input）detail.value 一定在，取不到就当空串，等价于清空。 */
function onSearchInput(event: Event) {
  searchText.value = (event as unknown as { detail?: { value?: string } }).detail?.value ?? '';
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applySearch(searchText.value), 300);
}

function clearSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchText.value = '';
  applySearch('');
}

onShow(() => {
  syncTabBar(1);
  /* ⚠ 这里刻意不复位底栏的隐藏态：它由 open / startEdit 与 closeDetail 成对维护
     （详情卡与编辑半窗都会让底栏整条收起，关闭时还原）。输入框聚焦弹键盘时
     页面也可能走一次 onShow，在这清掉隐藏态就等于「半窗里点一下输入框，底栏又冒出来」。
     页面被切走的情况由 onHide -> closeDetail() 兜住。 */
  if (!initialized.value || shouldRefreshCollection(loadedAt, loadedRevision)) void load();
});
/* 页面被切走（跳编辑页、切 tab）时收起浮层，回来不会还压着一层 */
onHide(() => { closeDetail(); closeSettings(); if (markShow.value) markShow.value = false; });
/* 分享：转发给朋友 / 分享到朋友圈 */
onShareAppMessage(() => ({
  title: '袋袋集 · 我的纸袋收藏架',
  path: '/pages/library/index'
}));
onShareTimeline(() => ({
  title: '袋袋集 · 我的纸袋收藏架',
  query: ''
}));
/* 设置半窗（自首页迁入）：上滑进入、下滑收起；底栏是框架层压不住，打开期间整条隐藏 */
const settingsShow = ref(false);
function openSettings() { settingsShow.value = true; setTabBarHidden(true); }
function closeSettings() { settingsShow.value = false; setTabBarHidden(false); }
/* 顶部标题区固定后，触底加载与下拉刷新都迁移到内容区的 scroll-view 上 */
const refresherTriggered = ref(false);
async function onRefresherRefresh() {
  refresherTriggered.value = true;
  try { await load(true); } finally { refresherTriggered.value = false; }
}
function onScrollToLower() {
  /* 宫格是竖向排布：到底时先把手上已加载的数据多渲染一批（增量渲染），
     同时照常触发下一页加载 */
  appendGridRender();
  void loadMore();
}
</script>

<template>
  <view class="library-page">
    <!-- 头部：大标题在上、副文案在下（2026-09-26 起：切换钮移到搜索栏右侧；
         自定义导航，标题区顶部与右上角胶囊按钮顶部对齐，整体上移）。
         ⚠ 这里不做骨架屏（首页也没有）：标题是静态文案，拿白色占位块顶一下的话，
         从首页切过来会先闪一块白再换成文字（用户 2026-09-24 报过「先白再展示」）。
         头部恒显（对齐原型：零数据时不切换成别的头，计数显示 0 即可）。 -->
    <view v-if="!loadError" class="library-header" :style="{ paddingTop: `${headerTop}px` }">
      <view class="library-copy">
        <!-- 顶部大字标题换成两个页内 Tab：我的 ｜ 心愿袋（下划线指示当前段） -->
        <view class="library-tabs">
          <button class="library-tab" :class="{ 'is-on': segment === 'mine' }" @tap="switchSegment('mine')">我的</button>
          <button class="library-tab" :class="{ 'is-on': segment === 'wish' }" @tap="switchSegment('wish')">心愿袋</button>
        </view>
        <!-- 计数要等接口，首屏先不写「0 件收藏」——那一行的高度由 .library-copy 的
             min-height 占着，数字回来时下面的搜索框不会往上跳。 -->
        <text v-if="initialized && segment === 'mine'" class="library-summary">{{ totalCount }} 件收藏 · {{ groups.length }} 个展示架</text>
        <text v-else-if="initialized && segment === 'wish'" class="library-summary">心愿袋 · {{ wishlistItems.length }} 件</text>
      </view>
    </view>
    <!-- 设置钮：固定贴在微信胶囊左侧（top/right/尺寸由胶囊矩形注入，任何机型与胶囊严格同轴） -->
    <button
      class="header-settings"
      aria-label="打开设置"
      :style="{ top: `${headerTop}px`, right: `${settingsRight}px`, width: `${settingsSize}px`, height: `${settingsSize}px` }"
      @tap="openSettings"
    >
      <image class="header-settings__icon" :style="{ width: `${Math.round(settingsSize * 0.7)}px`, height: `${Math.round(settingsSize * 0.7)}px` }" src="/static/figma/settings-nut.svg" mode="aspectFit" />
    </button>

    <!-- 内容区独立滚动：顶部标题区固定不滚（搜索栏随内容一起滚动） -->
    <scroll-view
      class="library-scroll"
      scroll-y
      enhanced
      :show-scrollbar="false"
      :refresher-enabled="false"
      :refresher-triggered="refresherTriggered"
      refresher-default-style="black"
      @refresherrefresh="onRefresherRefresh"
      @scrolltolower="onScrollToLower"
    >
      <view class="library-body">
    <!-- 搜索栏一行：两段共用（心愿袋分段本地过滤）；右侧「宫格 / 展架」切换钮仅「我的」显示 -->
    <view v-if="initialized && !loadError" class="search-row">
      <view class="search-box">
        <image class="search-icon" src="/static/figma/search.svg" mode="aspectFit" />
        <input
          class="search-input"
          :value="searchText"
          type="text"
          confirm-type="search"
          :placeholder="segment === 'wish' ? '搜索心愿袋' : '搜索名称 / 品牌 / 标签'"
          placeholder-class="search-placeholder"
          @input="onSearchInput"
          @confirm="applySearch(searchText)"
        />
        <text v-if="searchText" class="search-clear" @tap="clearSearch">×</text>
      </view>
      <!-- 切换钮心愿袋段不显示，但保留占位（visibility:hidden）——
           否则该段搜索框失去右侧兄弟后整行塌高、宽度拉通，与「我的」段 UI 不一致 -->
      <button class="mode-button" :class="{ 'is-ghost': segment !== 'mine' }" hover-class="is-pressed" :hover-stay-time="80" :aria-label="displayMode === 'shelf' ? '切换为宫格展示' : '切换为展架展示'" @tap="toggleMode">
        <image :src="displayMode === 'shelf' ? '/static/figma/grid.svg' : '/static/figma/shelf.svg'" mode="aspectFit" />
        <text>{{ displayMode === 'shelf' ? '宫格' : '展架' }}</text>
      </button>
    </view>
    <!-- 「我的」分段：展架/宫格、详情、长按删除（心愿袋分段没有这些操作） -->
    <template v-if="segment === 'mine'">
    <view v-if="loading && !initialized" class="shelf-list skeleton-list">
      <view v-for="index in 2" :key="index" class="skeleton-shelf">
        <view class="skeleton-text skeleton-text--shelf" />
        <view class="skeleton-items">
          <view v-for="item in 4" :key="item" class="skeleton-item" />
        </view>
        <view class="skeleton-board" />
      </view>
    </view>

    <view v-else-if="loadError" class="load-error">{{ loadError }}</view>

    <!-- 搜索无结果：H5 方案 5 大字水印 + 方案 2 的标签出路。
         标签是「还能搜到的」出口，点一下=换成搜它；清空搜索按钮撤掉
         （搜索框右侧有 ×，再放按钮是重复入口，H5 注释原文）。 -->
    <view v-else-if="!items.length && hasSearch" class="search-empty">
      <text class="search-empty__mark">没有结果</text>
      <text class="search-empty__sub">「{{ keyword }}」不在你的收藏里</text>
      <view v-if="emptyChips.length" class="empty-chips">
        <view
          v-for="chip in emptyChips"
          :key="`${chip.kind}:${chip.text}`"
          class="empty-chip"
          hover-class="is-pressed"
          :hover-stay-time="80"
          @tap="searchFor(chip.text)"
        >{{ chip.text }}</view>
      </view>
    </view>

    <!-- 零数据空态：一条收藏都没有（首次使用 / 长按删除清空后）。
         此分支此前缺失，空列表时内容区域直接空白，看起来像「页面没有内容了」 -->
    <view v-else-if="!items.length" class="zero-state">
      <image class="zero-state__art" src="/static/figma/empty-state.png" mode="aspectFit" />
      <text class="zero-state__title">还没有收藏</text>
      <text class="zero-state__sub">拍下你的第一个纸袋，开始你的陈列柜</text>
      <button class="zero-state__cta" @tap="goAdd">去添加收藏</button>
    </view>

    <view v-else-if="displayMode === 'shelf'" class="shelf-list">
      <view v-for="(group, groupIndex) in groups" :key="group.id" class="shelf-group">
        <view class="shelf-heading">
          <text class="shelf-name">{{ group.name }}</text>
          <view class="shelf-hint">
            <text class="shelf-hint__count">共{{ group.items.length }}件</text>
            <!-- 箭头恒定显示（不按能否滑动显隐，右缘才不会漂移）；
                 到端后对应箭头只淡不隐（opacity .18），对齐 H5 -->
            <view
              class="shelf-hint__arrow"
              :class="{ 'is-dim': shelfEdge[group.id]?.start }"
              hover-class="is-pressed"
              :hover-stay-time="80"
              @tap="scrollShelfBy(group.id, -1)"
            >
              <image src="/static/figma/arrow-left.svg" mode="aspectFit" />
            </view>
            <view
              class="shelf-hint__arrow"
              :class="{ 'is-dim': shelfEdge[group.id]?.end }"
              hover-class="is-pressed"
              :hover-stay-time="80"
              @tap="scrollShelfBy(group.id, 1)"
            >
              <image src="/static/figma/arrow-right.svg" mode="aspectFit" />
            </view>
          </view>
        </view>
        <scroll-view
          :id="`shelf-scroll-${group.id}`"
          class="shelf-scroll"
          scroll-x
          enhanced
          :show-scrollbar="false"
          scroll-with-animation
          :scroll-left="shelfScrollLeft[group.id] ?? 0"
          @scroll="onShelfScroll(group.id, $event)"
          @touchstart="shelfTouchStart"
          @touchend="snapShelf(group.id)"
        >
          <view class="shelf-items">
            <button v-for="item in group.items" :key="item.id" class="shelf-item" @tap="open(item)" @longpress="confirmRemove(item)" @touchstart="onItemTouchStart" @touchend="onItemTouchEnd" @touchcancel="onItemTouchEnd">
              <image
                v-if="thumbnailUrls[item.id] && !failedThumbnails[item.id]"
                class="shelf-image"
                :src="thumbnailUrls[item.id]"
                mode="aspectFit"
                lazy-load
                :style="{ width: `${shelfImageWidth(item.id)}rpx`, height: `${SHELF_IMAGE_HEIGHT}rpx` }"
                @error="failedThumbnails[item.id] = true"
              />
              <view v-else class="shelf-image-placeholder" />
            </button>
          </view>
        </scroll-view>
        <view class="acrylic-shelf" :class="shelfToneClass(group.name, groupIndex)">
          <view class="shelf-fastener shelf-fastener--left" />
          <view class="shelf-fastener shelf-fastener--right" />
        </view>
      </view>
    </view>

    <!-- 宫格画廊（H5 .grid-window / .grid-stage / .collection-grid）：
         横向滚动 + 双指捏合在 82↔41px（149↔75rpx）连续插值，
         卡宽是唯一真源，卡高/间隙/圆角/内缩全部由它派生（对齐 H5 gridVars）。 -->
    <view
      v-else
      class="grid-window"
      @touchstart="gridTouchStart"
      @touchmove="gridTouchMove"
      @touchend="gridTouchEnd"
      @touchcancel="gridTouchEnd"
    >
      <view class="grid-stage">
        <view
          class="collection-grid"
          :style="{ gridTemplateColumns: `repeat(${gridCols}, ${gridW}rpx)`, gap: `${gridGap}rpx`, padding: `0 ${gridPadX}rpx` }"
        >
          <button
            v-for="item in gridItems"
            :key="item.id"
            class="grid-item"
            :style="{ width: `${gridW}rpx`, height: `${gridCardH}rpx`, borderRadius: `${gridRadius}rpx` }"
            @tap="open(item)"
            @longpress="confirmRemove(item)"
            @touchstart="onItemTouchStart"
            @touchend="onItemTouchEnd"
            @touchcancel="onItemTouchEnd"
          >
            <image
              v-if="thumbnailUrls[item.id] && !failedThumbnails[item.id]"
              :src="thumbnailUrls[item.id]"
              mode="aspectFit"
              lazy-load
              :style="{ width: `${gridW - gridArtPad * 2}rpx`, height: `${gridArtH}rpx` }"
              @error="failedThumbnails[item.id] = true"
            />
            <view v-else class="grid-image-placeholder" />
          </button>
        </view>
        <text v-if="gridOverflow > 0" class="grid-overflow-note" :style="{ padding: `0 ${gridPadX}rpx` }">已显示 {{ gridItems.length }} / 共 {{ items.length }} 件 · 下滑加载更多</text>
      </view>
    </view>

    <text v-if="loadingMore" class="page-loading">正在加载更多…</text>
    </template>

    <!-- 「心愿袋」分段：与「我的」宫格同款横滑网格（同尺寸/同捏合缩放），
         卡片用虚线边框 + 素底标识「未收入」；长按 = 移出心愿袋（对应「我的」的长按删除） -->
    <template v-else>
      <view v-if="!initialized" class="skeleton-list"><view class="skeleton-shelf"><view class="skeleton-text skeleton-text--shelf" /></view></view>
      <view v-else-if="!wishlistItems.length" class="wish-empty">
        <image class="wish-empty__art" src="/static/figma/empty-state.png" mode="aspectFit" />
        <text class="wish-empty__title">心愿袋空空的</text>
        <text class="wish-empty__sub">去发现页逛逛，把喜欢的纸袋收进来</text>
        <button class="wish-empty__cta" @tap="goDiscover">去发现页</button>
      </view>
      <view
        v-else
        class="grid-window"
        @touchstart="gridTouchStart"
        @touchmove="gridTouchMove"
        @touchend="gridTouchEnd"
        @touchcancel="gridTouchEnd"
      >
        <view class="grid-stage">
          <view
            class="collection-grid"
            :style="{ gridTemplateColumns: `repeat(${gridCols}, ${gridW}rpx)`, gap: `${gridGap}rpx`, padding: `0 ${gridPadX}rpx` }"
          >
            <button
              v-for="item in wishGridItems"
              :key="item.id"
              class="grid-item grid-item--wish"
              :style="{ width: `${gridW}rpx`, height: `${gridCardH}rpx`, borderRadius: `${gridRadius}rpx` }"
              @tap="open(item)"
              @longpress="removeWish(item)"
              @touchstart="onItemTouchStart"
              @touchend="onItemTouchEnd"
              @touchcancel="onItemTouchEnd"
            >
              <image
                v-if="item.displayImageUrl || item.thumbnailUrl"
                :src="item.displayImageUrl || item.thumbnailUrl"
                mode="aspectFit"
                lazy-load
                :style="{ width: `${gridW - gridArtPad * 2}rpx`, height: `${gridArtH}rpx` }"
              />
              <view v-else class="grid-image-placeholder" />
            </button>
          </view>
          <text v-if="visibleWishlist.length > wishGridItems.length" class="grid-overflow-note" :style="{ padding: `0 ${gridPadX}rpx` }">已显示 {{ wishGridItems.length }} / 共 {{ visibleWishlist.length }} 件 · 下滑加载更多</text>
        </view>
      </view>
      <view v-if="initialized && wishlistItems.length && !visibleWishlist.length" class="wish-empty wish-empty--narrow">
        <text class="wish-empty__title">没有匹配的心愿</text>
        <text class="wish-empty__sub">换个关键词试试，或清空搜索查看全部</text>
      </view>
    </template>
      </view>
    </scroll-view>

    <!-- 详情浮层：轻点收藏原地弹出（对齐 H5 的 .detail-card）。
         三层结构照搬 H5：玻璃背景层 / 滚动内容层 / 固定按钮层 —— 按钮独立成层
         才不会被内容滚走。 -->
    <view v-if="detailItem" class="detail-layer">
      <view class="detail-backdrop" @tap="closeDetail" @touchmove.stop.prevent="blockScroll" />
      <!-- 编辑半窗拉起时卡片让位关闭（半窗 + 遮罩独占屏幕） -->
      <view v-show="!editing" class="detail-card">
        <!-- 右上角快捷操作（同首页大卡）：♥ 红实心=已在心愿袋 / 空心=未加入；
             靶心 红环=已拥有 / 黑◎=未拥有（点按选展架直接收进） -->
        <view class="detail-quick">
          <view v-if="isWishDetail" class="detail-quick__btn" hover-class="is-pressed" :hover-stay-time="80" @tap.stop="toggleDetailWish">
            <image class="detail-quick__icon like-icon" :class="{ 'is-pop': wishPop, 'is-shrink': wishShrink }" src="/static/figma/heart-active.svg" mode="aspectFit" />
          </view>
          <view class="detail-quick__btn" hover-class="is-pressed" :hover-stay-time="80" @tap.stop="markFromDetail">
            <image class="detail-quick__icon" :src="isOwnedDetail ? '/static/figma/target-marked.svg' : '/static/figma/target.svg'" mode="aspectFit" />
          </view>
        </view>
        <view class="detail-glass">
          <view class="detail-glow" />
          <view class="detail-noise" />
          <view class="detail-beam-glow" />
          <view class="detail-beam" />
        </view>

        <!-- enhanced 必须开：微信的 show-scrollbar 属于「增强特性属性」，
             只在 enhanced 为 true 时生效 —— 只写 show-scrollbar="false" 时
             卡片右侧还是会冒出一条竖向滚动条 -->
        <scroll-view
          class="detail-scroll"
          :class="{ 'is-at-end': detailAtEnd }"
          scroll-y
          enhanced
          :show-scrollbar="false"
          @scroll="onDetailScroll"
        >
          <!-- 顶部大图：编辑表单已移入半窗，卡片始终展示完整图区 -->
          <view class="detail-artwork">
            <image v-if="detailArtwork" :src="detailArtwork" mode="aspectFit" />
            <view v-else class="detail-artwork__placeholder" />
          </view>

          <!-- 只读区（编辑不再在本卡内切换，表单见下方 edit-sheet 半窗） -->
          <view>
            <text v-if="detailNo" class="detail-eyebrow">{{ detailNo }}</text>
            <text class="detail-name">{{ detailItem.name }}</text>
            <text class="detail-brand">{{ isWishDetail ? (detailItem.ownerName ?? '官方精选') : detailItem.shelfName }}</text>
            <view class="detail-divider" />
            <view class="detail-facts">
              <view v-for="row in detailFacts" :key="row.label" class="detail-facts__row">
                <text class="detail-facts__key">{{ row.label }}</text>
                <text class="detail-facts__value">{{ row.value }}</text>
              </view>
            </view>
            <view v-if="detailTags.length" class="detail-tags">
              <text v-for="tag in detailTags" :key="tag"># {{ tag }}</text>
            </view>
            <text v-if="detailNote" class="detail-note">{{ detailNote }}</text>
            <text v-if="detailLoading && !detailTags.length && !detailNote" class="detail-loading">正在读取标签与备注…</text>
          </view>
        </scroll-view>

        <!-- 底部动作区：详情态 [编辑][完成]；心愿条目只读，仅 [完成] -->
        <view class="detail-actions">
          <button v-if="!isWishDetail" class="detail-edit" @tap="startEdit()">编辑</button>
          <button class="detail-done" @tap="closeDetail()">完成</button>
        </view>
      </view>
    </view>

    <!-- 设置半窗（自首页迁入）：蒙层 + 上滑进入/下滑收起（fixed 定位，放在滚动区外） -->
    <settings-sheet :show="settingsShow" @close="closeSettings" />

    <!-- 标记已有半窗：共享组件（与首页统一交互）；心愿条目标记成功后自动移出心愿袋 -->
    <mark-sheet :show="markShow" :item="markItem" :wished="true" @close="markShow = false" @saved="onMarkSaved" />

    <!-- 编辑半窗（H5 .bottom-sheet 几何：圆角 32px 32px 0 0 / .38s 上滑）。
         表单 UI 与交互不变：下划线纸感版式、品牌/标签候选、保存/取消口径全保留；
         容器从「卡片内切换」改为「底部半窗弹出」，点遮罩 = 取消（不写回任何值）。 -->
    <view v-if="detailItem && editing" class="edit-layer">
      <view class="detail-backdrop" @tap="cancelEdit" @touchmove.stop.prevent="blockScroll" />
      <view class="edit-sheet">
        <view class="sheet-handle" />
        <scroll-view class="edit-scroll" scroll-y enhanced :show-scrollbar="false">
          <!-- 图区沿用编辑态收小的那档（168→128px），与原表单一致 -->
          <view class="detail-artwork detail-artwork--editing">
            <image v-if="detailArtwork" :src="detailArtwork" mode="aspectFit" />
            <view v-else class="detail-artwork__placeholder" />
          </view>
          <view>
            <!-- ① 只读条：值在上、名在下，三块两端对齐（首块靠左、末块靠右，
                 中间那块吃掉剩余空间）。不可编辑的三项一次看完，不跟输入框混在一起。 -->
            <view class="ef-readout">
              <view class="ef-readout__cell ef-readout__cell--no">
                <text class="ef-readout__v">{{ detailNo || '—' }}</text>
                <text class="ef-readout__k">编号</text>
              </view>
              <view class="ef-readout__cell ef-readout__cell--mid">
                <text class="ef-readout__v">{{ formattedDate(detailItem.addedAt, '-') }}</text>
                <text class="ef-readout__k">收藏日期</text>
              </view>
              <view class="ef-readout__cell ef-readout__cell--last">
                <text class="ef-readout__v">{{ daysAgoText(detailItem.addedAt) }}</text>
                <text class="ef-readout__k">入库时长</text>
              </view>
            </view>

            <!-- ② 可编辑行：左标签 + 右值，值下面一条底线 -->
            <view class="ef-row">
              <text class="ef-key">名称</text>
              <view class="ef-val">
                <input
                  class="ef-input"
                  :class="{ 'is-focus': focusedField === 'name' }"
                  :value="editName"
                  :focus="editNameFocused"
                  type="text"
                  maxlength="24"
                  placeholder="给它起个名字"
                  placeholder-class="ef-placeholder"
                  @input="onEditNameInput"
                  @focus="focusedField = 'name'"
                  @blur="focusedField = ''"
                />
              </view>
            </view>

            <view class="ef-row">
              <text class="ef-key">品牌 / 店铺</text>
              <view class="ef-val">
                <input
                  class="ef-input"
                  :class="{ 'is-focus': focusedField === 'shelf' }"
                  :value="editShelf"
                  type="text"
                  maxlength="20"
                  placeholder="选一个或直接输入"
                  placeholder-class="ef-placeholder"
                  @input="onEditShelfInput"
                  @focus="focusedField = 'shelf'; shelfSuggestVisible = Boolean(editShelf.trim())"
                  @blur="focusedField = ''; hideSuggestsSoon()"
                />
                <!-- 候选下拉（对齐 H5 ef-suggest）：命中子串红色加粗、右侧「已有 N 件」、
                     未精确命中给「＋ 新建品牌」。原型是绝对定位浮层，这里做流内展开 ——
                     scroll-view 会裁掉浮层，流内块永远完整可见。 -->
                <view v-if="shelfSuggestVisible && shelfSuggest" class="ef-suggest">
                  <text class="ef-suggest__hint">{{ shelfSuggest.hint }}</text>
                  <view
                    v-for="row in shelfSuggest.rows"
                    :key="row.text"
                    class="ef-suggest__item"
                    hover-class="is-hover"
                    :hover-stay-time="80"
                    @tap="commitShelfPick(row.text)"
                  >
                    <text class="ef-suggest__label"><text v-for="(seg, i) in row.segs" :key="i" :class="{ 'is-hit': seg.hit }">{{ seg.t }}</text></text>
                    <text class="ef-suggest__count">已有 {{ row.count }} 件</text>
                  </view>
                  <view v-if="!shelfSuggest.exact" class="ef-suggest__item ef-suggest__new" hover-class="is-hover" :hover-stay-time="80" @tap="commitShelfPick(shelfSuggest.keyword)">
                    <text class="ef-suggest__label">＋ 新建品牌「<text class="is-hit">{{ shelfSuggest.keyword }}</text>」</text>
                  </view>
                </view>
              </view>
            </view>

            <view class="ef-row ef-row--tags">
              <text class="ef-key">标签</text>
              <view class="ef-val">
                <view class="ef-tagbox" :class="{ 'is-focus': focusedField === 'tag' }">
                  <view v-for="tag in editTags" :key="tag" class="ef-chip">
                    <text class="ef-chip__name"># {{ tag }}</text>
                    <text class="ef-chip__x" @tap.stop="removeTag(tag)">×</text>
                  </view>
                  <input
                    class="ef-tagbox__input"
                    :value="editTagDraft"
                    type="text"
                    confirm-type="done"
                    maxlength="12"
                    :placeholder="editTags.length ? '' : '加标签，空格或回车分隔'"
                    placeholder-class="ef-placeholder"
                    @input="onTagInput"
                    @confirm="commitTags"
                    @focus="focusedField = 'tag'; tagSuggestVisible = Boolean(editTagDraft.trim())"
                    @blur="focusedField = ''; hideSuggestsSoon()"
                  />
                </view>
                <!-- 标签候选下拉（对齐 H5 editTagSuggest）：已有标签 + 新建入口 -->
                <view v-if="tagSuggestVisible && tagSuggest" class="ef-suggest">
                  <text class="ef-suggest__hint">{{ tagSuggest.hint }}</text>
                  <view
                    v-for="row in tagSuggest.rows"
                    :key="row.text"
                    class="ef-suggest__item"
                    hover-class="is-hover"
                    :hover-stay-time="80"
                    @tap="pickTag(row.text)"
                  >
                    <text class="ef-suggest__label"># <text v-for="(seg, i) in row.segs" :key="i" :class="{ 'is-hit': seg.hit }">{{ seg.t }}</text></text>
                    <text class="ef-suggest__count">已有 {{ row.count }} 件</text>
                  </view>
                  <view v-if="!tagSuggest.exact" class="ef-suggest__item ef-suggest__new" hover-class="is-hover" :hover-stay-time="80" @tap="pickTag(tagSuggest.keyword)">
                    <text class="ef-suggest__label">＋ 新建标签「<text class="is-hit">{{ tagSuggest.keyword }}</text>」</text>
                  </view>
                </view>
              </view>
            </view>

            <view class="ef-row ef-row--note">
              <text class="ef-key">备注</text>
              <view class="ef-val">
                <textarea
                  class="ef-area"
                  :class="{ 'is-focus': focusedField === 'note' }"
                  :value="editNote"
                  maxlength="2000"
                  :show-confirm-bar="false"
                  placeholder="留一句话，可留空"
                  placeholder-class="ef-placeholder"
                  @input="onEditNoteInput"
                  @focus="focusedField = 'note'"
                  @blur="focusedField = ''"
                />
              </view>
            </view>
          </view>
        </scroll-view>

        <!-- 半窗动作区：[取消][保存]（表单行为不变：取消丢弃、保存校验+写回） -->
        <view class="detail-actions">
          <button class="detail-edit" @tap="cancelEdit()">取消</button>
          <button class="detail-save" @tap="saveEdit()">保存</button>
        </view>
      </view>
    </view>

    <!-- 底栏「护垫」：底栏压着的那一带是框架层，正常情况它自己会吞掉点击，
         但实测仍会穿透 —— 点底栏会把底下那一排收藏一起点到，把详情卡弹出来
         （用户 2026-09-24 报过两次）。这里在页面这侧再铺一层透明块把穿透的点击接住：
         这一带本来就被底栏挡着，不该点得到。高度跟 custom-tab-bar 的 .tab-shell 一致（140rpx），
         两处要一起改。 -->
    <view class="tab-shield" @tap.stop="swallowTabBarTap" />
  </view>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   全部收藏（收藏架）—— 版式与材质整体对齐 H5 原型
   （袋袋集原型_交付包/袋袋集原型.html，data-screen="library"），
   不再沿用 figma 稿的那一套。

   换算口径：H5 的手机壳是 width:min(100%,430px) + 9px 边框 + border-box，
   所以壳内可排版宽度是 412px（不是 430）。小程序是 750rpx，于是
   1 H5 px = 750 / 412 ≈ 1.820rpx。下面每处 rpx 都由它得来，
   注释里保留原始 px 值，回 H5 和实测值核对时直接对得上。
   ══════════════════════════════════════════════════════════════ */
/* ⚠ 顶部内边距必须是 0：首页 `.home-page` 就是 0，两页头部自己的 padding 又完全一样，
   留着这 12rpx 会让整块头部（标题 / 副文案 / 右上玻璃钮）比首页整体低 12rpx。
   2026-09-24 用户拿两页截图对比报的就是它 —— 实测「标题距导航栏标题」比首页多 7px，
   而标题本身（69rpx）在截图里高 38px，7 / 38 × 69rpx ≈ 12.7rpx，正好落在这条内边距上。 */
/* 顶部标题区固定：页面改为 100vh 弹性列，头部不滚，内容区独立滚动（scroll-view） */
.library-page { position: relative; height: 100vh; display: flex; flex-direction: column; overflow: hidden; background-color: #f2f3f7; }
.library-scroll { flex: 1 1 auto; min-height: 0; }
.library-body { padding-bottom: 186rpx; }

/* ── 顶部大字 Tab：我的 ｜ 心愿袋（替代原标题「收藏架」）──
   衬线大字与旧标题同规格；未选中暖灰、选中墨黑 + 品牌红下划线（2026-09-29 应用户要求恢复）；
   心愿袋带计数角标 */
.library-tabs { display: flex; align-items: flex-end; gap: 20rpx; }
.library-tab { position: relative; min-height: 0; margin: 0; padding: 0 4rpx 14rpx; border: 0; background: transparent; color: #b3afa8; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 48rpx; font-weight: 700; line-height: 1; }
.library-tab.is-on { color: #141414; }
.library-tab.is-on::after { content: ""; position: absolute; left: 50%; top: auto; bottom: 0; transform: none; width: 40rpx; height: 6rpx; margin-left: -20rpx; border: 0; border-radius: 3rpx; background: #C50405; }
/* 设置钮：绝对定位贴胶囊左侧（top/right/宽高由脚本按胶囊矩形注入），
   只留图标、尺寸与胶囊对齐；玻璃托底材质保留 */
.header-settings { position: absolute; z-index: 20; display: flex; align-items: center; justify-content: center; margin: 0; padding: 0; border: 2rpx solid rgba(255,255,255,.75); border-radius: 14px; background: rgba(255,255,255,.6); box-shadow: 0 11rpx 25rpx rgba(52,66,92,.08), inset 0 2rpx 0 rgba(255,255,255,.8); }
.header-settings__icon { display: block; }

/* ── 心愿袋分段 ── */
.wish-empty { display: flex; flex-direction: column; align-items: center; padding: 110rpx 60rpx 60rpx; }
/* 搜索无结果态：复用空态排版，收窄留白、不放插画 */
.wish-empty--narrow { padding: 90rpx 60rpx 40rpx; }
.wish-empty--narrow .wish-empty__title { margin-top: 0; }
.wish-empty__art { width: 300rpx; height: 300rpx; opacity: .92; }
.wish-empty__title { margin-top: 20rpx; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 34rpx; font-weight: 700; }
.wish-empty__sub { margin-top: 12rpx; color: #77736d; font-size: 24rpx; }
.wish-empty__cta { min-height: 0; margin: 40rpx 0 0; padding: 20rpx 56rpx; display: flex; align-items: center; border: 0; border-radius: 44rpx; background: #141414; color: #ffffff; font-size: 26rpx; font-weight: 650; line-height: 1; }
/* 旧 wish-grid 双列卡片已废弃：心愿袋改用与「我的」宫格同款的 grid-item--wish（2026-09-29） */

/* ── 头部：大标题 + 副文案（切换钮已移到搜索行）。
   padding-top 由脚本按胶囊按钮矩形注入（inline style），标题顶=胶囊顶；整体上移。 ── */
/* 头部：标题块靠左；设置钮已改为绝对定位贴胶囊左侧（不占文档流） */
.library-header { display: flex; align-items: center; gap: 16rpx; padding: 0 36rpx 20rpx; }
/* min-height = 标题(69rpx，行高 1) + 副文案上边距 11rpx + 副文案(28rpx × 1.4)
   ≈ 119rpx：首屏还没有计数、副文案不渲染时，靠它把这一块的高度撑住，
   数字回来时下面的搜索框不会跳一下。 */
.library-copy { display: flex; flex-direction: column; min-height: 120rpx; }
/* 标题：H5 .bags-title（38px / 900 / 字距 2px / 衬线 / 行高 1）→ 38 × 1.82 = 69rpx。
   ⚠ 这一档**没有**用微信六档的 Headline(44rpx)：H5 里首页「袋袋集」和这里「全部收藏」
   共用同一个 .bags-title，两页必须一样大（用户 2026-09-24 专门点过这件事）。
   要改字号去首页 .bags-title 一起改，别只动这一处。 */
/* 2026-09-30 与首页 .bags-title 同步加粗：font-weight 已 900 封顶，宋体字族无更重字面，
   改用 -webkit-text-stroke 描边加粗（两页一级标题必须同款，别只改一处）。 */
.library-title { color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 60rpx; font-weight: 900; line-height: 1; letter-spacing: 3rpx; -webkit-text-stroke: 1rpx #141414; }
/* 副文案：与首页 .bags-tagline 同档（H5 是 12px，按 1.82 折只有 7pt，真机偏糊，
   两页统一提到 EmDesc 14pt，与标题留 11rpx = H5 的 6px） */
.library-summary { margin-top: 11rpx; color: #77736d; font-size: var(--wc-font-description); line-height: 1.4; }
/* 右上切换钮：与首页 .header-settings 完全同尺寸（H5 padding 9px 12px 7px / 圆角 16px /
   图标 24px = 44rpx / 文字 9px 按注释档提到 Footnote 12pt），只是图标与语义不同 */
/* 图标与文字间距 4px；上下内边距对称 + justify-content:center，整体在按钮内垂直居中
   （等高拉伸时行高随搜索框变化，内容始终居中） */
.mode-button { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8rpx; min-width: 0; margin: 0; padding: 14rpx 22rpx; border: 2rpx solid rgba(255,255,255,.75); border-radius: 24rpx; background: rgba(255,255,255,.6); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.8); color: #77736d; font-size: 20rpx; font-weight: 400; line-height: 1.1; transition: transform .18s ease, box-shadow .18s ease; }
/* 按压反馈：对齐 H5 .header-settings:active scale(.94) */
.mode-button.is-pressed { transform: scale(.94); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.8); }
/* 心愿袋段：隐藏但保留占位 —— 行高与搜索框宽度因此与「我的」段逐像素一致；
   visibility:hidden 不响应点击，无需额外禁用 */
.mode-button.is-ghost { visibility: hidden; }
.mode-button image { display: block; width: 44rpx; height: 44rpx; }
/* letter-spacing 会在末字后多出 2rpx 空隙，负 margin 抵消，让可见字形与 icon 同轴 */
.mode-button text { letter-spacing: 2rpx; margin-right: -2rpx; }

/* ── 搜索行：输入框 + 右侧切换钮（2026-09-26 起切换钮从头部移到这里） ── */
/* 底部外边距：24 → 10 → 20rpx（2026-09-26 两轮反馈后取中间值）。
   align-items: stretch：搜索框自动拉伸到与右侧切换钮等高（用户要求对齐） */
.search-row { display: flex; align-items: stretch; gap: 14rpx; margin: 0 33rpx 20rpx; }
/* ── 搜索框：H5 .search-box（内边距 16px / 圆角 25px）；高度随行拉伸 ── */
/* 与右侧切换钮同材质，但无投影（用户要求去掉）；顶沿内高光保留维持玻璃质感 */
.search-box { flex: 1 1 auto; min-width: 0; padding: 0 29rpx; display: flex; align-items: center; gap: 18rpx; border: 2rpx solid rgba(255,255,255,.75); border-radius: 29rpx; background: rgba(255,255,255,.6); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.8); }
/* icon 16px（32rpx），描边 2 随视框等比渲染 */
.search-icon { flex: 0 0 32rpx; width: 32rpx; height: 32rpx; }
.search-input { flex: 1; min-width: 0; height: 100%; color: #141414; font-size: var(--wc-font-footnote); }
.search-placeholder { color: #969696; }
.search-clear { flex: 0 0 auto; padding: 0 6rpx; color: #77736d; font-size: 35rpx; line-height: 1; }

/* ── 分组：H5 .collection-group（组间 30px）与 .collection-group-title（0 22px 12px / 18px 衬线粗标题） ── */
/* 视图切换过渡（H5 viewSwap）：展架 / 宫格两个分支挂载时淡入+上移，
   避免「同一批卡片直接跳位」 */
@keyframes view-swap { from { opacity: 0; transform: translateY(11rpx); } to { opacity: 1; transform: translateY(0); } }
.shelf-list { margin-top: 0; }
.shelf-list, .collection-grid { animation: view-swap .26s ease both; }
.skeleton-list { animation: none; }
/* 组间距：55 → 40rpx（2026-09-26 用户反馈） */
.shelf-group { position: relative; margin-bottom: 40rpx; }
/* 组标题与袋子行的间距：2026-09-26 用户指定 4px = 8rpx（袋子行自身的
   29rpx 顶部内边距不能再减 —— 袋子 translateY(-18rpx) 上移后全靠它防裁切） */
.shelf-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12rpx; margin: 0 40rpx 8rpx; }
/* 标题与大字比右侧小字/icon 大一圈，底部对齐后再抬 7rpx，
   让标题下缘与「共 N 件」、箭头图标的视觉下缘齐平（原居中版标题明显垂得低） */
.shelf-name { color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 33rpx; font-weight: 700; line-height: 1.05; margin-bottom: 7rpx; }
/* 右侧「共 N 件」+ 一对可点箭头（H5 .shelf-hint / .shelf-hint__arrow：
   命中区 17×22px、图标 15px、常态 55% 不透明；到端只淡不隐，右缘不漂移） */
.shelf-hint { display: flex; align-items: center; flex: 0 0 auto; }
.shelf-hint__count { color: #77736d; font-size: 24rpx; line-height: 1; margin-right: 9rpx; }
.shelf-hint__arrow { display: flex; align-items: center; justify-content: center; width: 31rpx; height: 40rpx; opacity: .55; transition: opacity .18s ease, transform .18s ease; }
.shelf-hint__arrow image { width: 27rpx; height: 27rpx; }
.shelf-hint__arrow.is-pressed { transform: scale(.86); opacity: 1; }
.shelf-hint__arrow.is-dim { opacity: .18; pointer-events: none; }

/* ── 卡片行：H5 .collection-group-scroll（padding 16px 0 8px + gap 10px + 首尾各 22px） ──
   上下 padding 不是装饰：袋子被 translateY(-10px) 上移后，图片顶会超出容器顶，
   留出 16px 才不会被 scroll-view 裁掉（H5 原注释里写的也是这件事）。
   左右 22px 用小程序的 padding 落，因为小程序这套 DOM 没有首尾伪元素。 */
/* font-size/line-height 归零是干掉 inline-flex 行盒的撑高：不干掉的话行下方会多出
   约 5px 空白（等于字号的行高余量），展架按「组底 − 14px」定位就会被这段空白顶下去。
   行里没有任何文字（只有袋图/占位块），归零不影响显示。 */
.shelf-scroll { position: relative; z-index: 2; width: 100%; font-size: 0; line-height: 0; }
/* 间距 18 → 10rpx（2026-09-26 用户反馈） */
.shelf-items { display: inline-flex; align-items: flex-end; gap: 10rpx; min-width: 100%; padding: 29rpx 40rpx 15rpx; }
/* 卡片槽：H5 .collection-group-card。袋图定高 240rpx（2026-10-01 用户反馈调整，
   270 → 200 → 240rpx）、宽度按图片自身比例（heightFix，同 H5 的 height:148px; width:auto） */
.shelf-item { width: 175rpx; height: 240rpx; flex: 0 0 175rpx; margin: 0; padding: 0; display: flex; align-items: flex-end; justify-content: center; background: transparent; overflow: visible; }
/* 袋图宽高由 inline style 按真实宽高比计算（高度固定 240rpx，宽度等比） */
.shelf-item .shelf-image { transform: translateY(-18rpx); filter: drop-shadow(0 7rpx 18rpx rgba(0,0,0,.18)); }
/* 占位块必须和袋图共用同一套位移。漏掉它的话，占位块不跟着上移，
   底边会从板体下沿露出约 6px 白边（用户实测截图里框出来的就是这条）。
   H5 里袋图和纸袋占位也是同一个 transform，别只写一半。 */
.shelf-image-placeholder { width: 140rpx; height: 20rpx; border-radius: 24rpx; background: rgba(255,255,255,.62); transform: translateY(-18rpx); }

/* ── 展架板体：H5 .collection-group .acrylic-shelf
   （左右 14px、底 14px、高 57px、圆角 9px、1px 白描边、顶部一道柔光、中性落影）。
   H5 已去掉 backdrop-filter —— 板面是均匀磨砂色、不是玻璃，这里跟随。
   底色取 var(--shelf-fill)，按展示架自身主题给（见下方五个色）。
   与袋子的关系（H5 实测）：袋底落在板底之上 4px（≈8rpx），板上沿之上露出 95px 袋身。 ── */
.acrylic-shelf { position: absolute; z-index: 3; left: 25rpx; right: 25rpx; bottom: 25rpx; height: 104rpx; border: 2rpx solid rgba(255,255,255,.40); border-radius: 16rpx; box-shadow: 0 15rpx 29rpx rgba(43,35,29,.13), inset 0 2rpx 0 rgba(255,255,255,.55); background: linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,0) 55%), var(--shelf-fill, rgba(240,154,42,.72)); }
/* 两端螺钉：H5 .acrylic-shelf i（12px 车削金属环 + 左上高光 + 沉孔阴影，两端各内缩 11px）。
   尺寸只有 22rpx，conic 与 linear 的差别肉眼看不出来，用 radial + linear 更稳。 */
.shelf-fastener { position: absolute; top: 50%; width: 22rpx; height: 22rpx; transform: translateY(-50%); border-radius: 50%; background: radial-gradient(circle at 34% 26%, rgba(255,255,255,.95) 0 12%, rgba(255,255,255,0) 34%), radial-gradient(circle at 50% 50%, rgba(255,255,255,.9) 0 8%, rgba(255,255,255,0) 30%), linear-gradient(150deg, #f2efe9, #b8b1a6 25%, #8d857a 50%, #cfc8bd 75%, #f2efe9 100%); box-shadow: 0 1rpx 3rpx rgba(0,0,0,.40), 0 3rpx 8rpx rgba(0,0,0,.22), inset 0 0 0 1rpx rgba(255,255,255,.60), inset 0 -2rpx 3rpx rgba(0,0,0,.30); }
.shelf-fastener--left { left: 20rpx; }
.shelf-fastener--right { right: 20rpx; }

/* 展架配色：对齐 H5 的「按行序轮换 + 品牌特例」（2026-09-26 起 1:1 复刻）：
   行序 3n+1 琥珀 / 3n+2 天蓝 / 3n 鼠尾草；瑞幸特例 ROSE 正粉覆盖行序。
   数据里的 theme 不再决定颜色（GRAPHITE 弃用，规则已删）。 */
.acrylic-shelf--SAGE { --shelf-fill: rgba(117,168,141,.72); }
.acrylic-shelf--AMBER { --shelf-fill: rgba(240,154,42,.72); }
.acrylic-shelf--SKY { --shelf-fill: rgba(34,158,232,.66); }
.acrylic-shelf--ROSE { --shelf-fill: rgba(253,83,192,.72); }

/* ── 零数据空态：长按删除清空 / 首次使用时引导去添加（此前此分支缺失，列表区直接空白）── */
.zero-state { display: flex; flex-direction: column; align-items: center; padding: 110rpx 60rpx 60rpx; }
.zero-state__art { width: 300rpx; height: 300rpx; opacity: .92; }
.zero-state__title { margin-top: 20rpx; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 34rpx; font-weight: 700; }
.zero-state__sub { margin-top: 12rpx; color: #77736d; font-size: 24rpx; }
.zero-state__cta { min-height: 0; margin: 40rpx 0 0; padding: 20rpx 56rpx; display: flex; align-items: center; border: 0; border-radius: 44rpx; background: #141414; color: #ffffff; font-size: 26rpx; font-weight: 650; line-height: 1; }

/* ── 搜索无结果：对齐 H5 .empty-state（padding 58px / 34px 衬线水印大字 16% 不透明 / 12px 副文案 / 标签 chips） ── */
.search-empty { padding: 106rpx 36rpx 55rpx; text-align: center; }
.search-empty__mark { display: block; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 62rpx; font-weight: 900; letter-spacing: 3.6rpx; line-height: 1; opacity: .16; }
.search-empty__sub { display: block; margin-top: 29rpx; color: #77736d; font-size: 22rpx; }
/* 出口标签：H5 .empty-state__chips（gap 7px / chip padding 6px 12px / 11px 字重 650） */
.empty-chips { display: flex; flex-wrap: wrap; gap: 13rpx; justify-content: center; margin-top: 33rpx; }
.empty-chip { padding: 11rpx 22rpx; border-radius: 36rpx; background: rgba(20,20,20,.05); color: #77736d; font-size: 20rpx; font-weight: 650; line-height: 1.2; transition: transform .18s ease, background .18s ease; }
.empty-chip.is-pressed { transform: scale(.94); background: rgba(20,20,20,.09); color: #141414; }

/* ── 宫格画廊（H5 .grid-window / .grid-stage / .collection-grid）──
   尺寸全部由脚本按捏合进度派生（inline style），这里只留结构与静态质感。 */
/* 宫格容器撑满剩余视口：藏品少时卡片下方的空白也在容器内，
   双指缩放挂在容器上 → 空白区域同样生效（不必碰到卡片） */
.grid-window { width: 100%; min-height: 70vh; overflow: hidden; }
.grid-stage { display: inline-block; min-width: 100%; padding: 24rpx 0 8rpx; }
.collection-grid { display: grid; align-content: start; justify-content: start; }
/* 卡面质感对齐 H5 .grid-card：冷调斜向渐变 + 1px 内白边，无外影、无光斑；
   宽/高/圆角随捏合缩放（inline style），加 transition 会与变量跳变不同步，刻意不加 */
/* 2026-09-26 用户要求：袋子图片在卡内居中显示（水平 + 垂直） */
.grid-item { position: relative; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; border: 0; background: linear-gradient(160deg, #fbfbfd, #eef0f4); box-shadow: inset 0 0 0 2rpx rgba(255,255,255,.9); overflow: hidden; }
.grid-item image, .grid-image-placeholder { position: relative; z-index: 1; }
/* 心愿袋网格卡：与「我的」宫格同尺寸同滚动，仅边框改虚线 + 素底 —— 标识「还未收入」 */
.grid-item--wish { border: 2rpx dashed rgba(20,20,20,.28); background: rgba(255,255,255,.55); box-shadow: inset 0 0 0 2rpx rgba(255,255,255,.9); }
.grid-item image { filter: drop-shadow(0 4px 10px rgba(0,0,0,.18)); }
.grid-image-placeholder { width: 100rpx; height: 168rpx; border-radius: 20rpx; background: rgba(255,255,255,.62); }
/* 渲染量封顶提示（H5 .grid-overflow-note） */
.grid-overflow-note { display: block; margin-top: 18rpx; color: #77736d; font-size: 20rpx; text-align: left; }
.page-loading { display: block; padding: 30rpx 0; color: #7a7c80; font-size: var(--wc-font-footnote); font-weight: 500; text-align: center; }
.load-error { margin: 40rpx 30rpx 0; padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: var(--wc-font-description); font-weight: 500; text-align: center; }

/* 骨架屏跟着新几何走，否则加载态和加载完会「跳」一下。
   高度 = 组标题(24rpx) + 标题下边距(22rpx) + 卡片行(29 + 269 + 15)。 */
.skeleton-text { width: 230rpx; height: 24rpx; border-radius: 999rpx; background: rgba(255,255,255,.75); }
.skeleton-list { margin-top: 0; }
.skeleton-shelf { position: relative; height: 346rpx; margin-bottom: 55rpx; padding: 0 40rpx; }
.skeleton-text--shelf { width: 180rpx; margin-bottom: 12rpx; }
.skeleton-items { display: flex; gap: 10rpx; padding-top: 29rpx; }
.skeleton-item { width: 175rpx; height: 270rpx; border-radius: 24rpx; background: rgba(255,255,255,.62); transform: translateY(-18rpx); }
.skeleton-board { position: absolute; left: 25rpx; right: 25rpx; bottom: 25rpx; height: 104rpx; border-radius: 16rpx; background: rgba(210,214,220,.72); }

/* ══════════════════════════════════════════════════════════════
   详情卡（轻点收藏原地弹出）—— 对齐 H5 原型的 .detail-card
   （居中浮层：白色液态玻璃 + 顶部大图 + 字段表 + 底部两枚按钮）。
   几何仍按 1 H5 px = 1.82rpx 换算，字号走微信六档。

   H5 的关键尺寸：浮层 348×560、圆角 30px、内边距 22/24/28px、
   图区 168px（内含 10px 内边距，图限高 148px）、按钮高 48px。
   小程序这边把「滚动内容」与「按钮区」拆成两块的固定高度：
     内容 874rpx + 按钮区 145rpx（87 + 上下外边距 22/36）= 卡片 1019rpx，
   两边都用「卡片高度 − 常量」从 100vh 派生，小屏上等比收缩、不会挤出卡外。
   ══════════════════════════════════════════════════════════════ */
/* 浮层根：铺满页面视口。注意它盖不到「页面视口之外」的两块 ——
   下面的自定义底栏与上面的原生导航栏（`bottom: 0` 只到页面视口底），
   那两块由 services/overlay.ts 的 maskPageChrome() 一起蒙。 */
.detail-layer { position: fixed; z-index: 950; top: 0; left: 0; right: 0; bottom: 0; }

/* ═══ 编辑半窗壳层样式已抽到 styles/edit-form.css（标记已有半窗共用）═══ */
/* 底栏护垫：把「穿透下来的点击」接住（见模板里的注释）。
   z-index 899 是算好的：高于页面内容（宫格 / 展架板体最高 z-index 3），
   低于自定义底栏（900，本来是框架层、页面 z-index 压不过它，所以护垫不会挡住底栏自己的点击），
   也低于详情浮层（950）—— 卡片开着时点这一带要能关卡片，不能被护垫吃掉。 */
.tab-shield { position: fixed; z-index: 899; left: 0; right: 0; bottom: 0; height: 150rpx; }
/* 遮罩样式已抽到 styles/edit-form.css（与标记已有半窗共用） */

/* 浮层本体：定宽定高 + inset 0 + margin auto 居中（H5 也是这么做的，
   用 left/top + translate 会和 scale 入场动效抢 transform）。 */
.detail-card { position: absolute; z-index: 1; top: 0; right: 0; bottom: 0; left: 0; width: 633rpx; height: 1019rpx; max-height: calc(100vh - 175rpx); margin: auto; overflow: hidden; border: 2rpx solid rgba(255,255,255,.62); border-radius: 55rpx; background: linear-gradient(160deg, #ffffff 0%, #fafbfd 56%, #f2f4f8 100%); box-shadow: inset 0 2rpx 0 rgba(255,255,255,1), inset 0 -2rpx 0 rgba(255,255,255,.34), inset 0 0 0 2rpx rgba(255,255,255,.9), 0 29rpx 65rpx rgba(52,66,92,.16), 0 5rpx 18rpx rgba(52,66,92,.07), 0 55rpx 145rpx rgba(0,0,0,.26); animation: detail-in .3s cubic-bezier(.2,.78,.22,1) both; }
@keyframes detail-in { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: scale(1); } }
@keyframes detail-fade { from { opacity: 0; } to { opacity: 1; } }

/* 玻璃背景层：只出材质，不接手势（H5 .detail-glass） */
.detail-glass { position: absolute; z-index: 1; top: 0; left: 0; right: 0; bottom: 0; overflow: hidden; border-radius: 55rpx; pointer-events: none; }
/* 左上角冷白高光（H5 .glass-glow：径向高光 + 一道极淡的 128° 斜向反光，
   白底之上整体压到 .85 才不把白拉浑） */
.detail-glow { position: absolute; top: 0; left: 0; right: 0; bottom: 0; opacity: .85; background: radial-gradient(120% 78% at 16% -12%, rgba(255,255,255,.95) 0%, rgba(255,255,255,0) 58%), linear-gradient(128deg, rgba(255,255,255,.5) 0%, rgba(255,255,255,0) 34%, rgba(255,255,255,0) 66%, rgba(255,255,255,.34) 100%); }
/* 细颗粒噪点（H5 .detail-glass::before 的 feTurbulence 层）：
   小程序拿不到内联 SVG 滤镜，换 static/figma/noise.png（预烘焙低透明噪点）。
   opacity .045 同原型 —— 4.5% 细颗粒刚好「能感觉到、看不出是噪点」。 */
.detail-noise { position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: .045; pointer-events: none; }
/* ── 右上角那束暖光（H5 .light-beam 的主体）──
   H5 用的是一张「右上角为光源、向左下渐隐」的暖黄 webp，再用 mask
   （radial 96% 74% at 100% 0%，38% 前不透、74% 全透）把光收在右上角。
   小程序端 mask 不可靠，这里用一条径向渐变等价近似：范围直接照搬 H5 的
   「96% 74% at 100% 0%」，色值与衰减曲线按参考图反解 —— 角落处蓝通道比白低 20、
   红绿低 5（→ rgba(236,236,178,.26)），到半径 58% 归零，中间线性过渡。
   少了这一层，整张卡就只剩「白 + 冷底」，右上角完全没有温度。 */
.detail-beam-glow { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: radial-gradient(96% 74% at 100% 0%, rgba(236,236,178,.26) 0%, rgba(236,236,178,.13) 29%, rgba(236,236,178,0) 58%); }
/* 卡面顶沿那道细亮线（H5 .light-beam::before，位置 top 15px / right 9px） */
.detail-beam { position: absolute; top: 27rpx; right: 16rpx; left: 34%; height: 3rpx; border-radius: 4rpx; background: linear-gradient(90deg, rgba(255,236,190,0) 0%, rgba(255,246,220,.9) 58%, rgba(255,236,190,0) 100%); opacity: .26; }

/* 滚动内容层：H5 .detail-scroll（padding 22px 24px 28px）。
   底部渐隐遮罩：滚动条是隐藏的，内容溢出时让「还有内容」被读出来；
   滚到底（.is-at-end）收成 26rpx 短渐隐，最底部那行不再糊着。 */
.detail-scroll { position: relative; z-index: 3; width: 100%; height: 874rpx; max-height: calc(100vh - 320rpx); box-sizing: border-box; padding: 40rpx 44rpx 51rpx; -webkit-mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 55rpx), transparent 100%); mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 55rpx), transparent 100%); }
.detail-scroll.is-at-end { -webkit-mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 26rpx), transparent 100%); mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 26rpx), transparent 100%); }
/* 滚动条兜底：低版本基础库上 enhanced 不生效时，靠 WebKit 的滚动条样式再挡一层
   （H5 同位置也是 display:none）。滚动条属于 scroll-view 内部滚动容器，
   自选与后代两种写法都写上，覆盖不同基础库的实现。 */
.detail-scroll::-webkit-scrollbar, .detail-scroll ::-webkit-scrollbar { width: 0; height: 0; display: none; }

/* 底部动作区样式已抽到 styles/edit-form.css（标记已有半窗共用） */

/* 顶部大图：H5 .detail-artwork（高 168px、下方 18px、内边距 10px、圆角 20px）。
   H5 这里不铺底色 —— 袋子自带透明通道与下落投影，铺底会把它框成一张「图卡」。 */
.detail-artwork { display: flex; align-items: center; justify-content: center; height: 306rpx; margin: 0 0 33rpx; padding: 18rpx; box-sizing: border-box; overflow: hidden; border-radius: 36rpx; }
/* 图区内的图给死高：269rpx = H5 的 148px（= 168 − 上下各 10px 内边距）。
   小程序 image 是替换元素、没有 width:auto 这一说，写死盒尺寸最稳：
   竖长的袋子在 aspectFit 下由高度定尺寸，横宽的图由宽度定，都不会溢出。 */
.detail-artwork image { width: 100%; height: 269rpx; filter: drop-shadow(0 7rpx 18rpx rgba(0,0,0,.18)); }
.detail-artwork__placeholder { width: 234rpx; height: 269rpx; border-radius: 28rpx; background: rgba(20,20,20,.045); }

/* 编号 → 名称 → 品牌（H5 .back-eyebrow / .detail-name / .detail-brand） */
.detail-eyebrow { display: block; margin-bottom: 7rpx; color: #77736d; font-size: var(--wc-font-footnote); font-weight: 700; line-height: 1.2; letter-spacing: 3rpx; }
/* 卡片名：H5 是 25px 衬线 600，比首页卡背面的 19px 大一档 —— 落到六档就是 Headline 22pt */
.detail-name { display: block; color: #1d1a15; font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: var(--wc-font-headline); font-weight: 600; line-height: 1.2; }
.detail-brand { display: block; margin-top: 11rpx; color: #6f6a62; font-size: var(--wc-font-description); line-height: 1.4; }
.detail-divider { height: 1rpx; margin: 25rpx 0; background: linear-gradient(90deg, rgba(20,20,20,.12), rgba(20,20,20,.04) 70%, transparent); }

/* 字段表：H5 .detail-card .back-facts（gap 9px，键灰值黑） */
.detail-facts { display: flex; flex-direction: column; gap: 16rpx; }
.detail-facts__row { display: flex; align-items: baseline; justify-content: space-between; gap: 18rpx; }
.detail-facts__key { flex: 0 0 auto; color: #77736d; font-size: var(--wc-font-description); line-height: 1.4; letter-spacing: .6rpx; }
.detail-facts__value { flex: 0 1 auto; min-width: 0; color: #2b2720; font-size: var(--wc-font-description); font-weight: 600; line-height: 1.4; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 标签 / 备注：与首页卡背面同结构，但按详情卡的放大值（11px / 12px）走 Footnote 与 EmDesc */
.detail-tags { display: flex; flex-wrap: wrap; gap: 13rpx; margin-top: 29rpx; }
.detail-tags text { padding: 11rpx 22rpx; border-radius: 22rpx; background: rgba(20,20,20,.055); color: #5d594f; font-size: var(--wc-font-footnote); line-height: 1.2; }
.detail-note { display: block; margin-top: 27rpx; padding: 20rpx 24rpx; border-left: 4rpx solid rgba(20,20,20,.14); border-radius: 0 20rpx 20rpx 0; background: rgba(20,20,20,.035); color: #5f5b53; font-size: var(--wc-font-description); line-height: 1.6; white-space: pre-wrap; }
.detail-loading { display: block; margin-top: 27rpx; color: #77736d; font-size: var(--wc-font-footnote); line-height: 1.4; }

/* 详情卡右上角快捷钮：与首页大卡 hero-quick 同款玻璃圆钮（无投影） */
.detail-quick { position: absolute; z-index: 9; top: 22rpx; right: 22rpx; display: flex; gap: 14rpx; }
.detail-quick__btn { width: 60rpx; height: 60rpx; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(255,255,255,.88); transition: transform .18s ease; }
.detail-quick__btn.is-pressed { transform: scale(.88); }
.detail-quick__icon { width: 32rpx; height: 32rpx; }
/* 底部动作区（H5 .detail-actions：12px 24px 20px、gap 10px；按钮高 48px、圆角 24px）。
   编辑是次要按钮（描边、固定 96px 宽），完成是主按钮（实色、占满剩余宽度）。 */
.detail-actions { position: relative; z-index: 4; display: flex; gap: 18rpx; margin: 22rpx 44rpx 36rpx; }
.detail-edit, .detail-done, .detail-save { display: flex; align-items: center; justify-content: center; min-height: 87rpx; margin: 0; padding: 0; border-radius: 44rpx; font-size: var(--wc-font-description); font-weight: 700; line-height: 1.2; }
.detail-edit { flex: 0 0 175rpx; border: 2rpx solid rgba(20,20,20,.12); background: transparent; color: #141414; }
.detail-done, .detail-save { flex: 1 1 auto; border: 0; background: #141414; color: #ffffff; }

/* ══════════════════════════════════════════════════════════════
   编辑态：卡片原地从「看」切成「改」（对齐 H5 的 .detail-card.is-editing）
   · 图区 168px → 128px（233rpx），省下的竖高让给输入框
   · 只读的文字区隐藏，表单展开（由 editing 切换）
   · 底部动作区从 [编辑][完成] 切成 [取消][保存]（同一对按钮换文案与动作）

   表单版式是 H5 的「方案③ 下划线 · 纸感」：撤掉所有方框和底色，
   每个字段只留一条底线，文字直接坐在卡面上。三段：
     ① .ef-readout 只读条（编号 / 收藏日期 / 入库时长）
     ② .ef-row     可编辑行（名称 / 品牌 / 标签 / 备注），末行不加横线、改成左侧竖线
   字号照旧走微信六档，几何依旧 1 H5 px = 1.82rpx。
   ══════════════════════════════════════════════════════════════ */
.detail-artwork--editing { height: 233rpx; margin: 0 0 25rpx; }
.detail-artwork--editing image, .detail-artwork--editing .detail-artwork__placeholder { height: 196rpx; }

/* ── ① 只读条 ──
   撤掉灰底与描边，只留两条 1px 细竖线分隔；顺序倒成「值在上、名在下」，
   先读到内容，视觉重心和下方字段对齐。
   列宽不三等分（H5 实测后改的）：首块固定、中间吃掉剩余、末块固定并靠右，
   这样三条竖线的间距与内容量成正比，不会出现「小值占大栏」。 */
.ef-readout { display: flex; align-items: flex-start; margin: 0 0 25rpx; padding: 4rpx 0 0; }
/* 三块等宽（flex 基准 0 均分），编号/收藏日期/入库时长的文案在各自格内水平居中
   （2026-09-26 用户要求；原先编号/时长按内容定宽、时长右对齐） */
.ef-readout__cell { flex: 1 1 0; min-width: 0; text-align: center; border-left: 2rpx solid rgba(20,20,20,.085); }
.ef-readout__cell--no { border-left: 0; }
.ef-readout__v { display: block; margin: 0 0 9rpx; color: #3a3630; font-size: var(--wc-font-description); font-weight: 600; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ef-readout__k { display: block; color: #a8a49d; font-size: var(--wc-font-footnote); font-weight: 700; line-height: 1.2; letter-spacing: .8rpx; white-space: nowrap; }

/* ── ② 可编辑行 / 候选下拉 / 半窗壳层样式已抽到 styles/edit-form.css
   （编辑半窗与拍照后填写页、标记已有半窗共享），此处不再重复 ── */
</style>

<style>
@import '../../styles/edit-form.css';
@import '../../styles/like-burst.css';
</style>
