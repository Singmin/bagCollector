<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, reactive, ref, watch } from 'vue';
import { onLoad, onReady, onUnload } from '@dcloudio/uni-app';
import type { Collectible } from '../../../types';
import { SIDES, getSide, sideLabel, readEditor, writeEditor, clearEditor, type ImageSide, type ImageCrop, type ImageOperation } from '../../../services/image-editor';
import { dataService } from '../../../services/data';

type Rotation = 0 | 90 | 180 | 270;
/* 展示比例：挂袋卡照片区 ≈0.67、宫格卡 ≈0.71，收敛为 3:4 ——
   裁出来的图在 App 各展示位（均为 aspectFit）留白一致，观感统一 */
const DISPLAY_RATIO = 3 / 4;
/* 可选裁剪比例：默认 3:4（展示收敛值），另有 2:3 与原图（不锁比例，取景框铺满画布） */
type RatioKey = 'r34' | 'r23' | 'free';
const RATIOS: Record<RatioKey, number | null> = { r34: DISPLAY_RATIO, r23: 2 / 3, free: null };
const ratioKey = ref<RatioKey>('r34');
const savedFrameRatio = ref<number | null>(null);
function selectRatio(key: RatioKey) { savedFrameRatio.value = null; ratioKey.value = key; }
/* P1：90° 粗旋转 + 微调角度滑杆（±20°，0.5° 步进），两者相加为最终角度 */
const fineAngle = ref(0);
const totalAngle = computed(() => rotation.value + fineAngle.value);
function onAngle(event: any) { fineAngle.value = Number(event.detail.value ?? event.detail); }
/* P2：调色（预览用 CSS filter，最终由服务端 sharp 落盘，缺省 1 = 不调整） */
const brightness = ref(1); const contrast = ref(1); const saturation = ref(1);
function onColor(key: 'brightness' | 'contrast' | 'saturation', event: any) {
  const value = Number(event.detail.value ?? event.detail);
  if (key === 'brightness') brightness.value = value;
  else if (key === 'contrast') contrast.value = value;
  else saturation.value = value;
}
const id = ref(''); const loading = ref(true); const zoomValue = ref(1); const rotation = ref<Rotation>(0); const submitting = ref(false);
const scanOnly = ref(false);
const currentSide = ref<ImageSide>('FRONT');
const collection = ref<Collectible | null>(null);
type CropSnapshot = { frameRatio?: number | null; ratio: RatioKey; zoom: number; rotation: Rotation; angle: number; brightness: number; contrast: number; saturation: number; matte: boolean; offsetX: number; offsetY: number; dirty: boolean; sourceVersion: number };
const drafts = reactive<Partial<Record<ImageSide, CropSnapshot>>>({});
let restoring = true;
let preparedSide: ImageSide | null = null;
function capture(): CropSnapshot { return { frameRatio: savedFrameRatio.value, ratio: ratioKey.value, zoom: zoomValue.value, rotation: rotation.value, angle: fineAngle.value,
  brightness: brightness.value, contrast: contrast.value, saturation: saturation.value, matte: matteAlong.value,
  offsetX: state.offsetX, offsetY: state.offsetY, dirty: drafts[currentSide.value]?.dirty ?? false,
  sourceVersion: getSide(collection.value, currentSide.value)?.sourceVersion ?? 0 }; }
function markDirty() { if (!restoring && !scanOnly.value) drafts[currentSide.value] = { ...capture(), dirty: true }; }

