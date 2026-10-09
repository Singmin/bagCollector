<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { Collectible, OfficialBag, OfficialBagMatchCandidate, Shelf, UploadPolicy } from '../../../types';
import { api, authorizedHeaders } from '../../../services/http';
import { dataService } from '../../../services/data';

const systemInfo = uni.getSystemInfoSync();
const statusBarHeight = systemInfo.statusBarHeight ?? 20;
const isDevtools = systemInfo.platform === 'devtools';
/* 标题 / 返回键与右上角胶囊按钮垂直居中：导航行高按胶囊上下留白对称推导
   （navBarHeight = 胶囊高 + 2×胶囊顶部到状态栏底的间距），取不到时退回 44px 默认值 */
const menuButton = uni.getMenuButtonBoundingClientRect();
const navBarHeight = menuButton.height
  ? menuButton.height + (menuButton.top - statusBarHeight) * 2
  : 44;

const filePath = ref('');
const flashOn = ref(false);
const capturing = ref(false);
const uploading = ref(false);
const compressing = ref(false);
const progress = ref(0);
const errorMessage = ref('');

/* ── 扫描匹配 ──
   打开时，拍照后先拿这张照片去比对官方袋子库：
   相似度足够高就直接入库（用户不用填任何信息），有相近的就让用户点选，
   都不像则提示后转入手工上传。关闭时维持原来的「拍完填信息」流程。 */
const scanMode = ref(false);
/** result = CANDIDATES 时的待选列表 */
const candidates = ref<OfficialBagMatchCandidate[]>([]);
const showCandidates = ref(false);
/** 扫描时建的那条收藏 id：它只负责承载照片去比对，命中后要被清掉 */
const scannedCollectibleId = ref('');
/* 真机 camera 组件从挂载到出帧需要时间，期间画面是黑的 —— 用 initdone 事件标记就绪，
   就绪前铺一层「正在启动相机」占位，避免首屏被监控判成白屏（本页白屏 5/7 次的根因）。
   开发者工具不支持 camera 组件、不会回调 initdone，直接视为就绪（保持原状不显示占位）。 */
const cameraReady = ref(isDevtools);

// 原图直传在慢网下要几十秒，而服务端最终只保留最长边 4096 的版本，
// 所以超过阈值就先在本地压一次。阈值以下的照片不动，避免无谓的重编码损失。
const COMPRESS_THRESHOLD_BYTES = 1_500_000;
const COMPRESS_QUALITY = 80;
/* 长边压到 2048：展示图（DISPLAY）产出的上限就是 2048px，原图再大也用不上，
   纯粹拖慢上传与 worker 的解码/编码（手机原图普遍 3000~4000px） */
const COMPRESS_MAX_EDGE = 2048;

function imageInfo(path: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    uni.getImageInfo({
      src: path,
      success: (result) => resolve({ width: result.width, height: result.height }),
      fail: () => resolve({ width: 0, height: 0 })
    });
  });
}

function contentType(path: string) {
  const extension = path.split('.').pop()?.toLocaleLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' } as Record<string, string>)[extension ?? ''] ?? 'image/jpeg';
}

function fileSize(path: string) {
  return new Promise<number>((resolve, reject) => {
    uni.getFileInfo({
      filePath: path,
      success: (result) => resolve(result.size),
      fail: (error) => reject(new Error(error.errMsg || '无法读取照片'))
    });
  });
}

function compress(path: string, size?: { width: number; height: number }) {
  return new Promise<string>((resolve) => {
    /* compressedWidth/Height 是微信扩展参数（uni 类型未覆盖），按长边等比缩到上限 */
    const options: Record<string, unknown> = {
      src: path,
      quality: COMPRESS_QUALITY,
      success: (result: { tempFilePath?: string }) => resolve(result.tempFilePath || path),
      fail: () => resolve(path)
    };
    const longEdge = size ? Math.max(size.width, size.height) : 0;
    if (longEdge > COMPRESS_MAX_EDGE) {
      const scale = COMPRESS_MAX_EDGE / longEdge;
      options.compressedWidth = Math.round(size!.width * scale);
      options.compressedHeight = Math.round(size!.height * scale);
    }
    uni.compressImage(options as never);
  });
}

