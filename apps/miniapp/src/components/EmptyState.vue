<script setup lang="ts">
withDefaults(defineProps<{ title?: string; description?: string; action?: string }>(), {
  title: '还没有收藏',
  description: '把喜欢的东西，留在看得见的地方。',
  action: ''
});
const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <view class="empty">
    <view class="mark">◇</view>
    <text class="title">{{ title }}</text>
    <text class="description">{{ description }}</text>
    <button v-if="action" class="action" @tap="emit('action')">{{ action }}</button>
  </view>
</template>

<style scoped>
.empty { padding: 100rpx 32rpx; display: flex; flex-direction: column; align-items: center; text-align: center; }
.mark { width: 112rpx; height: 112rpx; display: grid; place-items: center; border: 1rpx solid #cfc5b6; border-radius: 50%; color: #8c8378; font-size: 48rpx; }
.title { margin-top: 26rpx; font-family: Georgia, "Songti SC", serif; font-size: 38rpx; font-weight: 600; }
.description { max-width: 480rpx; margin-top: 12rpx; color: #7c756b; font-size: 25rpx; line-height: 1.6; }
.action { margin-top: 32rpx; padding: 0 36rpx; border-radius: 999rpx; background: #211f1c; color: white; font-size: 25rpx; }
</style>
