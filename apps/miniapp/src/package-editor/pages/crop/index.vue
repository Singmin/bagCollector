<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, reactive, ref } from 'vue';
import { onLoad, onReady } from '@dcloudio/uni-app';
import { dataService } from '../../../services/data';

type Rotation = 0 | 90 | 180 | 270;
/* 展示比例：挂袋卡照片区 ≈0.67、宫格卡 ≈0.71，收敛为 3:4 ——
   裁出来的图在 App 各展示位（均为 aspectFit）留白一致，观感统一 */
const DISPLAY_RATIO = 3 / 4;
/* 可选裁剪比例：默认 3:4（展示收敛值），另有 2:3 与原图（不锁比例，取景框铺满画布） */
type RatioKey = 'r34' | 'r23' | 'free';
const RATIOS: Record<RatioKey, number | null> = { r34: DISPLAY_RATIO, r23: 2 / 3, free: null };
const ratioKey = ref<RatioKey>('r34');
function selectRatio(key: RatioKey) { ratioKey.value = key; draw(); }
/* P1：90° 粗旋转 + 微调角度滑杆（±20°，0.5° 步进），两者相加为最终角度 */
const fineAngle = ref(0);
const totalAngle = computed(() => rotation.value + fineAngle.value);
function onAngle(event: any) { fineAngle.value = Number(event.detail.value ?? event.detail); draw(); }
/* P2：调色（预览用 canvas filter，最终由服务端 sharp 落盘，缺省 1 = 不调整） */
const brightness = ref(1); const contrast = ref(1); const saturation = ref(1);
function onColor(key: 'brightness' | 'contrast' | 'saturation', event: any) {
  const value = Number(event.detail.value ?? event.detail);
  if (key === 'brightness') brightness.value = value;
  else if (key === 'contrast') contrast.value = value;
  else saturation.value = value;
  draw();
}
const id = ref(''); const loading = ref(true); const zoomValue = ref(1); const rotation = ref<Rotation>(0); const submitting = ref(false);
/* 该图是否已抠过图：已抠图时「同时抠图」开关失效（/matte 会 409），本次提交改走 /crop，
   worker 据 rematte 重新抠图，保证透明图与新裁剪构图对齐 */
const matted = ref(false);
/* 是否在本次提交里连同抠图一起做：勾选则直接走 /matte（抠图任务本身包含裁剪），
   省掉「回编辑页再点抠图 → 再等一次处理页」的往返；默认不勾，抠图按次计费 */
const matteAlong = ref(false);
function onMatteAlong(event: any) { matteAlong.value = !!event.detail.value; }
/* 真正走抠图流水线当且仅当用户勾选且本图尚未抠过；否则一律 /crop（已抠图则顺带重抠） */
const useMatte = computed(() => matteAlong.value && !matted.value);
const loadError = ref('');
const instance = getCurrentInstance();
const state = reactive({
  canvas: null as any, context: null as any, image: null as any,
  canvasWidth: 0, canvasHeight: 0, imageWidth: 0, imageHeight: 0,
  offsetX: 0, offsetY: 0, lastX: 0, lastY: 0
});

/* 取景框：画布内「满足展示比例的最大矩形」，居中（不再随屏幕比例随意变化） */
function frameRect() {
  const ratio = RATIOS[ratioKey.value];
  /* 原图：不锁比例，取景框铺满画布（沿用旧行为） */
  if (ratio === null) return { x: 24, y: 46, width: state.canvasWidth - 48, height: state.canvasHeight - 92 };
  const padX = 24; const padY = 24;
  const maxWidth = state.canvasWidth - padX * 2;
  const maxHeight = state.canvasHeight - padY * 2;
  let width = maxWidth; let height = width / ratio;
  if (height > maxHeight) { height = maxHeight; width = height * ratio; }
  return { x: (state.canvasWidth - width) / 2, y: (state.canvasHeight - height) / 2, width, height };
}

