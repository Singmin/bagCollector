<script setup lang="ts">
import { ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import type { Collectible } from '../../../types';
import { dataService } from '../../../services/data';

const id = ref(''); const stage = ref('normalize'); const item = ref<Collectible | null>(null);
const elapsed = ref(0); const retrying = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function poll() {
  try {
    item.value = await dataService.collectible(id.value); elapsed.value += 2;
    if (item.value.processingStatus === 'AWAITING_CROP') return void uni.redirectTo({ url: `/package-editor/pages/crop/index?id=${item.value.id}` });
    if (item.value.processingStatus === 'READY') return void uni.redirectTo({ url: `/package-editor/pages/metadata/index?id=${item.value.id}` });
    if (item.value.processingStatus === 'FAILED') return;
    timer = setTimeout(() => void poll(), 2000);
  } catch { timer = setTimeout(() => void poll(), 3000); }
}

async function retry() {
  retrying.value = true;
  try { await dataService.retry(id.value); item.value = null; elapsed.value = 0; void poll(); }
  catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '重试失败', icon: 'none' }); }
  finally { retrying.value = false; }
}
async function keepCrop() {
  try { await dataService.keepCrop(id.value); uni.redirectTo({ url: `/package-editor/pages/metadata/index?id=${id.value}` }); }
  catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '暂时无法保留裁剪图', icon: 'none' }); }
}
async function replace() {
  try { await dataService.removeCollectible(id.value); uni.redirectTo({ url: '/package-editor/pages/add/index' }); }
  catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '暂时无法更换图片', icon: 'none' }); }
}
onLoad((query) => { id.value = String(query?.id || ''); stage.value = String(query?.stage || 'normalize'); void poll(); });
onUnload(() => { if (timer) clearTimeout(timer); });
</script>

<template>
  <view class="page processing-page"><view class="processing-card card">
    <view v-if="item?.processingStatus !== 'FAILED'" class="spinner"><view /><view /><view /></view><view v-else class="failed-mark">!</view>
    <text class="eyebrow">NEW OBJECT · 3 / 4</text><text class="title">{{ item?.processingStatus === 'FAILED' ? '图片处理遇到问题' : stage === 'normalize' ? '正在准备高清工作图' : '正在分离收藏主体' }}</text>
    <text class="description">{{ item?.processingStatus === 'FAILED' ? item.processingError || '可以重试，或先保留裁剪后的图片。' : '可以暂时把手机放在一边，处理时间会根据图片复杂度变化。' }}</text>
    <text v-if="item?.processingStatus !== 'FAILED'" class="elapsed">已等待 {{ elapsed }} 秒</text>
    <view v-else-if="stage === 'normalize'" class="actions"><button class="primary-button" @tap="replace">重新选择图片</button></view>
    <view v-else class="actions"><button class="primary-button" :disabled="retrying" @tap="retry">{{ retrying ? '正在重试…' : '重试自动抠图' }}</button><button class="secondary-button" @tap="keepCrop">保留裁剪图</button></view>
  </view></view>
</template>

<style scoped>
.processing-page { display: grid; place-items: center; padding-bottom: calc(env(safe-area-inset-bottom) + 40rpx); }.processing-card { width: 100%; padding: 80rpx 44rpx; display: flex; flex-direction: column; align-items: center; text-align: center; }.spinner { width: 138rpx; height: 138rpx; position: relative; margin-bottom: 45rpx; animation: spin 2.8s linear infinite; }.spinner view { position: absolute; inset: 0; border: 2rpx solid #978c7d; border-radius: 48% 52% 44% 56%; }.spinner view:nth-child(2) { inset: 18rpx; transform: rotate(31deg); }.spinner view:nth-child(3) { inset: 38rpx; transform: rotate(68deg); }.failed-mark { width: 122rpx; height: 122rpx; display: grid; place-items: center; margin-bottom: 44rpx; border: 2rpx solid #aa4d44; border-radius: 50%; color: #9d3d36; font: 54rpx Georgia,serif; }.title { margin-top: 14rpx; font-family: Georgia,"Songti SC",serif; font-size: 42rpx; font-weight: 600; }.description { max-width: 530rpx; margin-top: 20rpx; color: #777064; font-size: 25rpx; line-height: 1.7; }.elapsed { margin-top: 26rpx; color: #9a9185; font-size: 21rpx; }.actions { width: 100%; display: grid; gap: 18rpx; margin-top: 42rpx; }@keyframes spin { to { transform: rotate(360deg); } }
</style>
