<script setup lang="ts">
import { ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import { dataService } from '../../../services/data';
import { getSide, sideLabel, readEditor, writeEditor, clearEditor, type ImageOperation, type ImageSide } from '../../../services/image-editor';
const id = ref(''); const stage = ref(''); const side = ref<ImageSide>('FRONT');
const operations = ref<ImageOperation[]>([]);
const elapsed = ref(0); const failureMessage = ref(''); const retrying = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let startedAt = 0; let alive = true;
function toMetadata() {
  writeEditor(id.value, 'selected', side.value);
  const pages = getCurrentPages();
  const previous = pages.slice(0, -1).map(page => page.route).lastIndexOf('package-editor/pages/metadata/index');
  if (previous >= 0) uni.navigateBack({ delta: pages.length - 1 - previous });
  else uni.redirectTo({ url: `/package-editor/pages/metadata/index?id=${id.value}&side=${side.value}` });
}
async function poll() {
  if (!alive) return;
  try {
    const item = await dataService.collectible(id.value);
    elapsed.value = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const pending: ImageOperation[] = []; const errors: string[] = [];
    for (const op of operations.value) {
      const image = getSide(item, op.side);
      if (op.error && !op.jobId) { pending.push(op); errors.push(`${sideLabel(op.side)}：${op.error}`); continue; }
      if (image?.processingStatus === 'READY' && (op.version === undefined || image.publishedVersion === op.version)) {
        const crop = readEditor<{ drafts: Partial<Record<ImageSide, { dirty: boolean }>> }>(id.value, 'crop');
        if (crop?.drafts[op.side]) { crop.drafts[op.side]!.dirty = false; writeEditor(id.value, 'crop', crop); }
        continue;
      }
      if (stage.value === 'normalize' && image?.processingStatus === 'AWAITING_CROP') continue;
      if (!image || image.processingStatus === 'FAILED' || (op.version !== undefined && image.processingVersion !== op.version)) {
        op.error = image?.processingError || '图片处理失败或已被替换';
        errors.push(`${sideLabel(op.side)}：${op.error}`);
      }
      pending.push(op);
    }
    operations.value = pending; writeEditor(id.value, 'operations', pending);
    if (!pending.length) { clearEditor(id.value, 'operations'); clearEditor(id.value, 'crop'); toMetadata(); return; }
    const running = pending.some(op => !op.error);
    if (errors.length && !running) { failureMessage.value = errors.join('；'); retrying.value = false; return; }
    if (elapsed.value > 120) { failureMessage.value = '图片处理超时，请重试或返回编辑'; retrying.value = false; return; }
    timer = setTimeout(() => void poll(), 1000);
  } catch (error) { if (alive) { failureMessage.value = error instanceof Error ? error.message : '状态查询失败'; retrying.value = false; } }
}
async function retry() {
  if (retrying.value) return; retrying.value = true;
  try {
    const current = await dataService.collectible(id.value);
    for (const op of operations.value) {
      const image = getSide(current, op.side);
      if (image?.processingStatus === 'READY' && image.publishedVersion === op.version) continue;
      if (op.jobId && image && ['NORMALIZING', 'CROPPING', 'MATTING'].includes(image.processingStatus)) { op.error = undefined; continue; }
      if (op.sourceVersion !== undefined && op.sourceVersion !== image?.sourceVersion) { op.error = '图片已替换，请返回编辑'; continue; }
      const crop = op.crop ?? image?.crop ?? { x: 0, y: 0, width: 1, height: 1, rotation: 0 };
      try {
        const result = op.matte && !image?.matted ? await dataService.matte(id.value, { ...crop, side: op.side, sourceVersion: op.sourceVersion }) : await dataService.crop(id.value, { ...crop, side: op.side, sourceVersion: op.sourceVersion });
        op.jobId = result.jobId; op.version = result.version; op.error = undefined;
      } catch (error) { op.jobId = undefined; op.error = error instanceof Error ? error.message : '重试失败'; }
    }
    writeEditor(id.value, 'operations', operations.value);
    failureMessage.value = ''; startedAt = Date.now(); void poll();
  } catch (error) { failureMessage.value = error instanceof Error ? error.message : '重试失败'; retrying.value = false; }
}
function backToEdit() { toMetadata(); }
onLoad(query => {
  if (typeof query?.id !== 'string') { failureMessage.value = '处理页面参数无效'; return; }
  id.value = query.id; stage.value = String(query.stage ?? 'crop'); side.value = query.side === 'BACK' ? 'BACK' : 'FRONT';
  operations.value = readEditor<ImageOperation[]>(id.value, 'operations') ?? [{ side: side.value, matte: stage.value === 'matting' }];
  startedAt = Date.now(); void poll();
});
onUnload(() => { alive = false; if (timer) clearTimeout(timer); });
</script>

<template>
  <view class="page processing-page"><view class="processing-card card">
    <view v-if="!failureMessage" class="spinner"><view /><view /><view /></view><view v-else class="failed-mark">!</view>
    <text class="eyebrow">AUTO CUTOUT</text><text class="title">{{ failureMessage ? '部分图片处理失败' : stage === 'normalize' ? '正在准备照片' : stage === 'crop' ? '正在裁剪照片' : '正在自动抠图' }}</text>
    <text class="description">{{ failureMessage || (stage === 'crop' ? '裁剪完成后将回到信息填写，可再选择是否抠图。' : '抠图结束后，将自动进入信息与分类填写。') }}</text>
    <text v-if="!failureMessage" class="elapsed">已等待 {{ elapsed }} 秒</text>
    <view v-else class="actions">
      <button class="primary-button" :disabled="retrying || !id" @tap="retry">{{ retrying ? '正在重试…' : '重试' }}</button>
      <button class="secondary-button" :disabled="retrying" @tap="backToEdit">返回编辑</button>

    </view>
  </view></view>
</template>

<style scoped>
.processing-page { display: grid; place-items: center; padding-bottom: calc(env(safe-area-inset-bottom) + 40rpx); }.processing-card { width: 100%; padding: 80rpx 44rpx; display: flex; flex-direction: column; align-items: center; text-align: center; }.spinner { width: 138rpx; height: 138rpx; position: relative; margin-bottom: 45rpx; animation: spin 2.8s linear infinite; }.spinner view { position: absolute; inset: 0; border: 2rpx solid #978c7d; border-radius: 48% 52% 44% 56%; }.spinner view:nth-child(2) { inset: 18rpx; transform: rotate(31deg); }.spinner view:nth-child(3) { inset: 38rpx; transform: rotate(68deg); }.failed-mark { width: 122rpx; height: 122rpx; display: grid; place-items: center; margin-bottom: 44rpx; border: 2rpx solid #aa4d44; border-radius: 50%; color: #9d3d36; font: 54rpx Georgia,serif; }.title { margin-top: 14rpx; font-family: Georgia,"Songti SC",serif; font-size: 42rpx; font-weight: 600; }.description { max-width: 530rpx; margin-top: 20rpx; color: #777064; font-size: 25rpx; line-height: 1.7; }.elapsed { margin-top: 26rpx; color: #9a9185; font-size: 21rpx; }.actions { width: 100%; display: grid; gap: 18rpx; margin-top: 42rpx; }.secondary-button { width: 100%; height: 88rpx; border: 2rpx solid rgba(20,20,20,.16); border-radius: 44rpx; background: transparent; color: #141414; font-size: var(--wc-font-description); font-weight: 650; }.ghost-button { width: 100%; height: 80rpx; background: transparent; color: #9d3d36; font-size: 24rpx; }.ghost-button[disabled] { opacity: .5; }@keyframes spin { to { transform: rotate(360deg); } }
</style>