function metrics() {
  const frame = frameRect();
  /* 任意角度下的外接矩形（P1 自由角度）：用于 cover 缩放与夹紧范围 */
  const rad = (totalAngle.value * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)); const sin = Math.abs(Math.sin(rad));
  const rotatedWidth = state.imageWidth * cos + state.imageHeight * sin;
  const rotatedHeight = state.imageWidth * sin + state.imageHeight * cos;
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
  ctx.rotate((totalAngle.value * Math.PI) / 180);
  /* 调色预览：canvas 2d 支持 filter 时用它（与服务端 sharp 同顺序），不支持则退化为无色预览 */
  const supportsFilter = 'filter' in ctx;
  if (supportsFilter) ctx.filter = `brightness(${brightness.value}) contrast(${contrast.value}) saturate(${saturation.value})`;
  ctx.drawImage(state.image, -state.imageWidth * scale / 2, -state.imageHeight * scale / 2, state.imageWidth * scale, state.imageHeight * scale);
  if (supportsFilter) ctx.filter = 'none';
  ctx.restore();
  ctx.save();
  ctx.fillStyle = 'rgba(20,18,15,.52)'; ctx.fillRect(0, 0, state.canvasWidth, frame.y); ctx.fillRect(0, frame.y + frame.height, state.canvasWidth, state.canvasHeight - frame.y - frame.height); ctx.fillRect(0, frame.y, frame.x, frame.height); ctx.fillRect(frame.x + frame.width, frame.y, state.canvasWidth - frame.x - frame.width, frame.height);
  ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1.5; ctx.strokeRect(frame.x, frame.y, frame.width, frame.height); ctx.strokeStyle = 'rgba(255,255,255,.38)'; ctx.lineWidth = 1;
  for (let index = 1; index < 3; index += 1) { const x = frame.x + frame.width * index / 3; const y = frame.y + frame.height * index / 3; ctx.beginPath(); ctx.moveTo(x, frame.y); ctx.lineTo(x, frame.y + frame.height); ctx.stroke(); ctx.beginPath(); ctx.moveTo(frame.x, y); ctx.lineTo(frame.x + frame.width, y); ctx.stroke(); }
  ctx.restore();
}

async function prepare() {
  try {
    const item = await dataService.collectible(id.value); if (!item.standardImageUrl) throw new Error('标准图尚未生成');
    matted.value = !!item.cutoutImageUrl;
    await nextTick();
    const query = uni.createSelectorQuery().in(instance?.proxy as any);
    query.select('#cropCanvas').fields({ node: true, size: true }, (field: any) => {
      if (!field?.node) return void (loadError.value = '画布初始化失败');
      const dpr = uni.getSystemInfoSync().pixelRatio; const canvas = field.node;
      canvas.width = field.width * dpr; canvas.height = field.height * dpr;
      const context = canvas.getContext('2d'); context.scale(dpr, dpr); const image = canvas.createImage();
      image.onload = () => { Object.assign(state, { canvas, context, image, canvasWidth: field.width, canvasHeight: field.height, imageWidth: image.width, imageHeight: image.height, offsetX: 0, offsetY: 0 }); loading.value = false; draw(); };
      image.onerror = () => { loadError.value = '标准图加载失败'; }; image.src = item.standardImageUrl;
    }).exec();
  } catch (error) { loadError.value = error instanceof Error ? error.message : '图片加载失败'; }
}

/* 手势：单指拖动 + 双指捏合缩放。双指全程以第一帧的双触点距离为基准，
   松开任意一指即结束捏合（回到单指拖动），避免跳变 */
let pinchBase: { distance: number; zoom: number } | null = null;
function touchDistance(a: any, b: any) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
function touchStart(event: any) {
  const touches = event.touches ?? [];
  if (touches.length >= 2) {
    pinchBase = { distance: touchDistance(touches[0], touches[1]), zoom: zoomValue.value };
    return;
  }
  const touch = touches[0]; if (touch) { state.lastX = touch.clientX; state.lastY = touch.clientY; }
}
function touchMove(event: any) {
  const touches = event.touches ?? [];
  if (touches.length >= 2 && pinchBase) {
    const distance = touchDistance(touches[0], touches[1]);
    zoomValue.value = Math.max(1, Math.min(3, (pinchBase.zoom * distance) / pinchBase.distance));
    draw();
    return;
  }
  const touch = touches[0]; if (!touch) return; state.offsetX += touch.clientX - state.lastX; state.offsetY += touch.clientY - state.lastY; state.lastX = touch.clientX; state.lastY = touch.clientY; draw();
}
function touchEnd(event: any) {
  if ((event.touches ?? []).length < 2) pinchBase = null;
}

