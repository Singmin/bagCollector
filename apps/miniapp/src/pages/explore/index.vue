<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import type { Brand, OfficialBag } from '../../types';
import { dataService } from '../../services/data';

/* ── 官方图鉴页（从首页入口进入）：按品牌分类浏览官方袋子 + 搜索；
      卡片右上角用角标区分「已有」与「心愿」，顶行给出只数 / 品牌 / 已有 / 心愿概览 ──
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
/* 标记已有：直接调认领接口，不再拉半窗（claiming 用于防重复点击） */
const claiming = ref(false);

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
  })().finally(() => { refreshPromise = undefined; });
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
function openBag(bag: OfficialBag) {
  detailBag.value = bag;
}

function closeDetail() {
  detailBag.value = null;
}

function isWished(id: string) {
  return wishlistIds.value.has(id);
}

async function toggleWish() {
  const bag = detailBag.value;
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
async function claimBag() {
  const bag = detailBag.value;
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
onShow(() => {
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
      refresher-default-style="black"
      @refresherrefresh="onRefresh"
      @scrolltolower="onScrollToLower"
    >
      <view class="explore-body">
        <view v-if="loadError" class="load-error">{{ loadError }}</view>

        <!-- 骨架屏 -->
        <view v-if="loading && !initialized" class="bag-grid skeleton-grid">
          <view v-for="index in 6" :key="index" class="skeleton-card" />
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

        <!-- 宫格 -->
        <view v-else class="bag-grid">
          <button
            v-for="bag in bags"
            :key="bag.id"
            class="bag-card"
            @tap="openBag(bag)"
          >
            <view class="bag-card__art">
              <image
                v-if="bag.thumbnailUrl || bag.displayImageUrl"
                :src="bag.thumbnailUrl || bag.displayImageUrl"
                mode="aspectFit"
                lazy-load
              />
              <view v-else class="bag-card__placeholder" />
            </view>
            <text class="bag-card__name">{{ bag.name }}</text>
            <text class="bag-card__brand">{{ bag.brand || '官方精选' }}</text>
            <!-- 状态角标：已有（右上 · 金）；心愿（右上 · 红）。两个状态同时存在时心愿挪到左上，
                 保证「在心愿单」和「已拥有」都能一眼看到 -->
            <view v-if="bag.claimed" class="bag-card__badge bag-card__badge--owned">已有</view>
            <view
              v-if="isWished(bag.id)"
              class="bag-card__badge bag-card__badge--wish"
              :class="{ 'is-corner-left': bag.claimed }"
            >♥ 心愿</view>
          </button>
        </view>

        <text v-if="loadingMore" class="page-loading">正在加载更多…</text>
        <text v-else-if="bags.length && !nextCursor" class="page-loading">已经到底啦 · 共 {{ bags.length }} 件</text>
      </view>
    </scroll-view>

    <!-- 详情浮层 -->
    <view v-if="detailBag" class="detail-layer">
      <view class="bag-backdrop" @tap="closeDetail" @touchmove.stop.prevent />
      <view class="detail-card">
        <view class="detail-art">
          <image
            v-if="detailBag.displayImageUrl || detailBag.thumbnailUrl"
            :src="detailBag.displayImageUrl || detailBag.thumbnailUrl"
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

.gallery-search { display: flex; align-items: center; gap: 18rpx; margin-top: 22rpx; padding: 0 29rpx; height: 88rpx; border: 2rpx solid rgba(255,255,255,.8); border-radius: 44rpx; background: rgba(255,255,255,.86); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.9), 0 6rpx 20rpx rgba(52,66,92,.06); }
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

/* ── 宫格 ── */
.bag-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16rpx; }
.skeleton-grid { grid-template-columns: repeat(3, 1fr); }
.skeleton-card { height: 320rpx; border-radius: 26rpx; background: rgba(255,255,255,.6); }
.bag-card { position: relative; display: flex; flex-direction: column; align-items: center; margin: 0; padding: 14rpx 10rpx 18rpx; border: 0; border-radius: 26rpx; background: rgba(255,255,255,.6); box-shadow: inset 0 0 0 2rpx rgba(255,255,255,.9); overflow: hidden; }
.bag-card__art { display: flex; align-items: center; justify-content: center; width: 100%; height: 196rpx; }
.bag-card__art image { width: 100%; height: 100%; filter: drop-shadow(0 7rpx 16rpx rgba(0,0,0,.16)); }
.bag-card__placeholder { width: 112rpx; height: 156rpx; border-radius: 20rpx; background: rgba(255,255,255,.62); }
.bag-card__name { width: 100%; margin-top: 14rpx; color: #17150f; font-size: 25rpx; font-weight: 700; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
.bag-card__brand { width: 100%; margin-top: 6rpx; color: #8d877c; font-size: 20rpx; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
/* 角标：已有 = 金（右上优先位），心愿 = 红（已有同时存在时挪到左上） */
.bag-card__badge { position: absolute; z-index: 2; top: 12rpx; right: 12rpx; padding: 6rpx 14rpx; border-radius: 999rpx; font-size: 20rpx; font-weight: 600; line-height: 1.2; }
.bag-card__badge--owned { background: #c8a24a; color: #ffffff; box-shadow: 0 4rpx 12rpx rgba(162,124,38,.3); }
.bag-card__badge--wish { background: #c50405; color: #ffffff; box-shadow: 0 4rpx 12rpx rgba(197,4,5,.26); }
.bag-card__badge--wish.is-corner-left { right: auto; left: 12rpx; }

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
