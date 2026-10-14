<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onScopeDispose, ref, watch } from 'vue';
import { onHide, onShow, onResize, onShareAppMessage, onShareTimeline } from '@dcloudio/uni-app';
import type { Collectible, CollectibleSummary } from '../../types';
import { useLibraryCollection } from '../../services/use-library-collection';
import type { LibraryCardOpen } from '../../services/library-card-events';
import { syncTabBar, setTabBarHidden } from '../../services/tab-bar';
import BagTabBar from '../../components/BagTabBar.vue';
import LibraryShelfRow from '../../components/LibraryShelfRow.vue';
import LibraryGrid from '../../components/LibraryGrid.vue';
import LibraryDetailOverlay from '../../components/LibraryDetailOverlay.vue';

const instance = getCurrentInstance();
const collection = useLibraryCollection({ onLoaded: fillViewportIfNeeded });
const { loading, initialized, loadError, loadingMore, nextCursor, shelves, items, totalCount,
  segment, displayMode, wishlistItems, searchText, keyword, hasSearch, knownTagCounts, groups, visibleWishlist,
  gridItems, wishGridItems, emptyChips, load, loadMore, applySearch, onSearchInput, searchFor,
  clearSearch, switchSegment, upsertShelf, applyUpdated, collectibleNo, onImageError } = collection;
const activeCard = ref<LibraryCardOpen | null>(null);
const detailOverlay = ref<InstanceType<typeof LibraryDetailOverlay> | null>(null);
const gridColumns = ref(4);
const viewportRevision = ref(0);
const tagCounts = computed(() => Array.from(knownTagCounts.value));
const preloadArtwork = computed(() => segment.value === 'wish'
  ? wishGridItems.value[0]?.imageUrl ?? ''
  : displayMode.value === 'grid' ? gridItems.value[0]?.imageUrl ?? '' : groups.value[0]?.entries[0]?.imageUrl ?? '');
let pageVisible = true;
const settingsShow = ref(false);
const refresherTriggered = ref(false);
const headerTop = ref(0), settingsRight = ref(10), settingsSize = ref(32);
// #ifdef MP-WEIXIN
try {
  const capsule = uni.getMenuButtonBoundingClientRect();
  headerTop.value = capsule.top;
  settingsRight.value = uni.getSystemInfoSync().windowWidth - capsule.left + 8;
  settingsSize.value = capsule.height;
} catch { headerTop.value = 0; }
// #endif

function openDetail(request: LibraryCardOpen) { if (pageVisible && !activeCard.value) activeCard.value = request; }
async function removeMine(item: CollectibleSummary) {
  if (await collection.confirmRemove(item) && activeCard.value?.item.id === item.id) detailOverlay.value?.close();
}
async function removeWish(item: CollectibleSummary) {
  if (await collection.removeWish(item) && activeCard.value?.item.id === item.id) detailOverlay.value?.close();
}
function rememberDetail(detail: Collectible) {
  collection.rememberTags(detail);
  const item = collection.items.value.find(current => current.id === detail.id);
  if (item?.sourceOfficialBagId && item.imageRevision !== detail.imageRevision) applyUpdated(detail);
}
function onMarked(source: Collectible, _createdId: string) {
  collection.removeWishLocal(source.id);
  // Refresh summaries once: official claims now reference already-published images.
  void load(true);
}
function onUnmarked(createdId: string) {
  const item = items.value.find(current => current.id === createdId);
  if (item) collection.removeLocal(item);
  void load(true);
}
function fillViewportIfNeeded() {
  nextTick(() => {
    if (!pageVisible || !nextCursor.value || segment.value !== 'mine' || loadingMore.value) return;
    uni.createSelectorQuery().in(instance?.proxy).select('.library-scroll').boundingClientRect()
      .select('.library-body').boundingClientRect().exec(rows => {
        const viewport = rows?.[0] as { height?: number } | null;
        const body = rows?.[1] as { height?: number } | null;
        if (pageVisible && viewport?.height && body?.height && body.height <= viewport.height + 2) void loadMore();
      });
  });
}
watch(() => [segment.value, displayMode.value], fillViewportIfNeeded);
function toggleMode() { displayMode.value = displayMode.value === 'shelf' ? 'grid' : 'shelf'; }
function goAdd() { uni.navigateTo({ url: '/package-editor/pages/add/index' }); }
function goDiscover() { uni.switchTab({ url: '/pages/showcase/index' }); }
function openSettings() { settingsShow.value = true; setTabBarHidden(true); }
function closeSettings() { settingsShow.value = false; syncTabBar(1, !!activeCard.value); }
function swallowTabBarTap() {}
async function onRefresherRefresh() {
  refresherTriggered.value = true;
  try { await load(true); } finally { refresherTriggered.value = false; }
}
function onScrollToLower() { collection.appendGridRender(); void loadMore(); }
onShow(() => {
  pageVisible = true;
  syncTabBar(1, !!activeCard.value || settingsShow.value);
  nextTick(() => { if (pageVisible) detailOverlay.value?.prepare(); });
  if (collection.needsRefresh()) void load();
});
onHide(() => { pageVisible = false; collection.cancelSearchTimer(); detailOverlay.value?.suspend(); closeSettings(); });
onScopeDispose(() => { pageVisible = false; });
onResize(() => { viewportRevision.value += 1; detailOverlay.value?.resize(); });
onShareAppMessage(() => ({ title: '袋袋集 · 我的纸袋收藏架', path: '/pages/library/index' }));
onShareTimeline(() => ({ title: '袋袋集 · 我的纸袋收藏架', query: '' }));
</script>

