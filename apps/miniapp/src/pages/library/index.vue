<script setup lang="ts">
import { ref } from 'vue';
import { onPullDownRefresh, onReachBottom, onShow, onUnload } from '@dcloudio/uni-app';
import CollectibleCard from '../../components/CollectibleCard.vue';
import EmptyState from '../../components/EmptyState.vue';
import type { Collectible, Shelf } from '../../types';
import { readCache, writeCache } from '../../services/cache';
import { dataService } from '../../services/data';

const loading = ref(true);
const loadingMore = ref(false);
const search = ref('');
const activeShelf = ref('');
const nextCursor = ref<string | null>(null);
const shelves = ref<Shelf[]>([]);
const items = ref<Collectible[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function query(cursor?: string) {
  const params = ['limit=30'];
  if (search.value.trim()) params.push(`search=${encodeURIComponent(search.value.trim())}`);
  if (activeShelf.value) params.push(`shelfId=${encodeURIComponent(activeShelf.value)}`);
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  return params.join('&');
}

async function load(force = false) {
  const cached = readCache<{ items: Collectible[]; shelves: Shelf[] }>('library');
  if (cached && !force) { items.value = cached.items; shelves.value = cached.shelves; loading.value = false; }
  try {
    const [page, nextShelves] = await Promise.all([dataService.collectibles(query()), dataService.shelves()]);
    items.value = page.items; shelves.value = nextShelves; nextCursor.value = page.nextCursor; loading.value = false;
    writeCache('library', { items: page.items, shelves: nextShelves });
  } catch {
    if (!cached) uni.showToast({ title: '加载失败', icon: 'none' });
    loading.value = false;
  }
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const page = await dataService.collectibles(query(nextCursor.value));
    const known = new Set(items.value.map((item) => item.id));
    items.value = [...items.value, ...page.items.filter((item) => !known.has(item.id))];
    nextCursor.value = page.nextCursor;
    writeCache('library', { items: items.value, shelves: shelves.value });
  } catch { uni.showToast({ title: '加载更多失败', icon: 'none' }); }
  finally { loadingMore.value = false; }
}

function searchChanged(event: any) {
  search.value = event.detail.value;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void load(true), 350);
}

onShow(() => void load());
onUnload(() => { if (searchTimer) clearTimeout(searchTimer); });
onReachBottom(() => void loadMore());
onPullDownRefresh(() => void load(true).finally(() => uni.stopPullDownRefresh()));
function add() { uni.navigateTo({ url: '/package-editor/pages/add/index' }); }
</script>

<template>
  <view class="page library-page">
    <view class="header"><text class="eyebrow">THE FULL ARCHIVE</text><text class="display-title">全部收藏</text><text class="intro">把喜欢的东西，留在看得见的地方。</text></view>
    <view class="search-box"><text>⌕</text><input :value="search" placeholder="搜索名称或标签" confirm-type="search" @input="searchChanged" /><button v-if="search" @tap="search = ''; load(true)">×</button></view>
    <scroll-view class="filters" scroll-x :show-scrollbar="false"><view class="filter-row"><button class="filter" :class="{ 'is-active': !activeShelf }" @tap="activeShelf = ''; load(true)">全部</button><button v-for="shelf in shelves" :key="shelf.id" class="filter" :class="{ 'is-active': activeShelf === shelf.id }" @tap="activeShelf = shelf.id; load(true)">{{ shelf.name }}</button></view></scroll-view>
    <text class="count">已加载 {{ items.length }} 件</text>
    <view v-if="items.length" class="grid"><CollectibleCard v-for="item in items" :key="item.id" :item="item" /></view>
    <EmptyState v-else-if="!loading" title="没有找到收藏" description="换一个名称或标签试试，或者添加一件新收藏。" action="添加收藏" @action="add" />
    <text v-if="loadingMore" class="page-loading">正在加载更多…</text>
  </view>
</template>

<style scoped>
.header { margin: 14rpx 0 48rpx; }.header .display-title { display: block; margin-top: 9rpx; }.intro { display: block; margin-top: 20rpx; color: #777064; font-size: 25rpx; }.search-box { height: 92rpx; display: flex; align-items: center; gap: 16rpx; padding: 0 24rpx; border: 1rpx solid #d2c8bb; border-radius: 24rpx; background: rgba(255,253,248,.8); }.search-box>text { font-size: 36rpx; }.search-box input { flex: 1; font-size: 27rpx; }.search-box button { width: 56rpx; height: 56rpx; margin: 0; padding: 0; border-radius: 50%; background: #e9e2d7; color: #514c45; font-size: 30rpx; }.filters { width: calc(100% + 32rpx); margin: 28rpx 0 25rpx; }.filter-row { display: inline-flex; gap: 14rpx; padding-right: 32rpx; }.filter { margin: 0; padding: 14rpx 24rpx; border: 1rpx solid #cfc5b7; border-radius: 999rpx; background: rgba(255,255,255,.45); color: #716a60; font-size: 23rpx; white-space: nowrap; line-height: 1.2; }.filter.is-active { background: #211f1c; color: white; border-color: #211f1c; }.count { display: block; margin-bottom: 22rpx; color: #80786d; font-size: 22rpx; }.grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 34rpx 20rpx; }.page-loading { display: block; padding: 36rpx 0 12rpx; text-align: center; color: #80786d; font-size: 22rpx; }
</style>
