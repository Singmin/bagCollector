<script setup lang="ts">
import { ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import type { Collectible } from '../../../types';
import { dataService } from '../../../services/data';

const id = ref(''); const stage = ref<'normalize' | 'matting' | ''>(''); const item = ref<Collectible | null>(null);
const elapsed = ref(0); const failureMessage = ref(''); const deleting = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let startingMatting = false;
let startedAt = 0;

// 轮询间隔决定用户看到状态变化的滞后，1 秒兼顾响应速度和服务端压力。
const POLL_INTERVAL_MS = 1_000;
// 刚提交完裁剪，任务马上就会动，这里不用等满一个轮询周期。
const POST_CROP_DELAY_MS = 600;

async function poll() {
  try {
    item.value = await dataService.collectible(id.value);
    // 用真实时间戳计算等待时长：轮询本身有耗时，按次数累加会低估实际等待。
    elapsed.value = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    if (item.value.processingStatus === 'AWAITING_CROP') {
      if (startingMatting) return;
      startingMatting = true;
      stage.value = 'matting';
      try {
        await dataService.crop(item.value.id, { x: 0, y: 0, width: 1, height: 1, rotation: 0 });
        timer = setTimeout(() => void poll(), POST_CROP_DELAY_MS);
      } catch (error) {
        failureMessage.value = error instanceof Error ? error.message : '自动抠图启动失败';
      }
      return;
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
onLoad((query) => {
  if (typeof query?.id !== 'string' || (query.stage !== 'normalize' && query.stage !== 'matting')) {
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
    <text class="eyebrow">AUTO CUTOUT</text><text class="title">{{ failureMessage ? '图片处理失败' : stage === 'normalize' ? '正在准备照片' : '正在自动抠图' }}</text>
    <text class="description">{{ failureMessage || '抠图结束后，将自动进入信息与分类填写。' }}</text>
    <text v-if="!failureMessage" class="elapsed">已等待 {{ elapsed }} 秒</text>
    <view v-else class="actions"><button class="primary-button" :disabled="deleting || !id" @tap="deleteAndExit">{{ deleting ? '正在删除…' : '删除这次记录并退出' }}</button></view>
  </view></view>
</template>

<style scoped>
.processing-page { display: grid; place-items: center; padding-bottom: calc(env(safe-area-inset-bottom) + 40rpx); }.processing-card { width: 100%; padding: 80rpx 44rpx; display: flex; flex-direction: column; align-items: center; text-align: center; }.spinner { width: 138rpx; height: 138rpx; position: relative; margin-bottom: 45rpx; animation: spin 2.8s linear infinite; }.spinner view { position: absolute; inset: 0; border: 2rpx solid #978c7d; border-radius: 48% 52% 44% 56%; }.spinner view:nth-child(2) { inset: 18rpx; transform: rotate(31deg); }.spinner view:nth-child(3) { inset: 38rpx; transform: rotate(68deg); }.failed-mark { width: 122rpx; height: 122rpx; display: grid; place-items: center; margin-bottom: 44rpx; border: 2rpx solid #aa4d44; border-radius: 50%; color: #9d3d36; font: 54rpx Georgia,serif; }.title { margin-top: 14rpx; font-family: Georgia,"Songti SC",serif; font-size: 42rpx; font-weight: 600; }.description { max-width: 530rpx; margin-top: 20rpx; color: #777064; font-size: 25rpx; line-height: 1.7; }.elapsed { margin-top: 26rpx; color: #9a9185; font-size: 21rpx; }.actions { width: 100%; display: grid; gap: 18rpx; margin-top: 42rpx; }@keyframes spin { to { transform: rotate(360deg); } }
</style>
