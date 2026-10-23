<script setup lang="ts">
import { computed, getCurrentInstance, ref, watch } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import type { Brand, OfficialBag } from '../../types';
import BagImagePreview from '../../components/BagImagePreview.vue';
import { dataService } from '../../services/data';
import { strokeRevision } from '../../services/stroke-preference';

/* ── 官方图鉴页（从首页入口进入）：按品牌分类浏览官方袋子 + 搜索；
      卡片右上角用快捷圆钮区分「已有」（靶心）与「心愿」（心形），顶行给出只数 / 品牌 / 已有 / 心愿概览 ──
   数据源 = GET /official-bags（search / brandId / cursor / limit），
   品牌分类 = GET /official-bags/brands（只含旗下有可见袋子的品牌）。 */

const loading = ref(true);
const initialized = ref(false);
const loadingMore = ref(false);
const refreshing = ref(false);
const loadError = ref('');
const bags = ref<OfficialBag[]>([]);
const totalCount = ref(0);
const nextCursor = ref<string | null>(null);

/* 品牌分类 chips：'' = 全部 */
const brands = ref<Brand[]>([]);
const activeBrandId = ref('');
const brandsLoaded = ref(false);

/* 搜索分两段：searchText 只喂界面，keyword 防抖后真正进请求 */
const searchText = ref('');
const keyword = ref('');
const hasSearch = computed(() => keyword.value.length > 0);
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/* 心愿袋状态（官方袋子 id 集合） */
const wishlistIds = ref<Set<string>>(new Set());

/* 详情浮层 */
const detailBag = ref<OfficialBag | null>(null);
const imagePreview = ref(false);
/* 标记已有：直接调认领接口，不再拉半窗（claiming 用于防重复点击） */
const claiming = ref(false);

/* ── 详情 AB 面：官方袋子详情带 sides（FRONT/BACK），有 B 面图时图区切成左右并排，
      点哪一面大图预览就从哪一面起（无 B 面维持单图） ── */
const detailFrontImage = computed(() => detailBag.value?.sides?.FRONT?.displayImageUrl || detailBag.value?.displayImageUrl || detailBag.value?.thumbnailUrl || '');
const detailBackImage = computed(() => detailBag.value?.sides?.BACK?.displayImageUrl || '');
const hasBackImage = computed(() => !!detailBackImage.value);
const previewSide = ref<'FRONT' | 'BACK'>('FRONT');
function openPreview(side: 'FRONT' | 'BACK' = 'FRONT') {
  previewSide.value = side;
  imagePreview.value = true;
}

/* ── 顶部：状态栏留白 + 自绘返回 ── */
const statusBarHeight = ref(20);
// #ifdef MP-WEIXIN
try {
  statusBarHeight.value = uni.getSystemInfoSync().statusBarHeight ?? 20;
} catch {
  /* 取不到就用默认值 */
}
// #endif

/* 概览行：只数 · 品牌数 · 已有 · 心愿
   已有 / 心愿都用全量口径，不受当前筛选与分页影响
   （「已有」由后端返回全量已拥有数，绝不能从当前已加载的 bags 里数，否则会随滚动翻页增长） */
const ownedCount = ref(0);
const wishedCount = computed(() => wishlistIds.value.size);
const overview = computed(() => {
  const parts = [`${totalCount.value} 只`];
  if (brands.value.length) parts.push(`${brands.value.length} 品牌`);
  parts.push(`已有 ${ownedCount.value}`, `心愿 ${wishedCount.value}`);
  return parts.join(' · ');
});

function goBack() {
  uni.navigateBack({ delta: 1 });
}

function query(cursor?: string) {
  const params = ['limit=30'];
  if (keyword.value) params.push(`search=${encodeURIComponent(keyword.value)}`);
  if (activeBrandId.value) params.push(`brandId=${encodeURIComponent(activeBrandId.value)}`);
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  return params.join('&');
}

async function initBrands() {
  if (brandsLoaded.value) return;
  try {
    brands.value = await dataService.officialBagBrands();
    brandsLoaded.value = true;
  } catch {
    /* 品牌拉不到不阻塞列表：chips 只有「全部」 */
  }
}