function zoom(event: any) { zoomValue.value = Number(event.detail.value); draw(); }
function rotate() { rotation.value = ((rotation.value + 90) % 360) as Rotation; state.offsetX = 0; state.offsetY = 0; draw(); }
/* 重置：清空全部调整（比例回默认 3:4、缩放/角度/位移/调色回初值） */
function resetAdjust() {
  ratioKey.value = 'r34'; zoomValue.value = 1; rotation.value = 0; fineAngle.value = 0;
  state.offsetX = 0; state.offsetY = 0;
  brightness.value = 1; contrast.value = 1; saturation.value = 1;
  draw();
}
async function submit() {
  if (submitting.value) return;
  /* 主按钮不用 disabled（微信内置 wx-button[disabled] 样式会盖掉黑底），改为点击时校验并提示 */
  if (loadError.value) return void uni.showToast({ title: loadError.value, icon: 'none' });
  if (loading.value) return void uni.showToast({ title: '图片加载中，请稍候', icon: 'none' });
  /* 裁剪参数按当前画布状态实时计算：取景框相对「绘制图」的位置与占比（归一化 0~1） */
  const { frame, drawWidth, drawHeight } = metrics();
  const left = state.canvasWidth / 2 + state.offsetX - drawWidth / 2;
  const top = state.canvasHeight / 2 + state.offsetY - drawHeight / 2;
  const payload = {
    x: Math.max(0, (frame.x - left) / drawWidth),
    y: Math.max(0, (frame.y - top) / drawHeight),
    width: Math.min(1, frame.width / drawWidth),
    height: Math.min(1, frame.height / drawHeight),
    /* P1：任意角度（90° 粗旋 + 微调，保留一位小数） */
    rotation: Math.round(totalAngle.value * 10) / 10,
    brightness: Math.round(brightness.value * 100) / 100,
    contrast: Math.round(contrast.value * 100) / 100,
    saturation: Math.round(saturation.value * 100) / 100
  };
  submitting.value = true;
  try {
    /* 勾了「同时抠图」且本图未抠过才走 /matte，否则一律 /crop（已抠图则顺带重抠） */
    const willMatte = useMatte.value;
    const result = willMatte
      ? await dataService.matte(id.value, payload)
      : await dataService.crop(id.value, payload);
    uni.redirectTo({
      url: `/package-editor/pages/processing/index?id=${id.value}&jobId=${result.jobId}&stage=${willMatte ? 'matting' : 'crop'}`
    });
  } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '提交失败', icon: 'none' }); submitting.value = false; }
}
/* 取消 = 放弃本次调整返回上一页（不提交任何参数） */
function goBack() { uni.navigateBack({ delta: 1 }); }
onLoad((query) => {
  if (typeof query?.id !== 'string') {
    loadError.value = '裁剪页面参数无效';
    return;
  }
  id.value = query.id;
}); onReady(() => { if (id.value) void prepare(); });
</script>

