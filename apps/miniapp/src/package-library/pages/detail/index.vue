<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import type { Collectible, Shelf } from '../../../types';
import { dataService } from '../../../services/data';

const id = ref(''); const item = ref<Collectible | null>(null); const shelves = ref<Shelf[]>([]); const shelfIndex = ref(0);
const editing = ref(false); const name = ref(''); const notes = ref(''); const tags = ref('');
const displayDate = computed(() => item.value?.addedAt.slice(0, 10) || '');
const selectedShelfName = computed(() => shelves.value[shelfIndex.value]?.name || '未分类');

async function load() {
  if (!id.value) return;
  try {
    const [nextItem, nextShelves] = await Promise.all([dataService.collectible(id.value), dataService.shelves()]);
    item.value = nextItem; shelves.value = nextShelves; shelfIndex.value = Math.max(0, nextShelves.findIndex((shelf) => shelf.id === nextItem.shelfId));
    name.value = nextItem.name; notes.value = nextItem.notes; tags.value = nextItem.tags.join('，');
  } catch { uni.showToast({ title: '加载失败', icon: 'none' }); }
}
async function save() {
  const shelf = shelves.value[shelfIndex.value];
  try {
    item.value = await dataService.updateCollectible(id.value, { name: name.value.trim() || '未命名收藏', notes: notes.value.trim(), tags: tags.value.split(/[,，、;；\n]/).map((tag) => tag.trim()).filter(Boolean), ...(shelf ? { shelfId: shelf.id } : {}) });
    editing.value = false; uni.showToast({ title: '已保存', icon: 'success' });
  } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' }); }
}
function remove() {
  uni.showModal({ title: '删除这件收藏？', content: '图片和收藏信息将从云端永久删除。', confirmText: '删除', confirmColor: '#9d3d36', success: async (result) => {
    if (!result.confirm) return;
    try { await dataService.removeCollectible(id.value); uni.showToast({ title: '已删除' }); setTimeout(() => uni.navigateBack(), 500); }
    catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '删除失败', icon: 'none' }); }
  } });
}
function retryProcessing() { uni.navigateTo({ url: `/package-editor/pages/processing/index?id=${id.value}&stage=matting` }); }
function recrop() { uni.navigateTo({ url: `/package-editor/pages/crop/index?id=${id.value}` }); }
onLoad((query) => { id.value = String(query?.id || ''); }); onShow(() => void load());
</script>

<template>
  <view v-if="item" class="page detail-page"><view class="art card"><image :src="item.displayImageUrl || item.standardImageUrl" mode="aspectFit" /></view>
    <view v-if="!editing" class="content"><text class="eyebrow">PRIVATE OBJECT</text><text class="display-title">{{ item.name }}</text><text class="meta">{{ item.shelfName }} · {{ displayDate }}</text>
      <view class="tags"><text v-for="tag in item.tags" :key="tag"># {{ tag }}</text></view><text v-if="item.notes" class="notes">{{ item.notes }}</text>
      <view v-if="item.processingStatus === 'FAILED'" class="failure"><text>{{ item.processingError }}</text><button @tap="retryProcessing">重试处理</button></view>
      <view class="actions"><button class="primary-button" @tap="editing = true">编辑信息</button><button class="secondary-button" @tap="recrop">重新裁剪与抠图</button><button class="secondary-button danger-button" @tap="remove">删除收藏</button></view>
    </view>
    <view v-else class="edit-form"><text class="section-title">编辑收藏</text><text class="form-label">名称</text><input v-model="name" class="form-input" maxlength="80" /><text class="form-label">展示架</text><picker mode="selector" :range="shelves" range-key="name" :value="shelfIndex" @change="shelfIndex = Number($event.detail.value)"><view class="form-picker">{{ selectedShelfName }}</view></picker><text class="form-label">标签</text><input v-model="tags" class="form-input" /><text class="form-label">备注</text><textarea v-model="notes" class="form-textarea" maxlength="2000" /><view class="edit-actions"><button class="secondary-button" @tap="editing = false">取消</button><button class="primary-button" @tap="save">保存</button></view></view>
  </view>
</template>

<style scoped>
.art { height: 700rpx; padding: 28rpx; }.art image { width: 100%; height: 100%; }.content { padding: 46rpx 8rpx 0; }.content .display-title { display: block; margin-top: 12rpx; font-size: 58rpx; }.meta { display: block; margin-top: 20rpx; color: #777064; font-size: 24rpx; }.tags { display: flex; flex-wrap: wrap; gap: 12rpx; margin-top: 28rpx; }.tags text { padding: 10rpx 16rpx; border-radius: 999rpx; background: #e6ded2; color: #5e574e; font-size: 22rpx; }.notes { display: block; margin-top: 34rpx; color: #514c45; font-size: 27rpx; line-height: 1.8; white-space: pre-wrap; }.actions { display: grid; gap: 18rpx; margin-top: 48rpx; }.failure { margin-top: 32rpx; padding: 24rpx; border-radius: 20rpx; background: #fae4df; color: #8f3c36; font-size: 23rpx; }.failure button { margin-top: 16rpx; background: #8f3c36; color: white; border-radius: 999rpx; font-size: 23rpx; }.edit-form { padding-top: 48rpx; }.edit-actions { display: grid; grid-template-columns: 1fr 1.4fr; gap: 16rpx; margin-top: 42rpx; }
</style>
