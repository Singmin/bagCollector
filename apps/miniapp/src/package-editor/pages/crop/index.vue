<script setup lang="ts">
import { getCurrentInstance, nextTick, reactive, ref } from 'vue';
import { onLoad, onReady } from '@dcloudio/uni-app';
import { dataService } from '../../../services/data';

type Rotation = 0 | 90 | 180 | 270;
const id = ref(''); const loading = ref(true); const zoomValue = ref(1); const rotation = ref<Rotation>(0); const submitting = ref(false);
const instance = getCurrentInstance();
const state = reactive({
  canvas: null as any, context: null as any, image: null as any,
  canvasWidth: 0, canvasHeight: 0, imageWidth: 0, imageHeight: 0,
  offsetX: 0, offsetY: 0, lastX: 0, lastY: 0
});

function metrics() {
  const frame = { x: 24, y: 46, width: state.canvasWidth - 48, height: state.canvasHeight - 92 };
  const rotatedWidth = rotation.value % 180 === 0 ? state.imageWidth : state.imageHeight;
  const rotatedHeight = rotation.value % 180 === 0 ? state.imageHeight : state.imageWidth;
  const scale = Math.max(frame.width / rotatedWidth, frame.height / rotatedHeight) * zoomValue.value;
  const drawWidth = rotatedWidth * scale; const drawHeight = rotatedHeight * scale;
  const maxX = Math.max(0, (drawWidth - frame.width) / 2); const maxY = Math.max(0, (drawHeight - frame.height) / 2);
  state.offsetX = Math.max(-maxX, Math.min(maxX, state.offsetX)); state.offsetY = Math.max(-maxY, Math.min(maxY, state.offsetY));
  return { frame, scale, drawWidth, drawHeight };
}

function draw() {
  if (!state.context || !state.image) return;
  const ctx = state.context; const { frame, scale } = metrics();
  ctx.clearRect(0, 0, state.canvasWidth, state.canvasHeight); ctx.save();
  ctx.translate(state.canvasWidth / 2 + state.offsetX, state.canvasHeight / 2 + state.offsetY);
  ctx.rotate((rotation.value * Math.PI) / 180);
  ctx.drawImage(state.image, -state.imageWidth * scale / 2, -state.imageHeight * scale / 2, state.imageWidth * scale, state.imageHeight * scale); ctx.restore(); ctx.save();
  ctx.fillStyle = 'rgba(20,18,15,.52)'; ctx.fillRect(0, 0, state.canvasWidth, frame.y); ctx.fillRect(0, frame.y + frame.height, state.canvasWidth, state.canvasHeight - frame.y - frame.height); ctx.fillRect(0, frame.y, frame.x, frame.height); ctx.fillRect(frame.x + frame.width, frame.y, state.canvasWidth - frame.x - frame.width, frame.height);
  ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1.5; ctx.strokeRect(frame.x, frame.y, frame.width, frame.height); ctx.strokeStyle = 'rgba(255,255,255,.38)'; ctx.lineWidth = 1;
  for (let index = 1; index < 3; index += 1) { const x = frame.x + frame.width * index / 3; const y = frame.y + frame.height * index / 3; ctx.beginPath(); ctx.moveTo(x, frame.y); ctx.lineTo(x, frame.y + frame.height); ctx.stroke(); ctx.beginPath(); ctx.moveTo(frame.x, y); ctx.lineTo(frame.x + frame.width, y); ctx.stroke(); }
  ctx.restore();
}

async function prepare() {
  try {
    const item = await dataService.collectible(id.value); if (!item.standardImageUrl) throw new Error('标准图尚未生成');
    await nextTick();
    const query = uni.createSelectorQuery().in(instance?.proxy as any);
    query.select('#cropCanvas').fields({ node: true, size: true }, (field: any) => {
      if (!field?.node) return void uni.showToast({ title: '画布初始化失败', icon: 'none' });
      const dpr = uni.getSystemInfoSync().pixelRatio; const canvas = field.node;
      canvas.width = field.width * dpr; canvas.height = field.height * dpr;
      const context = canvas.getContext('2d'); context.scale(dpr, dpr); const image = canvas.createImage();
      image.onload = () => { Object.assign(state, { canvas, context, image, canvasWidth: field.width, canvasHeight: field.height, imageWidth: image.width, imageHeight: image.height, offsetX: 0, offsetY: 0 }); loading.value = false; draw(); };
      image.onerror = () => uni.showToast({ title: '图片加载失败', icon: 'none' }); image.src = item.standardImageUrl;
    }).exec();
  } catch (error) { uni.showModal({ title: '无法裁剪', content: error instanceof Error ? error.message : '图片加载失败', showCancel: false }); }
}

