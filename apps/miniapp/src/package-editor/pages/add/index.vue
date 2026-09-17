<script setup lang="ts">
import { ref } from 'vue';
import type { UploadPolicy } from '../../../types';
import { api, authorizedHeaders } from '../../../services/http';
import { dataService } from '../../../services/data';

const filePath = ref('');
const fileSize = ref(0);
const uploading = ref(false);
const progress = ref(0);
const errorMessage = ref('');

function contentType(path: string) {
  const extension = path.split('.').pop()?.toLocaleLowerCase();
  return ({ png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' } as Record<string, string>)[extension || ''] || 'image/jpeg';
}

function choose() {
  uni.chooseMedia({
    count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['original'],
    success(result) {
      const file = result.tempFiles[0];
      if (!file) return;
      if (file.size > 30 * 1024 * 1024) return void uni.showToast({ title: '图片不能超过 30MB', icon: 'none' });
      filePath.value = file.tempFilePath; fileSize.value = file.size; errorMessage.value = '';
    }
  });
}

async function upload(path: string, policy: UploadPolicy) {
  const header = await authorizedHeaders();
  return new Promise<void>((resolve, reject) => {
    const task = uni.uploadFile({
      url: policy.uploadUrl, filePath: path, name: 'file', formData: policy.formData, header,
      success: (result) => result.statusCode >= 200 && result.statusCode < 300 ? resolve() : reject(new Error(`图片上传失败（${result.statusCode}）`)),
      fail: (error) => reject(new Error(error.errMsg || '图片上传网络失败'))
    });
    task.onProgressUpdate((event) => { progress.value = event.progress; });
  });
}

async function next() {
  if (!filePath.value || uploading.value) return;
  uploading.value = true; progress.value = 0; errorMessage.value = '';
  uni.showLoading({ title: '准备上传', mask: true });
  try {
    const collectible = await dataService.createCollectible();
    const mime = contentType(filePath.value);
    const policy = await api<UploadPolicy>('/uploads/policy', {
      method: 'POST',
      data: { collectibleId: collectible.id, fileName: filePath.value.split('/').pop() || 'photo.jpg', contentType: mime, size: fileSize.value }
    });
    uni.hideLoading();
    await upload(filePath.value, policy);
    uni.showLoading({ title: '正在解析图片', mask: true });
    await api('/uploads/complete', { method: 'POST', data: { assetId: policy.assetId, collectibleId: collectible.id, key: policy.key } });
    uni.hideLoading();
    uni.redirectTo({ url: `/package-editor/pages/processing/index?id=${collectible.id}&stage=normalize` });
  } catch (error) {
    uni.hideLoading();
    errorMessage.value = error instanceof Error ? error.message : '上传失败，请重试';
  } finally { uploading.value = false; }
}
</script>

<template>
  <view class="page add-page">
    <view class="editor-header"><text class="eyebrow">NEW OBJECT · 1 / 4</text><text class="display-title">选择照片</text><text class="intro">原图会加密保存在你的私人云端空间，只用于重新编辑。</text></view>
    <button class="upload-zone" :class="{ 'has-image': filePath }" @tap="choose"><image v-if="filePath" :src="filePath" mode="aspectFit" /><template v-else><text class="plus">＋</text><text class="upload-title">从相册选择或拍摄</text><text class="upload-hint">支持 JPG、PNG、WebP、HEIC · 最大 30MB</text></template></button>
    <view v-if="uploading" class="progress"><view :style="{ width: `${progress}%` }" /></view>
    <text v-if="errorMessage" class="error">{{ errorMessage }}</text>
    <button class="primary-button next" :disabled="!filePath || uploading" @tap="next">{{ uploading ? `正在上传 ${progress}%` : '继续裁剪' }}</button>
  </view>
</template>

<style scoped>
.editor-header { margin: 20rpx 0 48rpx; }.editor-header .display-title { display: block; margin-top: 10rpx; }.intro { display: block; margin-top: 20rpx; color: #746d63; font-size: 25rpx; line-height: 1.65; }.upload-zone { width: 100%; height: 760rpx; margin: 0; padding: 34rpx; display: flex; flex-direction: column; justify-content: center; align-items: center; border: 2rpx dashed #bdb2a2; border-radius: 38rpx; background: rgba(255,253,248,.65); color: #28241f; overflow: hidden; }.upload-zone.has-image { border-style: solid; }.upload-zone image { width: 100%; height: 100%; }.plus { font-size: 80rpx; font-weight: 200; }.upload-title { margin-top: 20rpx; font-size: 30rpx; font-weight: 700; }.upload-hint { margin-top: 12rpx; color: #81796e; font-size: 22rpx; }.progress { height: 8rpx; margin: 28rpx 20rpx 0; border-radius: 999rpx; background: #dcd4c8; overflow: hidden; }.progress view { height: 100%; border-radius: inherit; background: #292520; transition: width .2s; }.error { display: block; margin-top: 24rpx; padding: 20rpx; border-radius: 18rpx; background: #fae2de; color: #943d37; font-size: 23rpx; }.next { margin-top: 36rpx; }.next[disabled] { opacity: .35; }
</style>