// 压缩失败、平台不支持或压缩后反而更大时，一律回退原图，不能让压缩挡掉上传。
async function prepareUpload(path: string) {
  let originalSize = 0;
  try {
    originalSize = await fileSize(path);
  } catch {
    return path;
  }
  const info = await imageInfo(path);
  if (originalSize <= COMPRESS_THRESHOLD_BYTES && Math.max(info.width, info.height) <= COMPRESS_MAX_EDGE) return path;
  const compressed = await compress(path, info);
  if (compressed === path) return path;
  try {
    const compressedSize = await fileSize(compressed);
    return compressedSize > 0 && compressedSize < originalSize ? compressed : path;
  } catch {
    return path;
  }
}

async function targetShelfId() {
  const shelves = await dataService.shelves();
  if (shelves[0]) return shelves[0].id;
  const shelf = await dataService.createShelf({ name: '未分类', theme: 'SAGE' });
  return shelf.id;
}

async function uploadSource(path: string, policy: UploadPolicy) {
  const header = await authorizedHeaders();
  return new Promise<void>((resolve, reject) => {
    const task = uni.uploadFile({
      url: policy.uploadUrl,
      filePath: path,
      name: 'file',
      formData: policy.formData,
      header,
      success: (result) => (result.statusCode >= 200 && result.statusCode < 300
        ? resolve()
        : reject(new Error(`图片上传失败（${result.statusCode}）`))),
      fail: (error) => reject(new Error(error.errMsg || '图片上传网络失败'))
    });
    task.onProgressUpdate((event) => { progress.value = event.progress; });
  });
}

/* ── 规范化等待（处理页的轻量替身）──
   uploads/complete 后 worker 异步把原图转成标准图（AWAITING_CROP/READY），
   旧流程跳独立「处理中」状态页；改为本页弹加载 toast 原地等待，完成后直接进完善信息。
   轮询 1s 一次，上限 30s —— 超时按失败收场，避免 loading 永远挂着 */
const POLL_INTERVAL_MS = 1000;
const PROCESS_TIMEOUT_MS = 30_000;
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForProcessing(id: string) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const item = await dataService.collectible(id);
    if (item.processingStatus === 'AWAITING_CROP' || item.processingStatus === 'READY') return;
    if (item.processingStatus === 'FAILED') throw new Error(item.processingError || '图片处理失败，请重新拍摄');
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('图片处理超时，请稍后在收藏架查看');
}

/**
 * 上传 + 等待规范化完成，返回建好的收藏 id。
 * 「拍完填信息」与「拍完先扫描匹配」两条流程共用这一段 —— 差别只在拿到 id 之后做什么。
 */
async function uploadAndPrepare(sourcePath: string) {
  const sourceSize = await fileSize(sourcePath);
  if (sourceSize > 30 * 1024 * 1024) throw new Error('图片不能超过 30MB');
  filePath.value = sourcePath;
  uploading.value = true;
  compressing.value = true;
  progress.value = 0;
  errorMessage.value = '';
  const path = await prepareUpload(sourcePath);
  compressing.value = false;
  const size = await fileSize(path);
  const collectible = await dataService.createCollectible({ name: '未命名纸袋', shelfId: await targetShelfId() });
  const sourceName = path.split('/').pop() || `paper-bag-${Date.now()}.jpg`;
  const policy = await api<UploadPolicy>('/uploads/policy', {
    method: 'POST',
    data: {
      collectibleId: collectible.id,
      fileName: sourceName.includes('.') ? sourceName : `${sourceName}.jpg`,
      contentType: contentType(path),
      size
    }
  });
  await uploadSource(path, policy);
  await api('/uploads/complete', {
    method: 'POST',
    data: { assetId: policy.assetId, collectibleId: collectible.id, key: policy.key }
  });
  /* 原地等待规范化完成：反馈交给页面状态行「正在处理图片」，不弹 loading 蒙层 */
  await waitForProcessing(collectible.id);
  return collectible.id;
}

