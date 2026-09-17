<script setup lang="ts">
import type { Collectible } from '../types';

const props = withDefaults(defineProps<{ item: Collectible; compact?: boolean }>(), { compact: false });

function open() {
  uni.navigateTo({ url: `/package-library/pages/detail/index?id=${props.item.id}` });
}
</script>

<template>
  <button class="object-card" :class="{ 'object-card--compact': compact }" @tap="open">
    <view class="object-art">
      <image v-if="item.thumbnailUrl" :src="item.thumbnailUrl" mode="aspectFit" lazy-load />
      <view v-else class="object-placeholder"><text>{{ item.processingStatus === 'READY' ? '◇' : '···' }}</text></view>
    </view>
    <text class="object-name">{{ item.name }}</text>
    <text class="object-meta">{{ item.shelfName || '未分类' }}</text>
  </button>
</template>

<style scoped>
.object-card { width: 100%; margin: 0; padding: 0; text-align: left; background: transparent; color: #211f1c; overflow: visible; }
.object-art { position: relative; width: 100%; height: 320rpx; display: grid; place-items: center; border-radius: 28rpx; background: rgba(255,253,248,.72); border: 1rpx solid rgba(52,45,35,.09); overflow: hidden; }
.object-art image { width: 90%; height: 90%; }
.object-placeholder { width: 64%; height: 64%; display: grid; place-items: center; border: 2rpx dashed #c7beaf; border-radius: 24rpx; color: #958c80; font-size: 44rpx; }
.object-name { display: block; margin-top: 16rpx; font-size: 26rpx; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.object-meta { display: block; margin-top: 5rpx; color: #847c70; font-size: 21rpx; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.object-card--compact { width: 238rpx; }
.object-card--compact .object-art { height: 260rpx; }
</style>
