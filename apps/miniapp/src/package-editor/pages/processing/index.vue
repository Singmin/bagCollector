<script setup lang="ts">
import { ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import type { Collectible } from '../../../types';
import { dataService } from '../../../services/data';

const id = ref(''); const stage = ref<'normalize' | 'crop' | 'matting' | ''>(''); const item = ref<Collectible | null>(null);
const elapsed = ref(0); const failureMessage = ref(''); const deleting = ref(false); const retrying = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let startedAt = 0;

// 轮询间隔决定用户看到状态变化的滞后，1 秒兼顾响应速度和服务端压力。
const POLL_INTERVAL_MS = 1_000;

async function poll() {
  try {
    item.value = await dataService.collectible(id.value);
    // 用真实时间戳计算等待时长：轮询本身有耗时，按次数累加会低估实际等待。
    elapsed.value = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    if (item.value.processingStatus === 'AWAITING_CROP') {
      /* 抠图改为用户可选（2026-09-29）：规范化完成后直接进编辑页，
         由编辑页的「自动抠图」按钮手动触发，不再自动全幅 crop。 */
      return void uni.redirectTo({ url: `/package-editor/pages/metadata/index?id=${item.value.id}` });
    }
    if (item.value.processingStatus === 'READY') return void uni.redirectTo({ url: `/package-editor/pages/metadata/index?id=${item.value.id}` });
    if (item.value.processingStatus === 'FAILED') {
      failureMessage.value = item.value.processingError || '服务未返回图片处理失败原因';
      return;
    }
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  } catch (error) {
    failureMessage.value = error instanceof Error ? error.message : '图片处理状态查询失败';
  }
}

async function deleteAndExit() {
  if (deleting.value) return;
  deleting.value = true;
  try {
    await dataService.removeCollectible(id.value);
    uni.reLaunch({ url: '/pages/showcase/index' });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '删除失败', icon: 'none' });
    deleting.value = false;
  }
}
/* 失败重试：裁剪（免费）或抠图用各自端点重跑一次，沿用已保存的裁剪参数（抠图可省参） */
async function retry() {
  if (retrying.value) return;
  retrying.value = true;
  try {
    if (stage.value === 'matting') await dataService.matte(id.value);
    else if (stage.value === 'crop') await dataService.crop(id.value, item.value?.crop ?? { x: 0, y: 0, width: 1, height: 1, rotation: 0 });
    else await dataService.crop(id.value, item.value?.crop ?? { x: 0, y: 0, width: 1, height: 1, rotation: 0 });
    failureMessage.value = ''; elapsed.value = 0; startedAt = Date.now();
    void poll();
  } catch (error) {
    failureMessage.value = error instanceof Error ? error.message : '重试失败';
    retrying.value = false;
  }
}
/* 返回编辑：失败态也能回编辑页（那里仍可重试或放弃），避免只能删除的死路 */
function backToEdit() {
  uni.redirectTo({ url: `/package-editor/pages/metadata/index?id=${id.value}` });
}
onLoad((query) => {
  if (typeof query?.id !== 'string' || (query.stage !== 'normalize' && query.stage !== 'crop' && query.stage !== 'matting')) {
    failureMessage.value = '图片处理页面参数无效';
    return;
  }
  id.value = query.id;
  stage.value = query.stage;
  startedAt = Date.now();
  void poll();
});
onUnload(() => { if (timer) clearTimeout(timer); });
</script>

<template>
  <view class="page processing-page"><view class="processing-card card">
    <view v-if="!failureMessage" class="spinner"><view /><view /><view /></view><view v-else class="failed-mark">!</view>
    <text class="eyebrow">AUTO CUTOUT</text><text class="title">{{ failureMessage ? '图片处理失败' : stage === 'normalize' ? '正在准备照片' : stage === 'crop' ? '正在裁剪照片' : '正在自动抠图' }}</text>
    <text class="description">{{ failureMessage || (stage === 'crop' ? '裁剪完成后将回到信息填写，可再选择是否抠图。' : '抠图结束后，将自动进入信息与分类填写。') }}</text>
    <text v-if="!failureMessage" class="elapsed">已等待 {{ elapsed }} 秒</text>
    <view v-else class="actions">
      <button class="primary-button" :disabled="retrying || !id" @tap="retry">{{ retrying ? '正在重试…' : '重试' }}</button>
      <button class="secondary-button" :disabled="retrying" @tap="backToEdit">返回编辑</button>
      <button class="ghost-button" :disabled="deleting || retrying || !id" @tap="deleteAndExit">{{ deleting ? '正在删除…' : '删除这次记录' }}</button>
    </view>
  </view></view>
</template>

<style scoped>
.processing-page { display: grid; place-items: center; padding-bottom: calc(env(safe-area-inset-bottom) + 40rpx); }.processing-card { width: 100%; padding: 80rpx 44rpx; display: flex; flex-direction: column; align-items: center; text-align: center; }.spinner { width: 138rpx; height: 138rpx; position: relative; margin-bottom: 45rpx; animation: spin 2.8s linear infinite; }.spinner view { position: absolute; inset: 0; border: 2rpx solid #978c7d; border-radius: 48% 52% 44% 56%; }.spinner view:nth-child(2) { inset: 18rpx; transform: rotate(31deg); }.spinner view:nth-child(3) { inset: 38rpx; transform: rotate(68deg); }.failed-mark { width: 122rpx; height: 122rpx; display: grid; place-items: center; margin-bottom: 44rpx; border: 2rpx solid #aa4d44; border-radius: 50%; color: #9d3d36; font: 54rpx Georgia,serif; }.title { margin-top: 14rpx; font-family: Georgia,"Songti SC",serif; font-size: 42rpx; font-weight: 600; }.description { max-width: 530rpx; margin-top: 20rpx; color: #777064; font-size: 25rpx; line-height: 1.7; }.elapsed { margin-top: 26rpx; color: #9a9185; font-size: 21rpx; }.actions { width: 100%; display: grid; gap: 18rpx; margin-top: 42rpx; }.secondary-button { width: 100%; height: 88rpx; border: 2rpx solid rgba(20,20,20,.16); border-radius: 44rpx; background: transparent; color: #141414; font-size: var(--wc-font-description); font-weight: 650; }.ghost-button { width: 100%; height: 80rpx; background: transparent; color: #9d3d36; font-size: 24rpx; }.ghost-button[disabled] { opacity: .5; }@keyframes spin { to { transform: rotate(360deg); } }
</style>