function touchStart(event: any) { const touch = event.touches?.[0]; if (touch) { state.lastX = touch.clientX; state.lastY = touch.clientY; } }
function touchMove(event: any) { const touch = event.touches?.[0]; if (!touch) return; state.offsetX += touch.clientX - state.lastX; state.offsetY += touch.clientY - state.lastY; state.lastX = touch.clientX; state.lastY = touch.clientY; draw(); }
function zoom(event: any) { zoomValue.value = Number(event.detail.value); draw(); }
function rotate() { rotation.value = ((rotation.value + 90) % 360) as Rotation; state.offsetX = 0; state.offsetY = 0; draw(); }
async function submit() {
  if (submitting.value) return;
  const { frame, drawWidth, drawHeight } = metrics(); const left = state.canvasWidth / 2 + state.offsetX - drawWidth / 2; const top = state.canvasHeight / 2 + state.offsetY - drawHeight / 2;
  submitting.value = true;
  try {
    const result = await dataService.crop(id.value, { x: Math.max(0, (frame.x - left) / drawWidth), y: Math.max(0, (frame.y - top) / drawHeight), width: Math.min(1, frame.width / drawWidth), height: Math.min(1, frame.height / drawHeight), rotation: rotation.value });
    uni.redirectTo({ url: `/package-editor/pages/processing/index?id=${id.value}&jobId=${result.jobId}&stage=matting` });
  } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' }); submitting.value = false; }
}
onLoad((query) => { id.value = String(query?.id || ''); }); onReady(() => void prepare());
</script>

<template>
  <view class="crop-page"><view class="crop-header"><text class="eyebrow">NEW OBJECT · 2 / 4</text><text class="title">裁剪与旋转</text><text>拖动图片调整位置，用滑杆缩放。</text></view>
    <view class="canvas-shell"><canvas id="cropCanvas" canvas-id="cropCanvas" type="2d" class="crop-canvas" disable-scroll @touchstart.stop.prevent="touchStart" @touchmove.stop.prevent="touchMove" /></view>
    <view class="controls"><button class="rotate" @tap="rotate">↻ 旋转 90°</button><view class="zoom"><text>缩放</text><slider min="1" max="3" step="0.01" :value="zoomValue" active-color="#211f1c" :block-size="20" @changing="zoom" @change="zoom" /></view></view>
    <button class="primary-button" :disabled="loading || submitting" @tap="submit">{{ submitting ? '正在提交…' : '开始自动抠图' }}</button>
  </view>
</template>

<style scoped>
.crop-page { min-height: 100vh; padding: calc(env(safe-area-inset-top) + 24rpx) 28rpx calc(env(safe-area-inset-bottom) + 30rpx); background: #191715; color: #fffdf8; }.crop-header { margin-bottom: 24rpx; }.crop-header .eyebrow { color: #a9a197; }.title { display: block; margin: 8rpx 0 10rpx; font-family: Georgia,"Songti SC",serif; font-size: 46rpx; }.crop-header>text:last-child { color: #b9b1a7; font-size: 23rpx; }.canvas-shell { height: 920rpx; border-radius: 26rpx; background: #0e0d0c; overflow: hidden; }.crop-canvas { width: 100%; height: 100%; }.controls { display: grid; grid-template-columns: 210rpx 1fr; gap: 22rpx; align-items: center; margin: 25rpx 0; }.rotate { height: 70rpx; margin: 0; padding: 0 14rpx; border: 1rpx solid #5a544d; border-radius: 999rpx; background: #292622; color: #fff; font-size: 23rpx; }.zoom { display: grid; grid-template-columns: 62rpx 1fr; align-items: center; color: #c7bfb5; font-size: 22rpx; }.zoom slider { margin: 0; }.primary-button { background: #fffdf8; color: #211f1c; }
</style>