<template>
  <view class="library-page">
    <BagTabBar />

    <view v-if="!loadError" class="library-header" :style="{ paddingTop: `${headerTop}px` }">
      <view class="library-copy">

        <view class="library-tabs">
          <button class="library-tab" :class="{ 'is-on': segment === 'mine' }" @tap="switchSegment('mine')">我的</button>
          <button class="library-tab" :class="{ 'is-on': segment === 'wish' }" @tap="switchSegment('wish')">心愿袋</button>
        </view>

        <text v-if="initialized && segment === 'mine'" class="library-summary">{{ totalCount }} 件收藏 · {{ groups.length }} 个展示架</text>
        <text v-else-if="initialized && segment === 'wish'" class="library-summary">心愿袋 · {{ wishlistItems.length }} 件</text>
      </view>
    </view>

    <button
      class="header-settings"
      aria-label="打开设置"
      :style="{ top: `${headerTop}px`, right: `${settingsRight}px`, width: `${settingsSize}px`, height: `${settingsSize}px` }"
      @tap="openSettings"
    >
      <image class="header-settings__icon" :style="{ width: `${Math.round(settingsSize * 0.7)}px`, height: `${Math.round(settingsSize * 0.7)}px` }" src="/static/figma/settings-nut.svg" mode="aspectFit" />
    </button>


    <scroll-view
      class="library-scroll"
      scroll-y
      enhanced
      :show-scrollbar="false"
      :refresher-enabled="true"
      :refresher-triggered="refresherTriggered"
      refresher-default-style="black"
      @refresherrefresh="onRefresherRefresh"
      @scrolltolower="onScrollToLower"
    >
      <view class="library-body">

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

      <button class="mode-button" :class="{ 'is-ghost': segment !== 'mine' }" hover-class="is-pressed" :hover-stay-time="80" :aria-label="displayMode === 'shelf' ? '切换为宫格展示' : '切换为展架展示'" @tap="toggleMode">
        <image :src="displayMode === 'shelf' ? '/static/figma/grid.svg' : '/static/figma/shelf.svg'" mode="aspectFit" />
        <text>{{ displayMode === 'shelf' ? '宫格' : '展架' }}</text>
      </button>
    </view>

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


    <view v-else-if="!items.length" class="zero-state">
      <image class="zero-state__art" src="/static/figma/empty-state.png" mode="aspectFit" />
      <text class="zero-state__title">还没有收藏</text>
      <text class="zero-state__sub">拍下你的第一个纸袋，开始你的陈列柜</text>
      <button class="zero-state__cta" @tap="goAdd">去添加收藏</button>
    </view>

    <view v-else-if="displayMode === 'shelf'" class="shelf-list">
      <LibraryShelfRow v-for="(group, index) in groups" :key="group.id" :group="group" :index="index" :active-id="activeCard?.item.id" :viewport-revision="viewportRevision" @open="openDetail" @longpress="removeMine" @image-error="onImageError" />
    </view>
    <LibraryGrid v-else v-model:columns="gridColumns" :entries="gridItems" mode="mine" :active-id="activeCard?.item.id" :total="items.length" @open="openDetail" @longpress="removeMine" @image-error="onImageError" />

    <text v-if="loadingMore" class="page-loading">正在加载更多…</text>
    </template>


    <template v-else>
      <view v-if="!initialized" class="skeleton-list"><view class="skeleton-shelf"><view class="skeleton-text skeleton-text--shelf" /></view></view>
      <view v-else-if="!wishlistItems.length" class="wish-empty">
        <image class="wish-empty__art" src="/static/figma/empty-state.png" mode="aspectFit" />
        <text class="wish-empty__title">心愿袋空空的</text>
        <text class="wish-empty__sub">去发现页逛逛，把喜欢的纸袋收进来</text>
        <button class="wish-empty__cta" @tap="goDiscover">去发现页</button>
      </view>
      <LibraryGrid v-else v-model:columns="gridColumns" :entries="wishGridItems" mode="wish" :active-id="activeCard?.item.id" :total="visibleWishlist.length" @open="openDetail" @longpress="removeWish" />
      <view v-if="initialized && wishlistItems.length && !visibleWishlist.length" class="wish-empty wish-empty--narrow">
        <text class="wish-empty__title">没有匹配的心愿</text>
        <text class="wish-empty__sub">换个关键词试试，或清空搜索查看全部</text>
      </view>
    </template>
      </view>
    </scroll-view>

    <LibraryDetailOverlay ref="detailOverlay" :request="activeCard" :number="activeCard ? collectibleNo(activeCard.item) : ''" :shelves="shelves" :known-tag-counts="tagCounts" :preload-artwork="preloadArtwork" @closed="activeCard = null" @updated="applyUpdated" @detail-loaded="rememberDetail" @shelf-created="upsertShelf" @remove="removeMine" @remove-wish="removeWish" @marked="onMarked" @unmarked="onUnmarked" />
    <settings-sheet :show="settingsShow" @close="closeSettings" />

    <view class="tab-shield" @tap.stop="swallowTabBarTap" />
  </view>