async function switchSide(side: ImageSide) {
  if (side === currentSide.value || submitting.value || loading.value || !getSide(collection.value, side)?.standardImageUrl) return;
  payloads[currentSide.value] = payloadForCurrent(); drafts[currentSide.value] = capture(); currentSide.value = side; preparedSide = null;
  loading.value = true; loadError.value = ''; restoring = true;
  await prepare();
}
/* 加载阶段文案（真机排查用：显示当前走到哪一步） */
const loadingStage = ref('');
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
/* 图片加载兜底：@load 秒回是常态（<image> 与「完善信息」页命中同一缓存），
   iOS 偶现 @load/@error 都不触发 —— 2.5s 后用 getImageInfo 补一次；
   getImageInfo 与 <image> 不共享缓存、网络图要完整下载，失败可能是单纯网慢，
   再等 6s 补最后一刀，仍失败才判加载失败（用户可点重试） */
let loadWatch: any = null;
function clearLoadWatch() {
  if (loadWatch) { clearTimeout(loadWatch); loadWatch = null; }
}
function finishLoad(width: number, height: number) {
  Object.assign(state, { imageWidth: width, imageHeight: height });
  loadingStage.value = ''; loading.value = false;
  restoreDraft();
}
function failLoad(message: string) {
  loadError.value = message; loadingStage.value = ''; loading.value = false;
}
function startLoadWatch(src: string, delayMs = 2500) {
  clearLoadWatch();
  loadWatch = setTimeout(() => {
    if (!loading.value) return;
    getImageInfo(src).then((info) => {
      if (loading.value) finishLoad(info.width, info.height);
    }).catch(() => {
      if (!loading.value) return;
      loadWatch = setTimeout(() => {
        if (!loading.value) return;
        getImageInfo(src).then((info) => {
          if (loading.value) finishLoad(info.width, info.height);
        }).catch(() => {
          if (loading.value) failLoad('标准图加载失败，请点重试');
        });
      }, 6000);
    });
  }, delayMs);
}
/* ── 预览层状态（普通 <image> + CSS transform，不用 canvas 2d）──
   2026-10-03：iOS 真机（真机调试/预览）canvas 2d 首次绘制必崩
   TypeError: ... a.isMagicBrushCanvas（基础库渲染层内部错误，模拟器不复现），
   改用 image + CSS transform 预览；裁剪坐标算法（metrics/frameRect）不变，
   提交给服务端的仍是归一化 0~1 参数，与 canvas 版完全一致 */
const state = reactive({
  src: '', stageWidth: 0, stageHeight: 0, imageWidth: 0, imageHeight: 0,
  offsetX: 0, offsetY: 0, lastX: 0, lastY: 0
});

watch([savedFrameRatio, ratioKey, zoomValue, rotation, fineAngle, brightness, contrast, saturation, matteAlong, () => state.offsetX, () => state.offsetY], markDirty, { flush: 'sync' });
/* 取景框：舞台内「满足展示比例的最大矩形」，居中 */
function frameRect() {
  const ratio = savedFrameRatio.value ?? RATIOS[ratioKey.value];
  /* 原图：不锁比例，取景框铺满舞台（沿用旧行为） */
  if (ratio === null) return { x: 24, y: 46, width: state.stageWidth - 48, height: state.stageHeight - 92 };
  const padX = 24; const padY = 24;
  const maxWidth = state.stageWidth - padX * 2;
  const maxHeight = state.stageHeight - padY * 2;
  let width = maxWidth; let height = width / ratio;
  if (height > maxHeight) { height = maxHeight; width = height * ratio; }
  return { x: (state.stageWidth - width) / 2, y: (state.stageHeight - height) / 2, width, height };
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
  /* 纯计算，不写 state：computed 求值里带副作用（写响应式状态）会破坏依赖追踪，
     表现为首次渲染后样式再也不更新（2026-10-03 真机/模拟器交互全失灵的根因）。
     夹紧结果由调用方按需落回 state */
  const offsetX = Math.max(-maxX, Math.min(maxX, state.offsetX));
  const offsetY = Math.max(-maxY, Math.min(maxY, state.offsetY));
  return { frame, scale, drawWidth, drawHeight, offsetX, offsetY };
}

