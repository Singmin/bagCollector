<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import type { Collectible, Shelf } from '../../../types';
import { dataService } from '../../../services/data';

const id = ref(''); const item = ref<Collectible | null>(null); const shelves = ref<Shelf[]>([]); const shelfIndex = ref(0);
const editing = ref(false); const name = ref(''); const notes = ref(''); const tags = ref(''); const loadError = ref('');
const displayDate = computed(() => item.value ? item.value.addedAt.slice(0, 10) : '');
const selectedShelf = computed(() => shelves.value[shelfIndex.value]);
/* 选择器里比真实列表多一项「＋ 新建展示架」：选中它不切换当前展示架，
   而是走一次新建流程，建完自动选中新建的那个；点取消则当前展示架保持原样。 */
const shelfRange = computed(() => [...shelves.value, { id: '', name: '＋ 新建展示架' }]);
const creatingShelf = ref(false);

async function onShelfChange(event: { detail: { value: number | string } }) {
  const index = Number(event.detail.value);
  if (index !== shelves.value.length) { shelfIndex.value = index; return; }
  await createShelf();
}

// 与「完善纸袋信息」页的新建流程保持一致：弹一个可输入的原生框，新建后落到默认主题（颜色可在展示架管理里改）
async function createShelf() {
  if (creatingShelf.value) return;
  creatingShelf.value = true;
  try {
    const dialog = await uni.showModal({ title: '新建展示架', editable: true, placeholderText: '例如：旅行纪念' });
    if (!dialog.confirm) return;
    const shelfName = (dialog.content ?? '').trim();
    if (!shelfName) return void uni.showToast({ title: '请填写展示架名称', icon: 'none' });
    const shelf = await dataService.createShelf({ name: shelfName, theme: 'SAGE' });
    shelves.value = [...shelves.value, shelf];
    shelfIndex.value = shelves.value.length - 1;
    uni.showToast({ title: '已创建', icon: 'success' });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '新建展示架失败', icon: 'none' });
  } finally {
    creatingShelf.value = false;
  }
}

async function load() {
  if (!id.value) return;
  try {
    const [nextItem, nextShelves] = await Promise.all([dataService.collectible(id.value), dataService.shelves()]);
    if (!nextItem.displayImageUrl) throw new Error('收藏缺少展示图');
    if (Number.isNaN(new Date(nextItem.addedAt).getTime())) throw new Error('收藏日期无效');
    const nextShelfIndex = nextShelves.findIndex((shelf) => shelf.id === nextItem.shelfId);
    if (nextShelfIndex < 0) throw new Error('收藏所属展示架不存在');
    item.value = nextItem; shelves.value = nextShelves; shelfIndex.value = nextShelfIndex;
    name.value = nextItem.name; notes.value = nextItem.notes; tags.value = nextItem.tags.join('，');
  } catch (error) { loadError.value = error instanceof Error ? error.message : '收藏加载失败'; }
}
async function save() {
  const normalizedName = name.value.trim();
  const shelf = selectedShelf.value;
  if (!normalizedName) return void uni.showToast({ title: '请填写收藏名称', icon: 'none' });
  if (!shelf) return void uni.showToast({ title: '请选择展示架', icon: 'none' });
  try {
    item.value = await dataService.updateCollectible(id.value, { name: normalizedName, notes: notes.value.trim(), tags: tags.value.split(/[,，、;；\n]/).map((tag) => tag.trim()).filter(Boolean), shelfId: shelf.id });
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
onLoad((query) => {
  if (typeof query?.id !== 'string') return void (loadError.value = '收藏详情参数无效');
  id.value = query.id;
  /* 从「全部收藏」的详情卡点「编辑」进来时带 edit=1：直接落在编辑态，
     不用先看一眼只读页再点一次。 */
  if (query?.edit === '1') editing.value = true;
}); onShow(() => void load());
</script>

<template>
  <view class="page detail-page"><view v-if="loadError" class="load-error">{{ loadError }}</view><template v-else-if="item"><view class="art card"><image :src="item.displayImageUrl" mode="aspectFit" /></view>
    <view v-if="!editing" class="content"><text class="eyebrow">PRIVATE OBJECT</text><text class="display-title">{{ item.name }}</text><text class="meta">{{ item.shelfName }} · {{ displayDate }}</text>
      <view class="tags"><text v-for="tag in item.tags" :key="tag"># {{ tag }}</text></view><text v-if="item.notes" class="notes">{{ item.notes }}</text>
      <view class="actions"><button class="primary-button" @tap="editing = true">编辑信息</button><button class="secondary-button danger-button" @tap="remove">删除收藏</button></view>
    </view>
    <view v-else class="edit-form"><text class="section-title">编辑收藏</text><text class="form-label">名称</text><input v-model="name" class="form-input" maxlength="80" /><text class="form-label">展示架</text><picker mode="selector" :range="shelfRange" range-key="name" :value="shelfIndex" @change="onShelfChange"><view class="form-picker">{{ selectedShelf?.name }}</view></picker><text class="form-label">标签</text><input v-model="tags" class="form-input" /><text class="form-label">备注</text><textarea v-model="notes" class="form-textarea" maxlength="2000" /><view class="edit-actions"><button class="secondary-button" @tap="editing = false">取消</button><button class="primary-button" @tap="save">保存</button></view></view></template>
  </view>
</template>

<style scoped>
.art { height: 700rpx; padding: 28rpx; }.art image { width: 100%; height: 100%; }.load-error { padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: 24rpx; }.content { padding: 46rpx 8rpx 0; }.content .display-title { display: block; margin-top: 12rpx; font-size: 58rpx; }.meta { display: block; margin-top: 20rpx; color: #777064; font-size: 24rpx; }.tags { display: flex; flex-wrap: wrap; gap: 12rpx; margin-top: 28rpx; }.tags text { padding: 10rpx 16rpx; border-radius: 999rpx; background: #e6ded2; color: #5e574e; font-size: 22rpx; }.notes { display: block; margin-top: 34rpx; color: #514c45; font-size: 27rpx; line-height: 1.8; white-space: pre-wrap; }.actions { display: grid; gap: 18rpx; margin-top: 48rpx; }.edit-form { padding-top: 48rpx; }.edit-actions { display: grid; grid-template-columns: 1fr 1.4fr; gap: 16rpx; margin-top: 42rpx; }
</style>
