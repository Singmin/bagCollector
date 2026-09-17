<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { Collectible, Shelf } from '../../../types';
import { dataService } from '../../../services/data';

const id = ref(''); const item = ref<Collectible | null>(null); const shelves = ref<Shelf[]>([]); const shelfIndex = ref(0);
const name = ref(''); const notes = ref(''); const tags = ref(''); const saving = ref(false);
const shelfName = computed(() => shelves.value[shelfIndex.value]?.name || '未分类');
async function load() {
  try {
    const [nextItem, nextShelves] = await Promise.all([dataService.collectible(id.value), dataService.shelves()]);
    item.value = nextItem; shelves.value = nextShelves; shelfIndex.value = Math.max(0, nextShelves.findIndex((shelf) => shelf.id === nextItem.shelfId));
    name.value = nextItem.name === '未命名收藏' ? '' : nextItem.name; notes.value = nextItem.notes; tags.value = nextItem.tags.join('，');
  } catch { uni.showToast({ title: '加载失败', icon: 'none' }); }
}
async function save() {
  if (saving.value) return; saving.value = true;
  try {
    const shelf = shelves.value[shelfIndex.value];
    await dataService.updateCollectible(id.value, { name: name.value.trim() || '未命名收藏', notes: notes.value.trim(), tags: tags.value.split(/[,，、;；\n]/).map((tag) => tag.trim()).filter(Boolean), ...(shelf ? { shelfId: shelf.id } : {}) });
    uni.showToast({ title: '已加入陈列柜', icon: 'success' }); setTimeout(() => uni.switchTab({ url: '/pages/showcase/index' }), 700);
  } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' }); saving.value = false; }
}
onLoad((query) => { id.value = String(query?.id || ''); void load(); });
</script>

<template>
  <view class="page metadata-page"><view class="header"><text class="eyebrow">NEW OBJECT · 4 / 4</text><text class="display-title">留下标签</text><text class="intro">名称可以简单一点，故事留给备注。</text></view>
    <view class="preview card"><image :src="item?.displayImageUrl || item?.standardImageUrl" mode="aspectFit" /></view>
    <text class="form-label">名称</text><input v-model="name" class="form-input" placeholder="例如：蓝色书店纸袋" maxlength="80" />
    <text class="form-label">展示架</text><picker mode="selector" :range="shelves" range-key="name" :value="shelfIndex" @change="shelfIndex = Number($event.detail.value)"><view class="form-picker">{{ shelfName }} <text>⌄</text></view></picker>
    <text class="form-label">标签</text><input v-model="tags" class="form-input" placeholder="例如：蓝色，深圳，书店" />
    <text class="form-label">备注</text><textarea v-model="notes" class="form-textarea" placeholder="这件收藏来自哪里？" maxlength="2000" />
    <button class="primary-button save" :disabled="saving" @tap="save">{{ saving ? '保存中…' : '放进陈列柜' }}</button>
  </view>
</template>

<style scoped>
.header { margin: 18rpx 0 36rpx; }.header .display-title { display: block; margin-top: 10rpx; }.intro { display: block; margin-top: 18rpx; color: #777064; font-size: 24rpx; }.preview { height: 430rpx; padding: 24rpx; }.preview image { width: 100%; height: 100%; }.form-picker { display: flex; justify-content: space-between; }.save { margin-top: 44rpx; }
</style>