/** 上传失败时的统一收场：清掉预览图回到相机，让用户能直接重拍。 */
function failUpload(error: unknown, fallback: string) {
  compressing.value = false;
  uploading.value = false;
  errorMessage.value = error instanceof Error ? error.message : fallback;
  filePath.value = '';
}

/** 普通上传：拍完直接进「填写信息」页。 */
async function submit(sourcePath: string) {
  if (uploading.value) return;
  try {
    const id = await uploadAndPrepare(sourcePath);
    uni.redirectTo({ url: `/package-editor/pages/metadata/index?id=${id}` });
  } catch (error) {
    failUpload(error, '照片处理失败');
  }
}

/**
 * 扫描匹配：拍完先比对官方袋子库。
 *
 * 命中就直接把这袋子收进收藏（用户零操作）；有相近的就让用户点一个；
 * 都不像则提示「未匹配成功，请手动上传」，并把刚拍的这张直接带进填写信息页 ——
 * 照片这时已经在库里了，不该让用户白拍一次。
 */
async function submitAndMatch(sourcePath: string) {
  if (uploading.value) return;
  try {
    const id = await uploadAndPrepare(sourcePath);
    scannedCollectibleId.value = id;
    uploading.value = false;
    const match = await dataService.matchOfficialBag(id);
    if (match.result === 'MATCHED' && match.matched) {
      /* 「已经拥有」不算匹配失败，但确实没有可入库的东西了 —— 先说清原因，
         再让照片按手动上传走下去（用户可能就是想把它记下来）。 */
      if (match.matched.claimed) return void goManual('你已经拥有这只袋子了，继续手动上传');
      return void (await adoptMatch(match.matched));
    }
    if (match.result === 'CANDIDATES' && match.candidates?.length) {
      candidates.value = match.candidates;
      showCandidates.value = true;
      return;
    }
    return void goManual('未匹配到官方袋子，请手动填写信息');
  } catch (error) {
    failUpload(error, '扫描失败，请重试');
  }
}

/**
 * 命中或点选之后：认领官方袋子，并清掉扫描时那条只用于比对的临时记录。
 * 认领是引用模式（图片直接读官方库、不占用户存储），落库即就绪，所以立刻能在收藏里看到。
 */
async function adoptMatch(bag: OfficialBag) {
  showCandidates.value = false;
  try {
    const { collectibleId } = await dataService.claimOfficialBag(bag.id);
    /* 临时记录使命已尽。删失败不阻断体验：用户已经拿到袋子，
       留一条草稿总好过在这一步弹错误、让他以为没成功。 */
    const stale = scannedCollectibleId.value;
    scannedCollectibleId.value = '';
    if (stale) await dataService.removeCollectible(stale).catch(() => undefined);
    uni.showToast({ title: `已匹配到「${bag.name}」`, icon: 'none', duration: 1200 });
    setTimeout(() => uni.switchTab({ url: '/pages/library/index' }), 1200);
  } catch {
    /* 绝大多数是「已经拥有过」（服务端 CONFLICT）；按未匹配处理，
       不把它当错误弹给用户。 */
    await goManual('这只袋子已经在你的收藏里了，继续手动上传');
  }
}

/** 未匹配：提示后转入手工上传流程，把刚拍的这张继续用下去（不必重拍）。 */
async function goManual(message: string) {
  showCandidates.value = false;
  const id = scannedCollectibleId.value;
  scannedCollectibleId.value = '';
  uni.showToast({ title: message, icon: 'none', duration: 1800 });
  if (!id) return;
  setTimeout(() => uni.redirectTo({ url: `/package-editor/pages/metadata/index?id=${id}` }), 1800);
}

/** 拍照 / 选图后的统一分流：扫描模式走匹配，否则走原来的填写流程。 */
function handleShot(path: string) {
  return scanMode.value ? submitAndMatch(path) : submit(path);
}

function toggleScanMode() {
  if (uploading.value) return;
  scanMode.value = !scanMode.value;
}

function takePhoto() {
  if (capturing.value || uploading.value) return;
  capturing.value = true;
  uni.createCameraContext().takePhoto({
    quality: 'high',
    success: async (result) => {
      try {
        await handleShot(result.tempImagePath);
      } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : '拍照失败';
      } finally {
        capturing.value = false;
      }
    },
    fail: (error) => {
      capturing.value = false;
      errorMessage.value = error.errMsg || '拍照失败，请重试';
    }
  });
}

