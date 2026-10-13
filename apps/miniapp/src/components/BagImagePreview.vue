<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ImageSideDto } from '../services/image-editor';
const props = defineProps<{ show: boolean; sides?: { FRONT?: ImageSideDto; BACK?: ImageSideDto }; fallback?: string }>();
defineEmits<{ close: [] }>();
const index = ref(0);
const images = computed(() => {
  const result = (['FRONT', 'BACK'] as const).flatMap(side => {
    const url = props.sides?.[side]?.displayImageUrl;
    return url ? [{ side, url }] : [];
  });
  return result.length ? result : props.fallback ? [{ side: 'FRONT', url: props.fallback }] : [];
});
watch(() => props.show, () => { index.value = 0; });
</script>
<template>
  <view v-if="show" class="bag-image-preview" @tap.self="$emit('close')">
    <swiper class="bag-image-preview__swiper" :current="index" @change="index = $event.detail.current">
      <swiper-item v-for="image in images" :key="image.side"><image class="bag-image-preview__image" :src="image.url" mode="aspectFit" @tap="$emit('close')" /></swiper-item>
    </swiper>
    <view class="bag-image-preview__labels"><text v-for="(image, i) in images" :key="image.side" :class="{ active: i === index }" @tap="index = i">{{ image.side === 'FRONT' ? '正面' : '反面' }}</text></view>
    <text class="bag-image-preview__close" @tap="$emit('close')">关闭</text>
  </view>
</template>
<style scoped>
.bag-image-preview { position:fixed; z-index:980; top:0; left:0; right:0; bottom:0; width:100%; height:100%; background:rgba(15,15,15,.88); display:flex; flex-direction:column; justify-content:center; align-items:center; }
.bag-image-preview__swiper { width:100%; height:70vh; }.bag-image-preview__image { width:100%; height:100%; }
.bag-image-preview__labels { display:flex; gap:32rpx; color:#aaa; font-size:28rpx; padding:24rpx; }.bag-image-preview__labels text { padding:12rpx 24rpx; }.bag-image-preview__labels .active { color:#fff; border-bottom:2rpx solid white; }
.bag-image-preview__close { color:#fff; padding:20rpx 40rpx; font-size:26rpx; }
</style>