let refreshPromise: Promise<void> | undefined;
function load() {
  if (refreshPromise) return refreshPromise;
  if (initialized.value) loading.value = false;
  else loading.value = true;
  loadError.value = '';
  refreshPromise = (async () => {
    try {
      const [page, wish] = await Promise.all([dataService.officialBags(query()), dataService.wishlist(), initBrands()]);
      bags.value = page.items;
      totalCount.value = page.totalCount;
      nextCursor.value = page.nextCursor;
      ownedCount.value = page.ownedCount;
      wishlistIds.value = new Set(wish.map((item) => item.id));
      initialized.value = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '袋子加载失败';
      if (initialized.value) uni.showToast({ title: message, icon: 'none' });
      else loadError.value = message;
    } finally {
      loading.value = false;
    }
  })().finally(() => {
    refreshPromise = undefined;
    /* 首屏可能也不满一屏（比如某个分类只有十几件），一并补到能滚为止 */
    fillViewportIfNeeded();
  });
  return refreshPromise;
}

async function loadMore() {
  if (loadingMore.value || !nextCursor.value) return;
  loadingMore.value = true;
  try {
    const page = await dataService.officialBags(query(nextCursor.value));
    const known = new Set(bags.value.map((bag) => bag.id));
    bags.value = [...bags.value, ...page.items.filter((bag) => !known.has(bag.id))];
    nextCursor.value = page.nextCursor;
    totalCount.value = page.totalCount;
    ownedCount.value = page.ownedCount;
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '加载更多失败', icon: 'none' });
  } finally {
    loadingMore.value = false;
  }
}

function onScrollToLower() {
  void loadMore();
}

/* ── 内容不满一屏时自动补拉分页（口径与「我的」页一致）──
   scrolltolower 只在「能滚」时才触发：首屏 30 条在 3 列时能撑满，
   但双指捏合缩小到 4~5 列后一屏就装得下几十条，内容矮于视口 →
   滚不动 → 后续分页永远出不来（用户 2026-10-13 反馈「缩小后上滑加载不了」）。
   所以每次加载完成、以及每次缩放档位变化后，都量一次高度：
   内容仍矮于视口且还有下一页就继续拉，直到铺满或没有更多。 */
const pageInstance = getCurrentInstance();
let fillTimer: ReturnType<typeof setTimeout> | undefined;

function fillViewportIfNeeded() {
  if (!nextCursor.value || loadingMore.value || loading.value) return;
  const cursorBefore = nextCursor.value;
  /* 捏合过程中档位会连续变，抖一下、等排版落定再量，量到的才是最终尺寸 */
  if (fillTimer) clearTimeout(fillTimer);
  fillTimer = setTimeout(() => {
    fillTimer = undefined;
    if (!nextCursor.value || loadingMore.value || loading.value) return;
    const query = uni.createSelectorQuery().in(pageInstance?.proxy);
    query.select('.explore-scroll').boundingClientRect();
    query.select('.explore-body').boundingClientRect();
    query.exec(async (rows) => {
      const viewport = rows?.[0] as { height?: number } | null;
      const body = rows?.[1] as { height?: number } | null;
      if (!viewport?.height || !body?.height || !nextCursor.value) return;
      if (body.height > viewport.height + 2) return;
      await loadMore();
      /* 下一页没进来（请求失败 / 已是空页）就停手，免得原地打转 */
      if (nextCursor.value && nextCursor.value !== cursorBefore) fillViewportIfNeeded();
    });
  }, 60);
}

async function onRefresh() {
  refreshing.value = true;
  try {
    await load();
  } finally {
    refreshing.value = false;
  }
}

/* ── 分类切换 ── */
function pickBrand(id: string) {
  if (activeBrandId.value === id) return;
  activeBrandId.value = id;
  void load();
}

/* ── 宫格双指捏合缩放（与「我的」页同一套手感）──
   列数是唯一真源：3 列起步、最多 5 列，卡宽 = (可用宽 − 列间距) ÷ 列数，
   卡内的图区高 / 内边距 / 圆角 / 字号 / 角标全部按卡宽等比派生 ——
   这样每一档的观感都与 3 列时完全一致，不会出现「图缩了字没缩」的错位。
   比例系数取自 3 列档的实测值：卡宽 219rpx 时图区 196 / 内边距 14·10·18 / 圆角 26 / 名称 25 字。 */