function chooseFromAlbum() {
  if (capturing.value || uploading.value) return;
  /* 开发者工具模拟器对 chooseMedia 支持不完善（点击后不弹文件框、success/fail 均不回调），
     devtools 环境回退到 chooseImage（工具内会弹本地文件选择框），真机仍走 chooseMedia */
  if (isDevtools) {
    uni.chooseImage({
      count: 1,
      sizeType: ['original'],
      sourceType: ['album'],
      success: (result) => {
        const path = result.tempFilePaths?.[0];
        if (path) void handleShot(path).catch((error) => {
          errorMessage.value = error instanceof Error ? error.message : '相册选图失败';
        });
      },
      fail: (error) => {
        if (!error.errMsg?.includes('cancel')) errorMessage.value = error.errMsg || '相册打开失败';
      }
    });
    return;
  }
  uni.chooseMedia({
    count: 1,
    mediaType: ['image'],
    sourceType: ['album'],
    sizeType: ['original'],
    success: (result) => {
      const file = result.tempFiles[0];
      if (file) void handleShot(file.tempFilePath).catch((error) => {
        errorMessage.value = error instanceof Error ? error.message : '相册选图失败';
      });
    },
    fail: (error) => {
      if (!error.errMsg?.includes('cancel')) errorMessage.value = error.errMsg || '相册打开失败';
    }
  });
}

function toggleFlash() {
  flashOn.value = !flashOn.value;
}

function cameraError(event: any) {
  if (isDevtools) return; // 开发者工具不支持 camera 组件，不展示错误文案
  errorMessage.value = event.detail?.errMsg || '相机不可用，请检查相机权限';
}

function onCameraInit() {
  cameraReady.value = true;
}

function back() {
  uni.navigateBack();
}

onLoad(() => {
  void dataService.shelves().catch((error) => {
    errorMessage.value = error instanceof Error ? error.message : '分类加载失败';
  });
});
</script>

<template>
  <view class="camera-page">
    <view class="camera-header" :style="{ paddingTop: `${statusBarHeight}px`, height: `${statusBarHeight + navBarHeight}px` }">
      <view class="camera-nav">
        <button class="back-button" aria-label="返回" @tap="back">
          <image class="back-icon" src="/static/figma/back.svg" mode="aspectFit" />
        </button>
        <text class="camera-title">上传纸袋</text>
      </view>
    </view>

    <view class="capture-stage">
      <camera
        v-if="!filePath"
        class="camera-view"
        device-position="back"
        resolution="high"
        :flash="flashOn ? 'torch' : 'off'"
        @error="cameraError"
        @initdone="onCameraInit"
      />
      <view v-if="!filePath && !cameraReady && !uploading" class="camera-loading">
        <view class="camera-loading-spinner" />
        <text>正在启动相机…</text>
      </view>
      <image v-else class="captured-image" :src="filePath" mode="aspectFit" />
      <view class="guide-frame" />
      <view
        v-if="!filePath && !uploading"
        class="scan-toggle"
        :class="{ 'scan-toggle-on': scanMode }"
        @tap="toggleScanMode"
      >
        {{ scanMode ? '扫描匹配：开' : '扫描匹配：关' }}
      </view>
      <view v-if="uploading" class="upload-mask">
        <view class="upload-spinner" />
        <text>{{ compressing ? '正在压缩照片' : progress < 100 ? `正在上传 ${progress}%` : '正在处理图片' }}</text>
      </view>
    </view>

    <text v-if="errorMessage" class="camera-error">{{ errorMessage }}</text>

    <view class="camera-controls">
      <button class="round-button flash-button" :aria-label="flashOn ? '关闭闪光灯' : '打开闪光灯'" :disabled="uploading" @tap="toggleFlash">
        <image class="control-icon" :src="flashOn ? '/static/figma/flash-on.svg' : '/static/figma/flash-off.svg'" mode="aspectFit" />
      </button>
      <button class="shutter" :disabled="capturing || uploading" aria-label="拍照" @tap="takePhoto">
        <view class="shutter-core" />
      </button>
      <button class="round-button album-button" aria-label="从相册选择" :disabled="uploading" @tap="chooseFromAlbum">
        <image class="album-icon" src="/static/figma/album.svg" mode="aspectFit" />
      </button>
    </view>

    <!-- 扫描到相近的袋子：交给用户点选。只有一个候选也走这里 ——
         相似度没到「自动入库」的把握，让人确认一下比猜错强。 -->
    <view v-if="showCandidates" class="match-mask">
      <view class="match-sheet">
        <text class="match-title">找到几个相似的袋子</text>
        <text class="match-subtitle">选一个收进收藏，或继续手动上传</text>
        <scroll-view class="match-list" scroll-y>
          <view v-for="item in candidates" :key="item.bag.id" class="match-item" @tap="adoptMatch(item.bag)">
            <image class="match-thumb" :src="item.bag.thumbnailUrl" mode="aspectFit" />
            <view class="match-info">
              <text class="match-name">{{ item.bag.name }}</text>
              <text v-if="item.bag.brand" class="match-brand">{{ item.bag.brand }}</text>
            </view>
          </view>
        </scroll-view>
        <button class="match-cancel" @tap="goManual('请手动填写信息完成上传')">都不是，手动上传</button>
      </view>
    </view>
  </view>