/* 把夹紧后的偏移落回 state —— 只在事件回调里调用（手势/滑杆），不在 computed 里 */
function clampOffsets() {
  const { offsetX, offsetY } = metrics();
  state.offsetX = offsetX; state.offsetY = offsetY;
}

/* 图片层：宽高 = 原始尺寸 × cover 缩放，围绕舞台中心平移/旋转；
   margin 负值负责把图片中心对到舞台中心，transform 再叠加手势偏移与角度。
   未拿到尺寸前的占位：不能用 display:none（真机上 <image> 会不触发 @load），
   也不能用 0×0（部分机型同样不触发），改成铺满舞台 + opacity:0，保证参与布局 */
const imageStyle = computed(() => {
  if (!state.stageWidth || !state.imageWidth) {
    return 'position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;pointer-events:none;';
  }
  const { scale, offsetX, offsetY } = metrics();
  const width = state.imageWidth * scale; const height = state.imageHeight * scale;
  return `width:${width}px;height:${height}px;margin-left:${-width / 2}px;margin-top:${-height / 2}px;`
    + `transform:translate(${offsetX}px,${offsetY}px) rotate(${totalAngle.value}deg);`
    + `filter:brightness(${brightness.value}) contrast(${contrast.value}) saturate(${saturation.value})`;
});

/* 取景框层：压暗框外用超大扩散 box-shadow（被舞台 overflow:hidden 裁掉），
   九宫格参考线用两个 1/3 平铺的线性渐变 */
const frameStyle = computed(() => {
  if (!state.stageWidth || !state.imageWidth) return 'display:none';
  const frame = frameRect();
  /* 取景框与图片层用同一套居中方式（left/top:50% + 负 margin）——
     不再用 px 硬定位到「测量的舞台中心」：若测量值与真实舞台有偏差，
     图片（CSS 50% 居中）会与取景框（px 居中）错位。改成同源居中后，
     即便测量短暂偏差，两者中心也始终重合，只影响整体缩放、不再错位 */
  return `width:${frame.width}px;height:${frame.height}px;margin-left:${-frame.width / 2}px;margin-top:${-frame.height / 2}px;`;
});

/* 舞台尺寸查询：普通 view 的 size 查询（无 canvas，无渲染崩溃面）。
   真机刚跳转时可能先拿到 0，轮询重试直到非零；
   首次非零读数常是「布局未定」的过渡值（导航/字体/胶囊高度还没落定），
   直接采用会让每次进入页面取到的舞台尺寸不一致 —— 图片 cover 缩放与取景框都随它走，
   表现为「图片对不上裁剪框 / 每次进去图片大小不一样」。
   因此改成「连续两次读到相同尺寸才采用」，读到稳定值再回。 */
function readStageSize(attempts = 15) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    let last: { width: number; height: number } | null = null;
    const attempt = (left: number) => {
      const query = uni.createSelectorQuery().in(instance?.proxy as any);
      query.select('.crop-stage').fields({ size: true }, (field: any) => {
        const size = field && field.width > 0 && field.height > 0 ? { width: field.width, height: field.height } : null;
        if (size) {
          if (last && Math.abs(last.width - size.width) < 1 && Math.abs(last.height - size.height) < 1) {
            return resolve(size);
          }
          last = size;
        } else {
          last = null;
        }
        if (left <= 0) return reject(new Error('画布初始化失败'));
        setTimeout(() => attempt(left - 1), 100);
      }).exec();
    };
    attempt(attempts);
  });
}

/* getImageInfo 的 Promise 包装：返回宽高（本身也会把图拉进本地缓存） */
function getImageInfo(src: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    uni.getImageInfo({ src, success: resolve, fail: (error: any) => reject(new Error(error?.errMsg || '图片解码失败')) });
  });
}