const GRID_COLS_MIN = 3;
const GRID_COLS_MAX = 5;
/* 必须与 .explore-body 的左右 30rpx、.bag-grid 的间距 16rpx 保持一致，否则卡宽算不准 */
const GRID_PAD = 30;
const GRID_GAP = 16;
const gridCols = ref(GRID_COLS_MIN);
const cardW = computed(() => Math.floor((750 - GRID_PAD * 2 - (gridCols.value - 1) * GRID_GAP) / gridCols.value));
/* 网格容器样式：列宽写死成 rpx（不用 1fr，才能与卡宽的取整口径完全对齐） */
const gridStyle = computed(() => ({ gridTemplateColumns: `repeat(${gridCols.value}, ${cardW.value}rpx)`, gap: `${GRID_GAP}rpx` }));
const cardArtH = computed(() => Math.round(cardW.value * 0.8949));
const cardArtW = computed(() => Math.round(cardW.value * 0.5114));
const cardArtPlaceholderH = computed(() => Math.round(cardW.value * 0.7123));
const cardArtPlaceholderRadius = computed(() => Math.round(cardW.value * 0.0913));
const cardPadTop = computed(() => Math.round(cardW.value * 0.0639));
const cardPadX = computed(() => Math.round(cardW.value * 0.0457));
const cardPadBottom = computed(() => Math.round(cardW.value * 0.0822));
const cardRadius = computed(() => Math.round(cardW.value * 0.1187));
const cardNameSize = computed(() => Math.max(18, Math.round(cardW.value * 0.1141)));
const cardBrandSize = computed(() => Math.max(16, Math.round(cardW.value * 0.0913)));
/* 快捷圆钮尺寸也随卡宽派生（与首页 hero-quick 同款视觉），但设下限保证 5 列小卡仍可点中 */
const cardQuickSize = computed(() => Math.max(40, Math.round(cardW.value * 0.2)));
const cardQuickIconSize = computed(() => Math.round(cardQuickSize.value * 0.55));
const cardNameGap = computed(() => Math.max(4, Math.round(cardW.value * 0.0639)));
const cardBrandGap = computed(() => Math.max(2, Math.round(cardW.value * 0.0274)));
const skeletonH = computed(() => Math.round(cardW.value * 1.4612));

let pinchStartDist = 0;
let pinchStartCols = GRID_COLS_MIN;
/* 双指手势结束后紧跟的 tap 要丢掉：捏合收尾很容易落在某张卡上，
   不然一缩放就顺手弹开详情。 */
let suppressCardTapUntil = 0;

function touchPoints(event: Event) {
  const touches = (event as unknown as { touches?: Array<{ x?: number; clientX?: number; y?: number; clientY?: number }> }).touches;
  return touches?.map((touch) => ({ x: touch.x ?? touch.clientX ?? 0, y: touch.y ?? touch.clientY ?? 0 })) ?? [];
}

function gridTouchStart(event: Event) {
  const points = touchPoints(event);
  if (points.length !== 2) return;
  suppressCardTapUntil = Date.now() + 400;
  pinchStartDist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  pinchStartCols = gridCols.value;
}

function gridTouchMove(event: Event) {
  if (!pinchStartDist) return;
  const points = touchPoints(event);
  if (points.length !== 2) return;
  const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  if (!dist) return;
  suppressCardTapUntil = Date.now() + 400;
  /* 双指张开 = 放大 = 列数变少；捏合 = 缩小 = 列数变多 */
  const next = Math.round(pinchStartCols * (pinchStartDist / dist));
  gridCols.value = Math.min(GRID_COLS_MAX, Math.max(GRID_COLS_MIN, next));
}

function gridTouchEnd() {
  pinchStartDist = 0;
}

/* 档位一变就重新评估要不要补页：缩小后一屏能装更多，最容易出现「撑不满、滚不动」 */
watch(gridCols, () => { fillViewportIfNeeded(); });


/* ── 搜索 ── */
function applySearch(value: string) {
  const next = value.trim();
  if (next === keyword.value) return;
  keyword.value = next;
  void load();
}
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

/* ── 卡片 / 详情 ── */
let detailRequest = 0;
async function openBag(bag: OfficialBag) {
  /* 捏合缩放刚结束（suppressCardTapUntil）时的 tap 一律忽略，避免顺手弹开详情 */
  if (Date.now() < suppressCardTapUntil) return;
  const request = ++detailRequest;
  imagePreview.value = false;
  detailBag.value = bag;
  try {
    const fresh = await dataService.officialBag(bag.id);
    if (request !== detailRequest) return;
    detailBag.value = fresh;
    bags.value = bags.value.map(current => current.id === fresh.id ? fresh : current);
  } catch (error) {
    if (request !== detailRequest) return;
    closeDetail();
    uni.showToast({ title: error instanceof Error ? error.message : '详情加载失败', icon: 'none' });
  }
}

function closeDetail() {
  detailRequest++;
  imagePreview.value = false;
  detailBag.value = null;
}

function isWished(id: string) {
  return wishlistIds.value.has(id);
}