</template>

<style scoped>
.library-page { position: relative; height: 100vh; display: flex; flex-direction: column; overflow: hidden; background-color: #f2f3f7; }
.library-scroll { flex: 1 1 auto; min-height: 0; }
.library-body { padding-bottom: 186rpx; }
.library-tabs { display: flex; align-items: flex-end; gap: 20rpx; }
.library-tab { position: relative; min-height: 0; margin: 0; padding: 0 4rpx 14rpx; border: 0; background: transparent; color: #b3afa8; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 48rpx; font-weight: 700; line-height: 1; }
.library-tab.is-on { color: #141414; }
.library-tab.is-on::after { content: ""; position: absolute; left: 50%; top: auto; bottom: 0; transform: none; width: 40rpx; height: 6rpx; margin-left: -20rpx; border: 0; border-radius: 3rpx; background: #C50405; }
.header-settings { position: absolute; z-index: 20; display: flex; align-items: center; justify-content: center; margin: 0; padding: 0; border: 2rpx solid rgba(255,255,255,.75); border-radius: 14px; background: rgba(255,255,255,.6); box-shadow: 0 11rpx 25rpx rgba(52,66,92,.08), inset 0 2rpx 0 rgba(255,255,255,.8); }
.header-settings__icon { display: block; }
.wish-empty { display: flex; flex-direction: column; align-items: center; padding: 110rpx 60rpx 60rpx; }
.wish-empty--narrow { padding: 90rpx 60rpx 40rpx; }
.wish-empty--narrow .wish-empty__title { margin-top: 0; }
.wish-empty__art { width: 300rpx; height: 300rpx; opacity: .92; }
.wish-empty__title { margin-top: 20rpx; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 34rpx; font-weight: 700; }
.wish-empty__sub { margin-top: 12rpx; color: #77736d; font-size: 24rpx; }
.wish-empty__cta { min-height: 0; margin: 40rpx 0 0; padding: 20rpx 56rpx; display: flex; align-items: center; border: 0; border-radius: 44rpx; background: #141414; color: #ffffff; font-size: 26rpx; font-weight: 650; line-height: 1; }
.library-header { display: flex; align-items: center; gap: 16rpx; padding: 0 36rpx 20rpx; }
.library-copy { display: flex; flex-direction: column; min-height: 120rpx; }
.library-title { color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 60rpx; font-weight: 900; line-height: 1; letter-spacing: 3rpx; -webkit-text-stroke: 1rpx #141414; }
.library-summary { margin-top: 11rpx; color: #77736d; font-size: var(--wc-font-description); line-height: 1.4; }
.mode-button { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8rpx; min-width: 0; margin: 0; padding: 14rpx 22rpx; border: 2rpx solid rgba(255,255,255,.75); border-radius: 24rpx; background: rgba(255,255,255,.6); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.8); color: #77736d; font-size: 20rpx; font-weight: 400; line-height: 1.1; transition: transform .18s ease, box-shadow .18s ease; }
.mode-button.is-pressed { transform: scale(.94); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.8); }
.mode-button.is-ghost { visibility: hidden; }
.mode-button image { display: block; width: 44rpx; height: 44rpx; }
.mode-button text { letter-spacing: 2rpx; margin-right: -2rpx; }
.search-row { display: flex; align-items: stretch; gap: 14rpx; margin: 0 33rpx 20rpx; }
.search-box { flex: 1 1 auto; min-width: 0; padding: 0 29rpx; display: flex; align-items: center; gap: 18rpx; border: 2rpx solid rgba(255,255,255,.75); border-radius: 24rpx; background: rgba(255,255,255,.86); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.9), 0 6rpx 20rpx rgba(52,66,92,.06); }
.search-icon { flex: 0 0 32rpx; width: 32rpx; height: 32rpx; }
.search-input { flex: 1; min-width: 0; height: 100%; color: #141414; font-size: var(--wc-font-footnote); }
.search-placeholder { color: #a8a49d; }
.search-clear { flex: 0 0 auto; padding: 0 6rpx; color: #8d877c; font-size: 34rpx; line-height: 1; }
@keyframes view-swap { from { opacity: 0; transform: translateY(11rpx); } to { opacity: 1; transform: translateY(0); } }
.shelf-list { margin-top: 0; }
.shelf-list { animation: view-swap .26s ease both; }
.skeleton-list { animation: none; }
.zero-state { display: flex; flex-direction: column; align-items: center; padding: 110rpx 60rpx 60rpx; }
.zero-state__art { width: 300rpx; height: 300rpx; opacity: .92; }
.zero-state__title { margin-top: 20rpx; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 34rpx; font-weight: 700; }
.zero-state__sub { margin-top: 12rpx; color: #77736d; font-size: 24rpx; }
.zero-state__cta { min-height: 0; margin: 40rpx 0 0; padding: 20rpx 56rpx; display: flex; align-items: center; border: 0; border-radius: 44rpx; background: #141414; color: #ffffff; font-size: 26rpx; font-weight: 650; line-height: 1; }
.search-empty { padding: 106rpx 36rpx 55rpx; text-align: center; }
.search-empty__mark { display: block; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 62rpx; font-weight: 900; letter-spacing: 3.6rpx; line-height: 1; opacity: .16; }
.search-empty__sub { display: block; margin-top: 29rpx; color: #77736d; font-size: 22rpx; }
.empty-chips { display: flex; flex-wrap: wrap; gap: 13rpx; justify-content: center; margin-top: 33rpx; }
.empty-chip { padding: 11rpx 22rpx; border-radius: 36rpx; background: rgba(20,20,20,.05); color: #77736d; font-size: 20rpx; font-weight: 650; line-height: 1.2; transition: transform .18s ease, background .18s ease; }
.empty-chip.is-pressed { transform: scale(.94); background: rgba(20,20,20,.09); color: #141414; }
.page-loading { display: block; padding: 30rpx 0; color: #7a7c80; font-size: var(--wc-font-footnote); font-weight: 500; text-align: center; }
.load-error { margin: 40rpx 30rpx 0; padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: var(--wc-font-description); font-weight: 500; text-align: center; }
.skeleton-text { width: 230rpx; height: 24rpx; border-radius: 999rpx; background: rgba(255,255,255,.75); }
.skeleton-list { margin-top: 0; }
.skeleton-shelf { position: relative; height: 346rpx; margin-bottom: 55rpx; padding: 0 40rpx; }
.skeleton-text--shelf { width: 180rpx; margin-bottom: 12rpx; }
.skeleton-items { display: flex; gap: 10rpx; padding-top: 29rpx; }
.skeleton-item { width: 175rpx; height: 270rpx; border-radius: 24rpx; background: rgba(255,255,255,.62); transform: translateY(-18rpx); }
.skeleton-board { position: absolute; left: 25rpx; right: 25rpx; bottom: 25rpx; height: 104rpx; border-radius: 16rpx; background: rgba(210,214,220,.72); }
.tab-shield { position: fixed; z-index: 899; left: 0; right: 0; bottom: 0; height: 150rpx; }
.is-flipping > .detail-card { animation: library-card-front var(--card-flip-duration) steps(1, end) both; }
.is-flipping > .detail-card-back { animation: library-card-back var(--card-flip-duration) steps(1, end) both; }
</style>