<template>
  <view class="crop-page">
    <nav-bar title="裁剪旋转" back />
    <text class="hint">拖动调整位置 · 双指捏合缩放 · 滑杆微调</text>
    <view v-if="loadError" class="load-error">{{ loadError }}</view>
    <view v-else class="canvas-shell"><canvas id="cropCanvas" canvas-id="cropCanvas" type="2d" class="crop-canvas" disable-scroll @touchstart.stop.prevent="touchStart" @touchmove.stop.prevent="touchMove" @touchend.stop.prevent="touchEnd" @touchcancel.stop.prevent="touchEnd" /></view>
    <!-- 比例与旋转同一行：主流修图 App 式工具条（图标在上 · 文字在下，无胶囊底，选中文字变品牌红） -->
    <view class="tools-row">
      <view class="tool" :class="{ 'is-active': ratioKey === 'r34' }" hover-class="is-pressed" :hover-stay-time="80" @tap="selectRatio('r34')">
        <image class="tool__icon" src="/static/figma/ratio-34.svg" mode="aspectFit" />
        <text class="tool__label">3:4</text>
      </view>
      <view class="tool" :class="{ 'is-active': ratioKey === 'r23' }" hover-class="is-pressed" :hover-stay-time="80" @tap="selectRatio('r23')">
        <image class="tool__icon" src="/static/figma/ratio-23.svg" mode="aspectFit" />
        <text class="tool__label">2:3</text>
      </view>
      <view class="tool" :class="{ 'is-active': ratioKey === 'free' }" hover-class="is-pressed" :hover-stay-time="80" @tap="selectRatio('free')">
        <image class="tool__icon" src="/static/figma/ratio-free.svg" mode="aspectFit" />
        <text class="tool__label">原图</text>
      </view>
      <view class="tool" hover-class="is-pressed" :hover-stay-time="80" @tap="rotate">
        <image class="tool__icon" src="/static/figma/rotate-cw.svg" mode="aspectFit" />
        <text class="tool__label">旋转 90°</text>
      </view>
      <view class="tool" hover-class="is-pressed" :hover-stay-time="80" @tap="resetAdjust">
        <image class="tool__icon" src="/static/figma/rotate-ccw.svg" mode="aspectFit" />
        <text class="tool__label">重置</text>
      </view>
    </view>
    <!-- 微调角度与缩放滑杆（旋转 90° / 重置已并入上方工具行） -->
    <view class="group">
      <view class="slider-row">
        <text class="slider-row__key">角度</text>
        <slider class="slider-row__slider" min="-20" max="20" step="0.5" :value="fineAngle" active-color="#141414" background-color="rgba(20,20,20,.13)" :block-size="20" @changing="onAngle" @change="onAngle" />
        <text class="slider-row__val">{{ fineAngle.toFixed(1) }}°</text>
      </view>
      <view class="slider-row">
        <text class="slider-row__key">缩放</text>
        <slider class="slider-row__slider" min="1" max="3" step="0.01" :value="zoomValue" active-color="#141414" background-color="rgba(20,20,20,.13)" :block-size="20" @changing="zoom" @change="zoom" />
        <text class="slider-row__val">{{ zoomValue.toFixed(2) }}×</text>
      </view>
    </view>
    <!-- 调色：两种模式共用（预览即时，落盘由服务端 sharp 处理）；左侧标签自带语义，不再加组标题 -->
    <view class="group">
      <view class="slider-row">
        <text class="slider-row__key">亮度</text>
        <slider class="slider-row__slider" min="0.7" max="1.3" step="0.01" :value="brightness" active-color="#141414" background-color="rgba(20,20,20,.13)" :block-size="20" @changing="onColor('brightness', $event)" @change="onColor('brightness', $event)" />
        <text class="slider-row__val">{{ brightness.toFixed(2) }}</text>
      </view>
      <view class="slider-row">
        <text class="slider-row__key">对比度</text>
        <slider class="slider-row__slider" min="0.8" max="1.2" step="0.01" :value="contrast" active-color="#141414" background-color="rgba(20,20,20,.13)" :block-size="20" @changing="onColor('contrast', $event)" @change="onColor('contrast', $event)" />
        <text class="slider-row__val">{{ contrast.toFixed(2) }}</text>
      </view>
      <view class="slider-row">
        <text class="slider-row__key">饱和度</text>
        <slider class="slider-row__slider" min="0.5" max="1.5" step="0.01" :value="saturation" active-color="#141414" background-color="rgba(20,20,20,.13)" :block-size="20" @changing="onColor('saturation', $event)" @change="onColor('saturation', $event)" />
        <text class="slider-row__val">{{ saturation.toFixed(2) }}</text>
      </view>
    </view>
    <!-- 抠图：未抠图给开关（勾选则一次提交跑完「裁剪 + 抠图」，省一次往返）；
         已抠图改为弱提示（本次会按当前构图重新生成抠图，不重复扣费） -->
    <view v-if="!matted" class="matte-row">
      <view class="matte-row__text">
        <text class="matte-row__title">同时自动抠图</text>
        <text class="matte-row__hint">每张图片仅一次，抠图后还能重新裁剪</text>
      </view>
      <switch :checked="matteAlong" color="#141414" @change="onMatteAlong" />
    </view>
    <view v-else-if="matted" class="matte-row matte-row--note">
      <text class="matte-row__hint">已自动抠图，本次会按新构图重新生成抠图</text>
    </view>
    <!-- 底部确认条：主流修图 App 式 左 ✕ 取消 / 右 ✓ 应用（圆形轻量钮，替代原大胶囊）；
         忙态用 is-busy 表达（submit 内已有 submitting 防重入） -->
    <view class="bottom-bar">
      <view class="confirm-row">
        <view class="confirm-btn" hover-class="is-pressed" :hover-stay-time="80" @tap="goBack"><text class="confirm-btn__x">✕</text></view>
        <view class="confirm-btn confirm-btn--ok" :class="{ 'is-busy': submitting }" hover-class="is-pressed" :hover-stay-time="80" @tap="submit"><text class="confirm-btn__ok">✓</text></view>
      </view>
    </view>
  </view>
</template>

<style scoped>
/* 页面接 nav-bar 组件（与「完善信息」页同骨架：清零四周内边距，内容块自带边距，
   底部预埋 200rpx 避让固定确认条）。画布不再铺深底，图片直接坐在页面浅底上 */