/* target 缺省 = 详情浮层里的袋子；卡片快捷圆钮会直接传卡片袋子（与首页 hero-quick 同一套交互） */
async function toggleWish(target?: OfficialBag) {
  const bag = target ?? detailBag.value;
  /* 已拥有的袋子不能再进心愿袋（按钮也会置灰，这里兜一层） */
  if (!bag || bag.claimed) return;
  try {
    if (isWished(bag.id)) {
      await dataService.removeWishlist(bag.id);
      const next = new Set(wishlistIds.value);
      next.delete(bag.id);
      wishlistIds.value = next;
      uni.showToast({ title: '已移出心愿袋', icon: 'none' });
    } else {
      await dataService.addWishlist(bag.id);
      wishlistIds.value = new Set(wishlistIds.value).add(bag.id);
      uni.showToast({ title: '已加入心愿袋', icon: 'none' });
    }
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' });
  }
}

/* 标记已有：直接调认领接口。
   官方袋子的名称 / 品牌 / 标签 / 备注都已在库里，后端会用袋子自带内容建收藏，
   所以图鉴页不需要「先编辑再确认」的半窗（首页翻面卡与收藏架仍保留半窗，那里允许改名归类）。 */
async function claimBag(target?: OfficialBag) {
  const bag = target ?? detailBag.value;
  if (!bag || bag.claimed || claiming.value) return;
  claiming.value = true;
  try {
    await dataService.claimOfficialBag(bag.id);
    const listed = bags.value.find((current) => current.id === bag.id);
    if (listed) listed.claimed = true;
    if (detailBag.value?.id === bag.id) detailBag.value = { ...detailBag.value, claimed: true };
    /* 概览「已有」是全量口径，认领成功后本地 +1，无需重拉列表 */
    ownedCount.value += 1;
    /* 已拥有就不能再留在心愿袋（后端认领时也会清），本地同步移除，免得心愿角标残留 */
    if (wishlistIds.value.has(bag.id)) {
      try { await dataService.removeWishlist(bag.id); } catch { /* 清理失败不阻塞入库 */ }
      const next = new Set(wishlistIds.value);
      next.delete(bag.id);
      wishlistIds.value = next;
    }
    uni.showToast({ title: '已加入收藏架', icon: 'none' });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '标记失败', icon: 'none' });
  } finally {
    claiming.value = false;
  }
}

onLoad(() => {
  void load();
});
let lastStrokeRevision = strokeRevision();
onShow(() => {
  /* 白边开关在设置页切过后，图片 URL 会变：偏好版本号变化则强制重拉列表，让无白边版立即生效 */
  if (initialized.value && strokeRevision() !== lastStrokeRevision) {
    lastStrokeRevision = strokeRevision();
    void load();
    return;
  }
  /* 从心愿袋/其他页返回时刷新心愿状态（袋子列表本身变化不大，只在首次拉） */
  if (initialized.value) {
    void dataService.wishlist().then((wish) => { wishlistIds.value = new Set(wish.map((item) => item.id)); }).catch(() => {});
  }
});
</script>