async function prepare() {
  try {
    loadingStage.value = '获取图片地址';
    restoring = true;
    const item = await dataService.collectible(id.value); collection.value = item;
    if (!scanOnly.value && item.imageEditable === false) throw new Error('官方袋子图片由管理员维护');
    const image = getSide(item, currentSide.value);
    if (!image?.standardImageUrl) throw new Error('这一面的标准图尚未生成');
    matted.value = !!image.matted;
    state.imageWidth = 0; state.imageHeight = 0;
    state.src = image.standardImageUrl;
    startLoadWatch(image.standardImageUrl);
    loadingStage.value = '初始化画布';
    await nextTick();
    const stage = await readStageSize();
    Object.assign(state, { stageWidth: stage.width, stageHeight: stage.height });
    restoreDraft();
  } catch (error) { clearLoadWatch(); loadError.value = error instanceof Error ? error.message : '图片加载失败'; loadingStage.value = ''; loading.value = false; }
}

/* 出错后一键重试：清干净加载态重新走一遍 prepare */
async function retry() {
  if (loading.value) return;
  loadError.value = ''; loadingStage.value = ''; loading.value = true;
  state.imageWidth = 0; state.imageHeight = 0; state.src = '';
  await prepare();
}

/* <image> 的 load 事件带回原始宽高：兜底路径里靠它进入可编辑态；
   主路径（getImageInfo）已就绪时忽略 —— 部分 @load 回调不带尺寸，不能反过来把好页面打成错误 */
function onImageLoad(event: any) {
  clearLoadWatch();
  if (!loading.value) return;
  const width = event.detail?.width; const height = event.detail?.height;
  if (!width || !height) {
    /* 事件不带尺寸时自己补一刀 getImageInfo，别直接判死 */
    if (!state.src) { loadError.value = '标准图解码失败，请重试'; loadingStage.value = ''; return; }
    getImageInfo(state.src).then((info) => {
      Object.assign(state, { imageWidth: info.width, imageHeight: info.height });
      loadingStage.value = ''; loading.value = false;
    }).catch(() => { loadError.value = '标准图解码失败，请重试'; loadingStage.value = ''; });
    return;
  }
  Object.assign(state, { imageWidth: width, imageHeight: height });
  loadingStage.value = ''; loading.value = false;
}
function onImageError() { clearLoadWatch(); if (!loading.value) return; loadError.value = '标准图加载失败'; loadingStage.value = ''; }

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
    return;
  }
  const touch = touches[0]; if (!touch) return; state.offsetX += touch.clientX - state.lastX; state.offsetY += touch.clientY - state.lastY; state.lastX = touch.clientX; state.lastY = touch.clientY; clampOffsets();
}
function touchEnd(event: any) {
  if ((event.touches ?? []).length < 2) pinchBase = null;
}