.crop-page { min-height: 100vh; padding: 0 0 200rpx; background: #f2f3f7; color: #141414; }
/* 弱提示统一占位色 #b3afa8、字号走 token（原 23rpx 硬编码与全站 --wc-font-footnote 不一致） */
.hint { display: block; padding: 4rpx 40rpx 18rpx; color: #b3afa8; font-size: var(--wc-font-footnote); }
.load-error { margin: 10rpx 30rpx 0; padding: 28rpx 30rpx; border-radius: 32rpx; background: #fae2de; color: #943d37; font-size: var(--wc-font-footnote); }
/* 画布容器：不再铺深底（黑底观感重、与全站浅底冲突）—— 取景框外的压暗交给 canvas 内绘制的
   半透明遮罩（与系统相册裁剪同观感）。去掉底色后圆角失去视觉边界，这里补回纸感卡片外观
   （白底 + 细边框 + 柔影，取值与全站 .card 一致），让「编辑区域」成为一张明确的圆角卡；
   canvas 本身也加圆角，使内容（图片与遮罩）按圆角裁剪。高度随屏伸缩，避免矮屏挤掉确认条 */
.canvas-shell { margin: 0 30rpx; height: 56vh; min-height: 460rpx; max-height: 800rpx; border: 1rpx solid rgba(55,47,37,.12); border-radius: 32rpx; background: #fffdf8; box-shadow: 0 20rpx 50rpx rgba(51,42,29,.07); overflow: hidden; }
.crop-canvas { width: 100%; height: 100%; border-radius: 30rpx; }
/* 分组容器：仅提供左右边距（组标题已去掉，语义交给滑杆左侧标签） */
.group { margin: 0 40rpx; padding: 6rpx 0 8rpx; }
/* 工具行：比例（3:4 / 2:3 / 原图）与旋转（旋转 90° / 重置）同排一行、等宽均分；
   主流修图 App 式 —— 图标在上、文字在下，无胶囊底；选中项文字变品牌红 */
.tools-row { display: flex; align-items: flex-start; margin: 26rpx 20rpx 4rpx; }
.tool { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 8rpx; padding: 8rpx 4rpx; }
.tool__icon { width: 48rpx; height: 48rpx; }
.tool__label { color: #57514a; font-size: 21rpx; line-height: 1.2; white-space: nowrap; }
.tool.is-active .tool__label { color: #c50405; font-weight: 700; }
.tool.is-pressed { transform: scale(.9); }
/* 滑杆行：标签 / 滑杆 / 数值 三列（数值替代原生 show-value 气泡，气泡与纸感体系不搭）；
   轨道底色取 .ef-input 底线同值 rgba(20,20,20,.13)，block-size 统一 20（原 18/20 混用） */
.slider-row { display: grid; grid-template-columns: 100rpx 1fr 78rpx; gap: 14rpx; align-items: center; padding: 12rpx 0; }
.slider-row__key { color: #77736d; font-size: var(--wc-font-footnote); font-weight: 700; letter-spacing: .8rpx; }
.slider-row__slider { margin: 0; }
.slider-row__val { color: #a8a49d; font-size: 21rpx; text-align: right; font-variant-numeric: tabular-nums; }
/* 抠图行：ef 行版式（左标题 + 右开关），去掉原白底卡片（与「完善信息」页"无白卡"一致） */
.matte-row { display: flex; align-items: center; justify-content: space-between; gap: 22rpx; margin: 0 40rpx; padding: 26rpx 0 8rpx; }
.matte-row__text { display: flex; flex-direction: column; gap: 6rpx; }
.matte-row__title { color: #141414; font-size: var(--wc-font-description); font-weight: 650; }
.matte-row__hint { color: #a8a49d; font-size: 21rpx; }
.matte-row--note { display: block; padding: 8rpx 0 0; }
/* 底部确认条：固定视口底部（含安全区），补页面同色底避免长内容从条下穿透。
   参照主流修图 App —— 左 ✕ 取消 / 右 ✓ 应用，圆形轻量钮取代原 87rpx 大胶囊 */
.bottom-bar { position: fixed; z-index: 20; left: 0; right: 0; bottom: 0; padding: 12rpx 44rpx calc(env(safe-area-inset-bottom) + 12rpx); background: #f2f3f7; }
.confirm-row { display: flex; align-items: center; justify-content: space-between; }
.confirm-btn { width: 88rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; border-radius: 50%; }
.confirm-btn__x { color: #141414; font-size: 40rpx; line-height: 1; }
.confirm-btn--ok { background: #141414; }
.confirm-btn--ok.is-busy { opacity: .5; }
.confirm-btn__ok { color: #ffffff; font-size: 40rpx; line-height: 1; }
.confirm-btn.is-pressed { transform: scale(.9); }
</style>

