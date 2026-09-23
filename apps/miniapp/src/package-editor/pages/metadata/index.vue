<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { Collectible, Shelf } from '../../../types';
import { dataService } from '../../../services/data';

const id = ref(''); const item = ref<Collectible | null>(null);
const name = ref(''); const notes = ref(''); const tags = ref(''); const saving = ref(false); const loadError = ref('');
const shelves = ref<Shelf[]>([]); const shelfIndex = ref(-1);
const selectedShelf = computed(() => shelves.value[shelfIndex.value]);
const creatingShelf = ref(false);
async function createShelf() {
  if (creatingShelf.value) return; creatingShelf.value = true;
  try {
    const dialog = await uni.showModal({ title: '新建分类', editable: true, placeholderText: '例如：旅行纪念' });
    if (!dialog.confirm) return;
    const shelfName = (dialog.content ?? '').trim();
    if (!shelfName) return void uni.showToast({ title: '请填写分类名称', icon: 'none' });
    const shelf = await dataService.createShelf({ name: shelfName, theme: 'SAGE' });
    shelves.value = [...shelves.value, shelf]; shelfIndex.value = shelves.value.length - 1;
    uni.showToast({ title: '已创建', icon: 'success' });
  } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '创建分类失败', icon: 'none' }); }
  finally { creatingShelf.value = false; }
}
async function load() {
  try {
    const [nextItem, nextShelves] = await Promise.all([dataService.collectible(id.value), dataService.shelves()]);
    if (!nextItem.displayImageUrl) throw new Error('收藏缺少展示图');
    item.value = nextItem; shelves.value = nextShelves; name.value = nextItem.name === '未命名纸袋' ? '' : nextItem.name;
    notes.value = nextItem.notes; tags.value = nextItem.tags.join('，');
    shelfIndex.value = Math.max(0, nextShelves.findIndex((shelf) => shelf.id === nextItem.shelfId));
  } catch (error) { loadError.value = error instanceof Error ? error.message : '收藏信息加载失败'; }
}
async function save() {
  const normalizedName = name.value.trim(); const shelf = selectedShelf.value;
  if (!normalizedName) return void uni.showToast({ title: '请填写纸袋名称', icon: 'none' });
  if (!shelf) return void uni.showToast({ title: '请选择或新建分类', icon: 'none' });
  if (saving.value) return; saving.value = true;
  try {
    await dataService.updateCollectible(id.value, { name: normalizedName, shelfId: shelf.id, notes: notes.value.trim(), tags: tags.value.split(/[,，、;；\n]/).map((tag) => tag.trim()).filter(Boolean) });
    uni.showToast({ title: '已加入陈列柜', icon: 'success' }); setTimeout(() => uni.switchTab({ url: '/pages/showcase/index' }), 700);
  } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' }); saving.value = false; }
}
onLoad((query) => {
  if (typeof query?.id !== 'string') return void (loadError.value = '收藏页面参数无效');
  id.value = query.id;
  void load();
});
</script>

<template>
  <view class="page metadata-page"><view class="header"><text class="eyebrow">CUTOUT COMPLETE</text><text class="display-title">完善纸袋信息</text><text class="intro">抠图已完成，最后补充名称、分类和故事。</text></view>
    <view v-if="loadError" class="error">{{ loadError }}</view>
    <view v-else-if="item" class="preview"><view class="preview-guide" /><image :src="item.displayImageUrl" mode="aspectFit" /></view>
    <text class="form-label">名称</text><input v-model="name" class="form-input" placeholder="例如：蓝色书店纸袋" maxlength="80" />
    <text class="form-label">分类</text>
    <scroll-view v-if="!loadError" class="category-scroll" scroll-x :show-scrollbar="false"><view class="category-row"><button v-for="(shelf, index) in shelves" :key="shelf.id" class="category-chip" :class="{ active: shelfIndex === index }" @tap="shelfIndex = index">{{ shelf.name }}</button><button class="category-chip create-chip" :disabled="creatingShelf" @tap="createShelf">＋ 新建分类</button></view></scroll-view>
    <text class="form-label">标签</text><input v-model="tags" class="form-input" placeholder="例如：蓝色，深圳，书店" />
    <text class="form-label">备注</text><textarea v-model="notes" class="form-textarea" placeholder="这件收藏来自哪里？" maxlength="2000" />
    <button class="primary-button save" :disabled="saving || !item || !!loadError || !name.trim() || !selectedShelf" @tap="save">{{ saving ? '保存中…' : '完成收藏' }}</button>
  </view>
</template>

<style scoped>
.metadata-page { padding-top: 30rpx; background: #f2f3f7; }.header { margin: 8rpx 0 32rpx; }.header .display-title { display: block; margin-top: 10rpx; font-size: var(--wc-font-headline); font-weight: 500; }.intro { display: block; margin-top: 18rpx; color: #777064; font-size: var(--wc-font-description); font-weight: 500; }.preview { position: relative; height: 520rpx; overflow: hidden; border-radius: 64rpx; background: #dbbba1; }.preview-guide { position: absolute; inset: 48rpx 70rpx; border: 5rpx dashed rgba(255,255,255,.5); border-radius: 44rpx; }.preview image { position: relative; z-index: 2; width: 100%; height: 100%; filter: drop-shadow(0 16rpx 20rpx rgba(127,82,44,.25)); }.category-scroll { width: 100%; white-space: nowrap; }.category-row { display: inline-flex; gap: 16rpx; padding-right: 30rpx; }.category-chip { min-width: 128rpx; height: 72rpx; margin: 0; padding: 0 28rpx; border: 2rpx solid #d5c9bc; border-radius: 999rpx; background: rgba(255,255,255,.72); color: #5e574e; font-size: var(--wc-font-description); font-weight: 500; line-height: 72rpx; }.category-chip.active { border-color: #c50405; background: #c50405; color: #fff; }.category-chip.create-chip { border-style: dashed; color: #8a8276; }.category-chip.create-chip[disabled] { opacity: .5; }.error { padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: var(--wc-font-footnote); }.save { margin-top: 44rpx; }.save[disabled] { opacity: .4; }
</style>