function zoom(event: any) { zoomValue.value = Number(event.detail.value); clampOffsets(); }
function rotate() { rotation.value = ((rotation.value + 90) % 360) as Rotation; state.offsetX = 0; state.offsetY = 0; }
function restoreDraft() {
  if (!state.imageWidth || !state.stageWidth || preparedSide === currentSide.value) return;
  restoring = true; resetAdjust(); matteAlong.value = false;
  const image = getSide(collection.value, currentSide.value);
  const draft = drafts[currentSide.value];
  if (draft && draft.sourceVersion === image?.sourceVersion) {
    savedFrameRatio.value = draft.frameRatio ?? null; ratioKey.value = draft.ratio; zoomValue.value = draft.zoom; rotation.value = draft.rotation;
    fineAngle.value = draft.angle; brightness.value = draft.brightness; contrast.value = draft.contrast; saturation.value = draft.saturation;
    matteAlong.value = draft.matte; state.offsetX = draft.offsetX; state.offsetY = draft.offsetY;
  } else if (image?.crop) {
    const crop = image.crop;
    const coarse = Math.round(crop.rotation / 90) * 90;
    rotation.value = ((coarse % 360 + 360) % 360) as Rotation;
    fineAngle.value = crop.rotation - coarse;
    brightness.value = crop.brightness ?? 1; contrast.value = crop.contrast ?? 1; saturation.value = crop.saturation ?? 1;
    const rad = crop.rotation * Math.PI / 180;
    const w = state.imageWidth * Math.abs(Math.cos(rad)) + state.imageHeight * Math.abs(Math.sin(rad));
    const h = state.imageWidth * Math.abs(Math.sin(rad)) + state.imageHeight * Math.abs(Math.cos(rad));
    const ratio = w * crop.width / (h * crop.height);
    savedFrameRatio.value = ratio;
    ratioKey.value = Math.abs(ratio - 3/4) < .02 ? 'r34' : Math.abs(ratio - 2/3) < .02 ? 'r23' : 'free';
    const frame = frameRect(); const base = Math.max(frame.width / w, frame.height / h);
    const scale = Math.max(frame.width / (w * crop.width), frame.height / (h * crop.height));
    zoomValue.value = Math.min(3, Math.max(1, scale / base));
    const sizes = metrics();
    state.offsetX = frame.x + (0.5 - crop.x) * sizes.drawWidth - state.stageWidth / 2;
    state.offsetY = frame.y + (0.5 - crop.y) * sizes.drawHeight - state.stageHeight / 2;
    clampOffsets();
  }
  preparedSide = currentSide.value;
  drafts[currentSide.value] = { ...capture(), dirty: draft && draft.sourceVersion === image?.sourceVersion ? draft.dirty : image?.processingStatus === 'AWAITING_CROP' };
  restoring = false;
}
function payloadForCurrent(): ImageCrop {
  const { frame, drawWidth, drawHeight, offsetX, offsetY } = metrics();
  const left = state.stageWidth / 2 + offsetX - drawWidth / 2;
  const top = state.stageHeight / 2 + offsetY - drawHeight / 2;
  return { x: Math.max(0, (frame.x - left) / drawWidth), y: Math.max(0, (frame.y - top) / drawHeight),
    width: Math.min(1, frame.width / drawWidth), height: Math.min(1, frame.height / drawHeight), rotation: Math.round(totalAngle.value * 10)/10,
    brightness: brightness.value, contrast: contrast.value, saturation: saturation.value };
}
const payloads: Partial<Record<ImageSide, ImageCrop>> = {};
/* 重置：清空全部调整（比例回默认 3:4、缩放/角度/位移/调色回初值） */
function resetAdjust() {
  savedFrameRatio.value = null; ratioKey.value = 'r34'; zoomValue.value = 1; rotation.value = 0; fineAngle.value = 0;
  state.offsetX = 0; state.offsetY = 0;
  brightness.value = 1; contrast.value = 1; saturation.value = 1;
}
async function submit() {
  if (submitting.value) return;
  /* 主按钮不用 disabled（微信内置 wx-button[disabled] 样式会盖掉黑底），改为点击时校验并提示 */
  if (loadError.value) return void uni.showToast({ title: loadError.value, icon: 'none' });
  if (loading.value) return void uni.showToast({ title: '图片加载中，请稍候', icon: 'none' });
  /* 裁剪参数按当前舞台状态实时计算：取景框相对「绘制图」的位置与占比（归一化 0~1）。
     偏移取夹紧后的值，与预览所见一致 */
  const { frame, drawWidth, drawHeight, offsetX, offsetY } = metrics();
  const left = state.stageWidth / 2 + offsetX - drawWidth / 2;
  const top = state.stageHeight / 2 + offsetY - drawHeight / 2;
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
  if (scanOnly.value) {
    // Emit geometry only. A scan retry must not rewrite collectible images or spend manual matting quota.
    const page = getCurrentPages().slice(-1)[0] as unknown as { getOpenerEventChannel: () => { emit: (event: string, data: unknown) => void } };
    page.getOpenerEventChannel().emit('scanCropConfirmed', {
      x: payload.x, y: payload.y, width: payload.width, height: payload.height, rotation: payload.rotation
    });
    uni.navigateBack();
    return;
  }
  drafts[currentSide.value] = capture(); payloads[currentSide.value] = payload;
  /* 只提交当前正在查看的这一面：切过 tab 后另一面也会因 AWAITING_CROP 被标 dirty，
     若按「所有 dirty 面」提交，会把没在调整的另一面一起裁掉（Bug）。 */
  const changed = drafts[currentSide.value]?.dirty ? [currentSide.value] : [];
  if (!changed.length) { submitting.value = false; uni.navigateBack(); return; }
  const operations: ImageOperation[] = [];
  for (const side of changed) {
    const crop = payloads[side];
    if (!crop) continue;
    const matte = !!drafts[side]?.matte && !getSide(collection.value, side)?.matted;
    const op: ImageOperation = { side, crop, matte, sourceVersion: drafts[side]?.sourceVersion };
    try { const result = matte ? await dataService.matte(id.value, { ...crop, side, sourceVersion: op.sourceVersion }) : await dataService.crop(id.value, { ...crop, side, sourceVersion: op.sourceVersion }); op.jobId = result.jobId; op.version = result.version; }
    catch (error) { op.error = error instanceof Error ? error.message : '提交失败'; }
    operations.push(op);
  }
  writeEditor(id.value, 'crop', { drafts, payloads });
  const pending = readEditor<ImageOperation[]>(id.value, 'operations') ?? [];
  writeEditor(id.value, 'operations', [...pending.filter(op => !changed.includes(op.side)), ...operations]);
  uni.redirectTo({ url: `/package-editor/pages/processing/index?id=${id.value}&stage=crop&side=${currentSide.value}` });

}
/* 取消 = 放弃本次调整返回上一页（不提交任何参数） */
function goBack() { clearEditor(id.value, 'crop'); uni.navigateBack({ delta: 1 }); }
onLoad((query) => {
  scanOnly.value = query?.scan === '1';
  if (typeof query?.id !== 'string') {
    loadError.value = '裁剪页面参数无效';
    return;
  }
  id.value = query.id;
  currentSide.value = query.side === 'BACK' ? 'BACK' : 'FRONT';
  const saved = readEditor<{ drafts: typeof drafts; payloads: typeof payloads }>(id.value, 'crop');
  if (saved && !scanOnly.value) { Object.assign(drafts, saved.drafts); Object.assign(payloads, saved.payloads); }
}); onReady(() => { if (id.value) void prepare(); });
/* 离开页面时清掉加载兜底定时器，避免回调打到已销毁的页面 */
onUnload(() => clearLoadWatch());
</script>