<template>
  <view class="explore-page">
    <!-- 顶部：状态栏留白 + 返回 + 大标题 + 概览行 + 搜索/筛选 -->
    <view class="gallery-head" :style="{ paddingTop: `${statusBarHeight}px` }">
      <view class="gallery-head__nav">
        <view class="gallery-back" hover-class="is-pressed" :hover-stay-time="80" @tap="goBack">
          <image class="gallery-back__icon" src="/static/figma/back.svg" mode="aspectFit" />
        </view>
        <text class="gallery-title">官方图鉴</text>
      </view>
      <text class="gallery-overview">{{ overview }}</text>

      <view class="gallery-search">
        <image class="gallery-search__icon" src="/static/figma/search.svg" mode="aspectFit" />
        <input
          class="gallery-search__input"
          :value="searchText"
          type="text"
          confirm-type="search"
          placeholder="搜索品牌、系列、名称…"
          placeholder-class="gallery-search__placeholder"
          @input="onSearchInput"
          @confirm="applySearch(searchText)"
        />
        <text v-if="searchText" class="gallery-search__clear" @tap="clearSearch">×</text>
      </view>

      <!-- 品牌标签：横滑 chips（全部 + 各品牌，含件数），保留在搜索框下方 -->
      <scroll-view class="gallery-chips" scroll-x enhanced :show-scrollbar="false">
        <view class="gallery-chips__row">
          <view
            class="gallery-chip"
            :class="{ 'is-on': activeBrandId === '' }"
            hover-class="is-pressed"
            :hover-stay-time="80"
            @tap="pickBrand('')"
          >全部</view>
          <view
            v-for="brand in brands"
            :key="brand.id"
            class="gallery-chip"
            :class="{ 'is-on': activeBrandId === brand.id }"
            hover-class="is-pressed"
            :hover-stay-time="80"
            @tap="pickBrand(brand.id)"
          >{{ brand.name }}<text class="gallery-chip__count">{{ brand.bagCount }}</text></view>
        </view>
      </scroll-view>
    </view>

    <!-- 内容区独立滚动 -->
    <scroll-view
      class="explore-scroll"
      scroll-y
      enhanced
      :show-scrollbar="false"
      :refresher-enabled="true"
      :refresher-triggered="refreshing"
      :lower-threshold="160"
      refresher-default-style="black"
      @refresherrefresh="onRefresh"
      @scrolltolower="onScrollToLower"
    >
      <view class="explore-body">
        <view v-if="loadError" class="load-error">{{ loadError }}</view>

        <!-- 骨架屏：列宽 / 卡高跟随当前缩放档位，滚动加载时不跳版 -->
        <view
          v-if="loading && !initialized"
          class="bag-grid"
          :style="gridStyle"
        >
          <view
            v-for="index in 6"
            :key="index"
            class="skeleton-card"
            :style="{ height: `${skeletonH}rpx`, borderRadius: `${cardRadius}rpx` }"
          />
        </view>

        <!-- 搜索无结果 -->
        <view v-else-if="initialized && !loading && !bags.length && hasSearch" class="explore-empty">
          <text class="explore-empty__mark">没有找到</text>
          <text class="explore-empty__sub">换个关键词，或清空搜索看看全部袋子</text>
        </view>

        <!-- 空态 -->
        <view v-else-if="initialized && !loading && !bags.length" class="explore-empty">
          <text class="explore-empty__mark">暂无袋子</text>
          <text class="explore-empty__sub">这个分类下还没有袋子，看看「全部」吧</text>
        </view>

        <!-- 宫格：双指捏合在 3~5 列间缩放，卡内尺寸全部随卡宽派生（与「我的」页同一手感） -->
        <view
          v-else
          class="bag-grid"
          :style="gridStyle"
          @touchstart="gridTouchStart"
          @touchmove="gridTouchMove"
          @touchend="gridTouchEnd"
          @touchcancel="gridTouchEnd"
        >
          <button
            v-for="bag in bags"
            :key="bag.id"
            class="bag-card"
            :style="{ padding: `${cardPadTop}rpx ${cardPadX}rpx ${cardPadBottom}rpx`, borderRadius: `${cardRadius}rpx` }"
            @tap="openBag(bag)"
          >
            <view class="bag-card__art" :style="{ height: `${cardArtH}rpx` }">
              <image
                v-if="bag.thumbnailUrl || bag.displayImageUrl"
                :src="bag.thumbnailUrl || bag.displayImageUrl"
                mode="aspectFit"
                lazy-load
              />
              <view
                v-else
                class="bag-card__placeholder"
                :style="{ width: `${cardArtW}rpx`, height: `${cardArtPlaceholderH}rpx`, borderRadius: `${cardArtPlaceholderRadius}rpx` }"
              />
            </view>
            <text class="bag-card__name" :style="{ marginTop: `${cardNameGap}rpx`, fontSize: `${cardNameSize}rpx` }">{{ bag.name }}</text>
            <text class="bag-card__brand" :style="{ marginTop: `${cardBrandGap}rpx`, fontSize: `${cardBrandSize}rpx` }">{{ bag.brand || '官方精选' }}</text>
            <!-- 快捷圆钮（与首页主卡 hero-quick 同一套视觉）：心形 = 心愿，靶心 = 已有。
                 @tap.stop 防止点按钮时顺手弹开详情浮层 -->
            <view class="bag-card__quick" @tap.stop>
              <view
                class="bag-card__quick-btn"
                hover-class="is-pressed"
                :hover-stay-time="80"
                :style="{ width: `${cardQuickSize}rpx`, height: `${cardQuickSize}rpx` }"
                @tap.stop="toggleWish(bag)"
              >
                <image
                  class="bag-card__quick-icon"
                  :style="{ width: `${cardQuickIconSize}rpx`, height: `${cardQuickIconSize}rpx` }"
                  :src="isWished(bag.id) ? '/static/figma/heart-active.svg' : '/static/figma/heart.svg'"
                  mode="aspectFit"
                />
              </view>
              <view
                class="bag-card__quick-btn"
                hover-class="is-pressed"
                :hover-stay-time="80"
                :style="{ width: `${cardQuickSize}rpx`, height: `${cardQuickSize}rpx` }"
                @tap.stop="claimBag(bag)"
              >
                <image
                  class="bag-card__quick-icon"
                  :style="{ width: `${cardQuickIconSize}rpx`, height: `${cardQuickIconSize}rpx` }"
                  :src="bag.claimed ? '/static/figma/target-marked.svg' : '/static/figma/target.svg'"
                  mode="aspectFit"
                />
              </view>
            </view>
          </button>
        </view>

        <text v-if="loadingMore" class="page-loading">正在加载更多…</text>
        <text v-else-if="bags.length && !nextCursor" class="page-loading">已经到底啦 · 共 {{ bags.length }} 件</text>
      </view>
    </scroll-view>

    <BagImagePreview :show="imagePreview" :sides="detailBag?.sides" :fallback="detailBag?.displayImageUrl" :start-side="previewSide" @close="imagePreview = false" />
    <!-- 详情浮层 -->
    <view v-if="detailBag" class="detail-layer">
      <view class="bag-backdrop" @tap="closeDetail" @touchmove.stop.prevent />
      <view class="detail-card">
        <!-- AB 面：有 B 面图时左右并排（左 A 右 B），点哪面预览从哪面起 -->
        <view v-if="hasBackImage" class="detail-art detail-art--sides">
          <view class="detail-art__pane" @tap="openPreview('FRONT')">
            <image :src="detailFrontImage" mode="aspectFit" />
          </view>
          <view class="detail-art__divider" />
          <view class="detail-art__pane" @tap="openPreview('BACK')">
            <image :src="detailBackImage" mode="aspectFit" />
          </view>
        </view>
        <view v-else class="detail-art" @tap="openPreview('FRONT')">
          <image
            v-if="detailFrontImage"
            :src="detailFrontImage"
            mode="aspectFit"
          />
          <view v-else class="bag-card__placeholder" />
        </view>
        <scroll-view class="detail-scroll" scroll-y enhanced :show-scrollbar="false">
          <text class="detail-name">{{ detailBag.name }}</text>
          <text class="detail-brand">{{ detailBag.brand || '官方精选' }}</text>
          <view v-if="detailBag.tags.length" class="detail-tags">
            <text v-for="tag in detailBag.tags" :key="tag"># {{ tag }}</text>
          </view>
          <text v-if="detailBag.notes" class="detail-note">{{ detailBag.notes }}</text>
          <view class="detail-facts">
            <view class="detail-facts__row">
              <text class="detail-facts__key">已被拥有</text>
              <text class="detail-facts__value">{{ detailBag.claimedCount }} 人</text>
            </view>
          </view>
        </scroll-view>
        <view class="bag-actions">
          <button
            class="detail-wish"
            :class="{ 'is-on': isWished(detailBag.id), 'is-owned': detailBag.claimed }"
            :disabled="detailBag.claimed"
            @tap="toggleWish"
          >
            {{ detailBag.claimed ? '已在收藏架' : isWished(detailBag.id) ? '已加入心愿袋' : '加入心愿袋' }}
          </button>
          <button
            class="detail-claim"
            :class="{ 'is-owned': detailBag.claimed }"
            :disabled="detailBag.claimed || claiming"
            @tap="claimBag"
          >
            {{ detailBag.claimed ? '已拥有' : claiming ? '标记中…' : '标记已有' }}
          </button>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   官方图鉴（发现分类 + 搜索）—— 视觉语言对齐首页 / 收藏架：
   背景 #f2f3f7、玻璃卡、衬线标题、内白边卡面。
   ══════════════════════════════════════════════════════════════ */