</template>

<style scoped>
/* ── 按参考图 Frame 92 测量对齐（1 图px ≈ 1.5rpx）── */
.camera-page { height: 100vh; display: flex; flex-direction: column; overflow: hidden; background: #fff; color: #000; }
/* 头部总高 = 状态栏 + 胶囊行（inline style 注入：padding-top 撑状态栏、height 含状态栏）。
   里面再套一层「胶囊行」.camera-nav 专供内容居中与返回键定位：
   ⚠ 返回键原来直接挂在外层盒子上，那个盒子的 50% 是「含状态栏 padding 的 padding box」的中点，
   而标题是内容区（去掉 padding-top）的中点 —— 两者差着半个状态栏高度，
   表现就是返回箭头压到状态栏、与标题不同轴（用户 2026-09-28 截图）。
   多一层 .camera-nav（高度正好 = 胶囊行）之后，两者的参照系才一致。 */
.camera-header { position: relative; flex: 0 0 auto; box-sizing: border-box; }
.camera-nav { position: relative; height: 100%; display: flex; align-items: center; justify-content: center; }
.camera-title { font-size: 36rpx; font-weight: 500; line-height: 48rpx; }
/* top: 50% 相对 .camera-nav（只含导航行、不含状态栏）算，才是与标题同轴的中点 */
.back-button { position: absolute; left: 36rpx; top: 50%; transform: translateY(-50%); width: 56rpx; height: 56rpx; margin: 0; padding: 0; display: grid; place-items: center; background: transparent; }
.back-icon { width: 22rpx; height: 38rpx; }
/* 取景卡：左右 40rpx（宽 670）、圆角 60rpx、浅棕 #e2c4ae；
   高度弹性填充 + 上限 1070rpx —— 参考图卡高 ≈66% 屏高，同时小屏（667pt）不溢出 */
.capture-stage { position: relative; flex: 1 1 0; max-height: 1130rpx; margin: 32rpx 40rpx 0; overflow: hidden; border-radius: 60rpx; background: #e2c4ae; }
.camera-view, .captured-image { position: absolute; inset: 0; width: 100%; height: 100%; }
/* 相机出帧前的占位：盖住黑底，给出「正在启动」的明确反馈（白屏优化） */
.camera-loading { position: absolute; z-index: 2; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24rpx; background: #e2c4ae; color: rgba(60, 37, 20, .62); font-size: 26rpx; font-weight: 500; }
.camera-loading-spinner { width: 60rpx; height: 60rpx; border: 5rpx solid rgba(60, 37, 20, .18); border-top-color: rgba(60, 37, 20, .7); border-radius: 50%; animation: spin .9s linear infinite; }
/* 虚线引导框：相对卡片内嵌 left 56 / top 200（2026-09-26 用户要求下移），560×732，描边 5rpx、圆角 36rpx */
.guide-frame { position: absolute; z-index: 3; left: 56rpx; top: 200rpx; width: 560rpx; height: 732rpx; box-sizing: border-box; border: 5rpx dashed rgba(255, 255, 255, .65); border-radius: 36rpx; pointer-events: none; }
.upload-mask { position: absolute; z-index: 5; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30rpx; background: rgba(60, 37, 20, .48); color: #fff; font-size: 28rpx; font-weight: 600; }
.upload-spinner { width: 76rpx; height: 76rpx; border: 7rpx solid rgba(255, 255, 255, .35); border-top-color: #fff; border-radius: 50%; animation: spin .9s linear infinite; }
.camera-error { flex: 0 0 auto; margin: 16rpx 34rpx 0; color: #a12e2e; font-size: 24rpx; text-align: center; }
.camera-controls { position: relative; flex: 0 0 auto; height: 156rpx; margin-top: auto; margin-bottom: calc(16rpx + env(safe-area-inset-bottom)); }
.round-button { position: absolute; top: 24rpx; width: 108rpx; height: 108rpx; margin: 0; padding: 0; display: grid; place-items: center; border-radius: 50%; background: #fff; }
.round-button[disabled] { opacity: .45; }
.flash-button { left: 94rpx; }
.album-button { left: 548rpx; }
.control-icon { width: 56rpx; height: 56rpx; }
/* 相册图形是宽扁形（28 视框内只占 73% 高），64rpx 盒子渲染高 ≈46.6rpx
   （70rpx 等高版偏大，回调取中） */
.album-icon { width: 64rpx; height: 64rpx; }
/* 快门：外圈 150rpx（红描边 4rpx + 白环 6rpx）、红芯 130rpx，水平居中 */
.shutter { position: absolute; left: 300rpx; top: 0; width: 150rpx; height: 150rpx; margin: 0; padding: 6rpx; display: grid; place-items: center; box-sizing: border-box; border: 4rpx solid #c50405; border-radius: 50%; background: #fff; }
.shutter[disabled] { opacity: .45; }
.shutter-core { width: 130rpx; height: 130rpx; border-radius: 50%; background: #c50405; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 扫描匹配开关：浮在取景卡底部。刻意不动快门/闪光灯/相册三个按钮的定位 ——
   那套布局是按参考图逐个测量对齐的，插一个元素进去就会连带偏。 */
.scan-toggle { position: absolute; z-index: 4; left: 50%; bottom: 28rpx; transform: translateX(-50%); padding: 12rpx 32rpx; border-radius: 999rpx; background: rgba(24, 20, 16, .46); color: #fff; font-size: 24rpx; line-height: 1.4; }
.scan-toggle-on { background: rgba(197, 4, 5, .88); }

/* ── 候选选择弹层 ── */
.match-mask { position: fixed; z-index: 20; inset: 0; display: flex; align-items: flex-end; background: rgba(24, 20, 16, .45); }
.match-sheet { width: 100%; box-sizing: border-box; padding: 40rpx 40rpx calc(40rpx + env(safe-area-inset-bottom)); border-radius: 40rpx 40rpx 0 0; background: #fff; }
.match-title { display: block; font-size: 34rpx; font-weight: 600; text-align: center; }
.match-subtitle { display: block; margin-top: 12rpx; font-size: 24rpx; color: #9d9890; text-align: center; }
.match-list { max-height: 620rpx; margin-top: 24rpx; }
.match-item { display: flex; align-items: center; gap: 24rpx; margin-bottom: 16rpx; padding: 20rpx; border-radius: 24rpx; background: #f7f5f2; }
.match-thumb { flex: 0 0 auto; width: 120rpx; height: 120rpx; border-radius: 16rpx; background: #fff; }
.match-info { flex: 1 1 0; min-width: 0; }
.match-name { display: block; font-size: 28rpx; font-weight: 500; }
.match-brand { display: block; margin-top: 8rpx; font-size: 24rpx; color: #9d9890; }
.match-cancel { margin-top: 8rpx; padding: 0; border: none; border-radius: 999rpx; background: #f2f3f7; color: #444; font-size: 28rpx; line-height: 88rpx; }
</style>