<template>
  <view class="crop-page">
    <nav-bar title="裁剪调色" back />
    <view v-if="!scanOnly" class="side-tabs"><view v-for="side in SIDES" :key="side" :class="{ on: side === currentSide, disabled: !getSide(collection, side)?.standardImageUrl }" @tap="switchSide(side)">{{ sideLabel(side) }}{{ drafts[side]?.dirty ? ' ·' : '' }}</view></view>
    <text class="hint">拖动调整位置 · 双指捏合缩放 · 滑杆微调</text>
    <view v-if="loadError" class="load-error">
      <text class="load-error__msg">{{ loadError }}</text>
      <view class="load-error__retry" hover-class="is-pressed" :hover-stay-time="80" @tap="retry"><text>重试</text></view>
    </view>
    <!-- 预览舞台：普通 <image> + CSS transform（不再用 canvas 2d，见 script 顶部说明）。
         取景框压暗框外用超大扩散 box-shadow，由舞台 overflow:hidden 裁掉 -->
    <view v-else class="canvas-shell">
      <view
        class="crop-stage"
        disable-scroll
        @touchstart.stop.prevent="touchStart"
        @touchmove.stop.prevent="touchMove"
        @touchend.stop.prevent="touchEnd"
        @touchcancel.stop.prevent="touchEnd"
      >
        <image
          v-if="state.src"
          class="crop-image"
          :src="state.src"
          mode="scaleToFill"
          :style="imageStyle"
          @load="onImageLoad"
          @error="onImageError"
        />
        <view v-if="state.imageWidth" class="crop-frame" :style="frameStyle" />
      </view>
      <!-- 加载蒙层必须用 v-if 而不是 v-show：v-show 编译成 hidden 属性，
           会被本类里的 display:flex 覆盖（作者样式优先级高于 UA 的 [hidden]{display:none}），
           表现为「图片已加载、loading 已置 false，蒙层却永远盖在图上」（2026-10-04 真机复现） -->
      <view v-if="loading" class="canvas-loading"><view class="canvas-loading__spinner" /><text>{{ loadingStage || '正在加载图片…' }}</text></view>
    </view>
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
    <view v-if="!scanOnly && !matted" class="matte-row">
      <view class="matte-row__text">
        <text class="matte-row__title">同时自动抠图</text>
        <text class="matte-row__hint">每张图片仅一次，抠图后还能重新裁剪</text>
      </view>
      <switch :checked="matteAlong" color="#141414" @change="onMatteAlong" />
    </view>
    <view v-else-if="!scanOnly && matted" class="matte-row matte-row--note">
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
.side-tabs { display:flex; align-self:center; width:360rpx; padding:6rpx; background:#eceae5; border-radius:20rpx; margin:8rpx 0; }
.side-tabs view { flex:1; text-align:center; padding:12rpx; font-size:26rpx; border-radius:16rpx; color:#777; }
.side-tabs .on { background:#141414; color:white; }.side-tabs .disabled { opacity:.35; }

/* 页面接 nav-bar 组件（与「完善信息」页同骨架：清零四周内边距，内容块自带边距）。
   整页 flex 纵向布局：画布 flex:1 吃掉剩余高度，确认条回到文档流（不再 fixed）——
   之前「固定底条 + padding 预留」的方案在真机上仍会把「同时自动抠图」行压到条底下
   （2026-10-04 真机复现），改文档流后结构上不可能再遮挡 */
.crop-page { height: 100vh; display: flex; flex-direction: column; background: #f2f3f7; color: #141414; }
/* 弱提示统一占位色 #b3afa8、字号走 token（原 23rpx 硬编码与全站 --wc-font-footnote 不一致） */
.hint { display: block; padding: 4rpx 40rpx 18rpx; color: #b3afa8; font-size: var(--wc-font-footnote); }
.load-error { margin: 10rpx 30rpx 0; padding: 28rpx 30rpx; border-radius: 32rpx; background: #fae2de; color: #943d37; font-size: var(--wc-font-footnote); display: flex; flex-direction: column; align-items: flex-start; }
.load-error__msg { display: block; }
.load-error__retry { margin-top: 20rpx; padding: 10rpx 36rpx; border-radius: 999rpx; background: #141414; color: #ffffff; font-size: var(--wc-font-footnote); }
.load-error__retry.is-pressed { transform: scale(.9); opacity: .8; }
/* 画布容器：纸感卡片外观（白底 + 细边框 + 柔影，取值与全站 .card 一致）；
   高度走 flex:1 吃掉导航栏/工具/滑杆之外的剩余视口，矮屏自动收缩（min-height 兜底） */
.canvas-shell { position: relative; flex: 1 1 auto; min-height: 320rpx; margin: 0 30rpx; border: 1rpx solid rgba(55,47,37,.12); border-radius: 16rpx; background: #fffdf8; box-shadow: 0 20rpx 50rpx rgba(51,42,29,.07); overflow: hidden; }
/* 舞台：图片与取景框的定位/裁剪容器；手势也挂在这一层。
   用 absolute 铺满父容器（而非 height:100%）——height:100% 依赖父级 flex 高度被视作
   「确定高度」，部分 WebView 里解析不稳定，会拿到错误的舞台尺寸（图片/取景框随之错乱） */
.crop-stage { position: absolute; left: 0; top: 0; right: 0; bottom: 0; overflow: hidden; border-radius: 16rpx; }
/* 图片层：中心锚点在舞台中心（left/top 50% + 负 margin），宽高/位移/旋转/调色全走行内样式 */
.crop-image { position: absolute; left: 50%; top: 50%; will-change: transform; }
/* 取景框：白色描边 + 九宫格参考线；框外压暗靠超大扩散 box-shadow（被舞台裁掉）。
   背景两块 1/3 平铺渐变分别在右/下边缘描 1px 线 → 正好落在 1/3 与 2/3 分割线上 */
.crop-frame { position: absolute; left: 50%; top: 50%; box-sizing: border-box; border: 1.5px solid rgba(255,255,255,.95); pointer-events: none; box-shadow: 0 0 0 9999px rgba(20,18,15,.52); background-image: linear-gradient(to right, transparent calc(100% - 1px), rgba(255,255,255,.38) calc(100% - 1px)), linear-gradient(to bottom, transparent calc(100% - 1px), rgba(255,255,255,.38) calc(100% - 1px)); background-size: calc(100% / 3) calc(100% / 3); }
/* 画布加载态蒙层：图片加载期间提示，避免被当成「点了没反应」 */
.canvas-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20rpx; color: #77736d; font-size: var(--wc-font-footnote); }
.canvas-loading__spinner { width: 60rpx; height: 60rpx; border: 6rpx solid rgba(20, 20, 20, .15); border-top-color: #141414; border-radius: 50%; animation: crop-spin .9s linear infinite; }
@keyframes crop-spin { to { transform: rotate(360deg); } }
/* 分组容器：仅提供左右边距（组标题已去掉，语义交给滑杆左侧标签） */
.group { flex: 0 0 auto; margin: 0 40rpx; padding: 6rpx 0 8rpx; }
/* 工具行：比例（3:4 / 2:3 / 原图）与旋转（旋转 90° / 重置）同排一行、等宽均分；
   主流修图 App 式 —— 图标在上、文字在下，无胶囊底；选中项文字变品牌红。
   flex-shrink:0：矮屏时只收缩画布，不挤压内容行 */
.tools-row { flex: 0 0 auto; display: flex; align-items: flex-start; margin: 26rpx 20rpx 4rpx; }
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
.matte-row { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 22rpx; margin: 0 40rpx; padding: 26rpx 0 8rpx; }
.matte-row__text { display: flex; flex-direction: column; gap: 6rpx; }
.matte-row__title { color: #141414; font-size: var(--wc-font-description); font-weight: 650; }
.matte-row__hint { color: #a8a49d; font-size: 21rpx; }
.matte-row--note { display: block; padding: 8rpx 0 0; }
/* 底部确认条：文档流内随 flex 布局永远排在内容最后（不会被任何内容遮挡），
   参照主流修图 App —— 左 ✕ 取消 / 右 ✓ 应用，圆形轻量钮取代原 87rpx 大胶囊 */
.bottom-bar { flex: 0 0 auto; padding: 12rpx 44rpx calc(env(safe-area-inset-bottom) + 12rpx); background: #f2f3f7; }
.confirm-row { display: flex; align-items: center; justify-content: space-between; }
.confirm-btn { width: 88rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; border-radius: 50%; }
.confirm-btn__x { color: #141414; font-size: 40rpx; line-height: 1; }
.confirm-btn--ok { background: #141414; }
.confirm-btn--ok.is-busy { opacity: .5; }
.confirm-btn__ok { color: #ffffff; font-size: 40rpx; line-height: 1; }
.confirm-btn.is-pressed { transform: scale(.9); }
</style>