.explore-page { position: relative; height: 100vh; display: flex; flex-direction: column; overflow: hidden; background-color: #f2f3f7; }
.explore-scroll { flex: 1 1 auto; min-height: 0; }
.explore-body { padding: 0 30rpx 60rpx; }

/* ── 顶部固定区：大标题 + 概览行 + 搜索框 + 品牌标签 ── */
.gallery-head { flex: 0 0 auto; padding: 0 30rpx 18rpx; }
.gallery-head__nav { display: flex; align-items: center; gap: 10rpx; height: 86rpx; }
.gallery-back { display: flex; align-items: center; justify-content: center; width: 56rpx; height: 56rpx; margin-left: -14rpx; border-radius: 50%; transition: background .18s ease; }
.gallery-back__icon { width: 22rpx; height: 38rpx; }
.gallery-back.is-pressed { background: rgba(20,20,20,.06); }
.gallery-title { color: #141414; font-size: 54rpx; font-weight: 800; letter-spacing: 1rpx; line-height: 1.06; }
.gallery-overview { display: block; margin-top: 8rpx; color: #8d877c; font-size: 24rpx; line-height: 1.4; }

.gallery-search { display: flex; align-items: center; gap: 18rpx; margin-top: 22rpx; padding: 0 29rpx; height: 88rpx; border: 2rpx solid rgba(255,255,255,.75); border-radius: 24rpx; background: rgba(255,255,255,.86); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.9), 0 6rpx 20rpx rgba(52,66,92,.06); }
.gallery-search__icon { flex: 0 0 32rpx; width: 32rpx; height: 32rpx; }
.gallery-search__input { flex: 1 1 auto; min-width: 0; height: 100%; color: #141414; font-size: 26rpx; }
.gallery-search__placeholder { color: #a8a49d; }
.gallery-search__clear { flex: 0 0 auto; padding: 0 6rpx; color: #8d877c; font-size: 34rpx; line-height: 1; }

/* 品牌标签横滑：保留在搜索框下方（全部 + 各品牌 + 件数） */
.gallery-chips { width: 100%; margin-top: 18rpx; white-space: nowrap; }
.gallery-chips__row { display: inline-flex; gap: 14rpx; padding: 2rpx 4rpx; }
.gallery-chip { display: inline-flex; align-items: center; gap: 8rpx; padding: 12rpx 26rpx; border-radius: 32rpx; background: rgba(255,255,255,.75); color: #5d594f; font-size: 24rpx; font-weight: 500; line-height: 1.2; transition: transform .18s ease, background .18s ease, color .18s ease; }
.gallery-chip__count { font-size: 20rpx; color: #a8a49d; }
.gallery-chip.is-on { background: #141414; color: #ffffff; }
.gallery-chip.is-on .gallery-chip__count { color: rgba(255,255,255,.7); }
.gallery-chip.is-pressed { transform: scale(.94); }

/* ── 宫格 ──
   列数 / 卡宽 / 卡内尺寸（图区高、内边距、圆角、字号）全部由模板内联注入：
   双指捏合在 3~5 列间缩放，卡宽是唯一真源，见 script 里的 gridCols / cardW。
   这里只留不随缩放变化的视觉 —— 底色、内白边、排版与省略号；
   下列数值 = 3 列档位（卡宽 219rpx）的标注，作兜底用，实际以内联样式为准。 */
.bag-grid { display: grid; }
.skeleton-card { height: 320rpx; border-radius: 26rpx; background: rgba(255,255,255,.6); }
.bag-card { position: relative; display: flex; flex-direction: column; align-items: center; margin: 0; padding: 14rpx 10rpx 18rpx; border: 0; border-radius: 26rpx; background: rgba(255,255,255,.6); box-shadow: inset 0 0 0 2rpx rgba(255,255,255,.9); overflow: hidden; }
.bag-card__art { display: flex; align-items: center; justify-content: center; width: 100%; height: 196rpx; }
.bag-card__art image { width: 100%; height: 100%; filter: drop-shadow(0 7rpx 16rpx rgba(0,0,0,.16)); }
.bag-card__placeholder { width: 112rpx; height: 156rpx; border-radius: 20rpx; background: rgba(255,255,255,.62); }
.bag-card__name { width: 100%; margin-top: 14rpx; color: #17150f; font-size: 25rpx; font-weight: 700; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
.bag-card__brand { width: 100%; margin-top: 6rpx; color: #8d877c; font-size: 20rpx; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
/* 右上角快捷圆钮：与首页主卡 .hero-quick 同一套视觉（白色半透明圆底 + 心形/靶心 SVG）。
   钮径与图标尺寸随卡宽派生（内联注入），并设下限保证缩到 5 列时仍可点中；
   已有态由 target-marked.svg 红靶心直接表达，心愿态由 heart-active.svg 红心表达 */
.bag-card__quick { position: absolute; z-index: 2; top: 12rpx; right: 12rpx; display: flex; gap: 10rpx; }
.bag-card__quick-btn { display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(255,255,255,.88); box-shadow: 0 2rpx 8rpx rgba(0,0,0,.08); transition: transform .18s ease; }
.bag-card__quick-btn.is-pressed { transform: scale(.86); }
.bag-card__quick-icon { width: 24rpx; height: 24rpx; }

/* ── 空态 / 无结果 ── */
.explore-empty { padding: 120rpx 60rpx 60rpx; text-align: center; }
.explore-empty__mark { display: block; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 56rpx; font-weight: 900; letter-spacing: 3rpx; line-height: 1; opacity: .18; }
.explore-empty__sub { display: block; margin-top: 24rpx; color: #77736d; font-size: 24rpx; }

.load-error { margin: 28rpx 8rpx; padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: var(--wc-font-description); text-align: center; }
.page-loading { display: block; padding: 30rpx 0; color: #a8a49d; font-size: 20rpx; letter-spacing: .5rpx; text-align: center; }

/* ── 详情浮层 ── */
.detail-layer { position: fixed; z-index: 950; top: 0; left: 0; right: 0; bottom: 0; }
.bag-backdrop { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(15,15,15,.55); animation: fade-in .2s ease both; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.detail-card { position: absolute; z-index: 1; top: 0; right: 0; bottom: 0; left: 0; width: 620rpx; height: 940rpx; max-height: calc(100vh - 180rpx); margin: auto; display: flex; flex-direction: column; overflow: hidden; border: 2rpx solid rgba(255,255,255,.62); border-radius: 48rpx; background: linear-gradient(160deg, #ffffff 0%, #fafbfd 56%, #f2f4f8 100%); box-shadow: 0 29rpx 65rpx rgba(52,66,92,.16), 0 55rpx 145rpx rgba(0,0,0,.26); animation: card-in .3s cubic-bezier(.2,.78,.22,1) both; }
@keyframes card-in { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: scale(1); } }
.detail-art { display: flex; align-items: center; justify-content: center; flex: 0 0 auto; height: 400rpx; padding: 20rpx; }
.detail-art image { width: 100%; height: 100%; filter: drop-shadow(0 7rpx 18rpx rgba(0,0,0,.18)); }
/* ── 详情 AB 面并排：有 B 面图时图区切成左右两栏（左 A 右 B），中间竖分隔线；
   点任一面放大预览会从对应面起播。pane 用 stretch 撑满图区高，图仍 aspectFit 等比居中 ── */
.detail-art--sides { align-items: stretch; padding: 20rpx 14rpx; }
.detail-art__pane { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; }
.detail-art__pane image { width: 100%; height: 100%; filter: drop-shadow(0 7rpx 18rpx rgba(0,0,0,.18)); }
.detail-art__divider { flex: 0 0 1rpx; align-self: stretch; margin: 10rpx 0; background: rgba(20,20,20,.1); }
.detail-scroll { flex: 1 1 auto; min-height: 0; padding: 10rpx 44rpx 30rpx; }
.detail-name { display: block; color: #1d1a15; font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: 40rpx; font-weight: 700; line-height: 1.2; }
.detail-brand { display: block; margin-top: 12rpx; color: #8d877c; font-size: 24rpx; line-height: 1.4; }
.detail-tags { display: flex; flex-wrap: wrap; gap: 9rpx; margin-top: 20rpx; }
.detail-tags text { padding: 7rpx 16rpx; border-radius: 18rpx; background: rgba(20,20,20,.055); color: #5d594f; font-size: 24rpx; line-height: 1.2; }
.detail-note { display: block; margin-top: 20rpx; color: #5f5b53; font-size: 24rpx; line-height: 1.55; }
.detail-facts { margin-top: 22rpx; padding-top: 20rpx; border-top: 1rpx solid rgba(20,20,20,.08); }
.detail-facts__row { display: flex; align-items: baseline; justify-content: space-between; gap: 18rpx; }
.detail-facts__key { color: #77736d; font-size: 24rpx; }
.detail-facts__value { color: #2b2720; font-size: 24rpx; font-weight: 600; }
.bag-actions { display: flex; gap: 16rpx; padding: 20rpx 44rpx 40rpx; }
.detail-wish { flex: 1 1 0; display: flex; align-items: center; justify-content: center; height: 84rpx; margin: 0; border: 2rpx solid rgba(20,20,20,.18); border-radius: 42rpx; background: transparent; color: #141414; font-size: var(--wc-font-footnote); font-weight: 650; line-height: 1; }
.detail-wish.is-on { border-color: #c50405; color: #c50405; }
/* 已拥有的袋子心愿不可用：置灰，避免「已经到手还标想要」 */
.detail-wish.is-owned { border-color: rgba(20,20,20,.1); background: rgba(20,20,20,.04); color: #a8a49d; }
.detail-claim { flex: 1 1 0; display: flex; align-items: center; justify-content: center; height: 84rpx; margin: 0; border: 0; border-radius: 42rpx; background: #141414; color: #ffffff; font-size: var(--wc-font-footnote); font-weight: 650; line-height: 1; }
.detail-claim.is-owned { background: rgba(20,20,20,.12); color: #8d877c; }
</style>

<style>
.explore-scroll::-webkit-scrollbar,
.explore-scroll ::-webkit-scrollbar,
.detail-scroll::-webkit-scrollbar,
.detail-scroll ::-webkit-scrollbar { display: none; width: 0; height: 0; }
</style>
