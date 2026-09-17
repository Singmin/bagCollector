<script setup lang="ts">
import { ref } from 'vue';
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import CollectibleCard from '../../components/CollectibleCard.vue';
import EmptyState from '../../components/EmptyState.vue';
import type { Collectible, Shelf } from '../../types';
import { readCache, writeCache } from '../../services/cache';
import { dataService } from '../../services/data';

interface ShelfGroup extends Shelf { items: Collectible[] }

const loading = ref(true);
const offline = ref(false);
const items = ref<Collectible[]>([]);
const recent = ref<Collectible[]>([]);
const groups = ref<ShelfGroup[]>([]);

function applyData(nextItems: Collectible[], shelves: Shelf[], isOffline: boolean) {
  items.value = nextItems;
  recent.value = nextItems.slice(0, 6);
  groups.value = shelves.map((shelf) => ({ ...shelf, items: nextItems.filter((item) => item.shelfId === shelf.id) }))
    .filter((group) => group.items.length > 0);
  offline.value = isOffline;
  loading.value = false;
}

async function load(force = false) {
  const cached = readCache<{ items: Collectible[]; shelves: Shelf[] }>('showcase');
  if (cached && !force) applyData(cached.items, cached.shelves, true);
  try {
    const [page, shelves] = await Promise.all([dataService.collectibles('limit=100'), dataService.shelves()]);
    writeCache('showcase', { items: page.items, shelves });
    applyData(page.items, shelves, false);
  } catch (error) {
    console.error(error);
    if (!cached) uni.showToast({ title: '加载失败，请检查网络', icon: 'none' });
    loading.value = false;
    offline.value = Boolean(cached);
  }
}

onShow(() => void load());
onPullDownRefresh(() => void load(true).finally(() => uni.stopPullDownRefresh()));
function openSettings() { uni.navigateTo({ url: '/package-settings/pages/settings/index' }); }
function add() { uni.navigateTo({ url: '/package-editor/pages/add/index' }); }
function showAll() { uni.switchTab({ url: '/pages/library/index' }); }
</script>

<template>
  <view class="page showcase-page">
    <view class="topbar">
      <view><text class="eyebrow">MY PRIVATE CABINET</text><text class="display-title">BagCollect</text><text class="summary">{{ items.length }} 件收藏 · {{ groups.length }} 个展示架</text></view>
      <button class="round-button" aria-label="打开设置" @tap="openSettings">⚙</button>
    </view>
    <view v-if="offline" class="offline-banner">当前离线，正在显示上次保存的内容</view>
    <EmptyState v-if="!loading && !items.length" title="开始你的私人陈列柜" description="选择一张照片，整理成只属于你的视觉收藏。" action="添加第一件收藏" @action="add" />
    <template v-else>
      <view class="section-heading"><view><text class="eyebrow">RECENTLY ADDED</text><text class="section-title">最近加入</text></view><button class="text-action" @tap="showAll">查看全部 →</button></view>
      <scroll-view class="recent-scroll" scroll-x :show-scrollbar="false"><view class="recent-row"><CollectibleCard v-for="item in recent" :key="item.id" :item="item" compact /></view></scroll-view>
      <view v-for="(group, index) in groups" :key="group.id" class="shelf-section">
        <view class="shelf-heading"><view><text class="eyebrow">SHELF {{ index + 1 }}</text><text class="section-title">{{ group.name }}</text></view><text class="shelf-count">{{ group.items.length }} 件 ↔</text></view>
        <scroll-view class="shelf-scroll" scroll-x :show-scrollbar="false"><view class="shelf-row"><CollectibleCard v-for="item in group.items" :key="item.id" :item="item" compact /></view></scroll-view>
        <view class="acrylic-shelf" :class="`acrylic-shelf--${group.theme}`"><view /><view /></view>
      </view>
    </template>
  </view>
</template>

<style scoped>
.showcase-page { overflow: hidden; }.topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 20rpx; margin: 14rpx 0 66rpx; }.display-title { display: block; margin-top: 9rpx; }.summary { display: block; margin-top: 17rpx; color: #7b746a; font-size: 24rpx; }.round-button { width: 80rpx; height: 80rpx; margin: 2rpx 0 0; padding: 0; display: grid; place-items: center; border: 1rpx solid #cec5b8; border-radius: 50%; background: rgba(255,253,248,.72); color: #2c2823; font-size: 30rpx; }.offline-banner { margin: -36rpx 0 36rpx; padding: 18rpx 22rpx; border-radius: 18rpx; background: #f8eccc; color: #795b27; font-size: 22rpx; }.section-heading,.shelf-heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 20rpx; }.section-title { display: block; margin-top: 8rpx; }.text-action { margin: 0; padding: 10rpx 0; background: transparent; color: #625c53; font-size: 23rpx; }.recent-scroll,.shelf-scroll { width: calc(100% + 32rpx); margin-top: 26rpx; }.recent-row,.shelf-row { display: inline-flex; gap: 22rpx; padding-right: 32rpx; }.shelf-section { margin-top: 82rpx; }.shelf-count { color: #7a7369; font-size: 22rpx; }.acrylic-shelf { position: relative; height: 24rpx; margin-top: 14rpx; border-radius: 6rpx 6rpx 12rpx 12rpx; background: rgba(177,156,121,.4); box-shadow: 0 18rpx 24rpx rgba(69,55,35,.14); }.acrylic-shelf view { position: absolute; top: 24rpx; width: 14rpx; height: 28rpx; background: inherit; }.acrylic-shelf view:first-child { left: 42rpx; }.acrylic-shelf view:last-child { right: 42rpx; }.acrylic-shelf--SAGE { background: rgba(115,143,122,.42); }.acrylic-shelf--AMBER { background: rgba(188,138,71,.43); }.acrylic-shelf--SKY { background: rgba(97,137,164,.4); }.acrylic-shelf--ROSE { background: rgba(176,119,127,.4); }.acrylic-shelf--GRAPHITE { background: rgba(76,76,73,.42); }
</style>
