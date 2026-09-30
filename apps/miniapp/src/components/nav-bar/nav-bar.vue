<script setup lang="ts">
import { ref } from 'vue';

/* 通用自定义导航栏：所有使用 navigationStyle: custom 的页面复用此组件。
   · 白底 + 居中标题（32rpx / 500 / 系统黑体，与拍照页同规格）
   · back：左侧返回箭头（返回箭头顶点与胶囊同轴，任意机型一致）
   · 行高推导：导航行高 = 胶囊高 + 2×（胶囊顶到状态栏底的间距），取不到胶囊时退回 44px */
defineProps<{ title?: string; back?: boolean }>();

const statusBarHeight = ref(20);
const navBarHeight = ref(44);
// #ifdef MP-WEIXIN
try {
  const capsule = uni.getMenuButtonBoundingClientRect();
  const systemInfo = uni.getSystemInfoSync();
  statusBarHeight.value = systemInfo.statusBarHeight ?? 20;
  navBarHeight.value = capsule.height + (capsule.top - statusBarHeight.value) * 2;
} catch {
  /* 非微信端取不到胶囊，用默认值 */
}
// #endif

function goBack() {
  uni.navigateBack({ delta: 1 });
}
</script>

<template>
  <view class="nav-bar" :style="{ paddingTop: `${statusBarHeight}px`, height: `${statusBarHeight + navBarHeight}px` }">
    <view v-if="back" class="nav-bar__back" :style="{ top: `${statusBarHeight}px`, bottom: 0 }" @tap="goBack">
      <image class="nav-bar__back-icon" src="/static/figma/back.svg" mode="aspectFit" />
    </view>
    <text class="nav-bar__title">{{ title }}</text>
  </view>
</template>

<style scoped>
/* 无底色：透明，随页面自身背景（与拍照页头部一致，白底页面自然显白） */
.nav-bar { position: relative; flex: 0 0 auto; box-sizing: border-box; display: flex; align-items: center; justify-content: center; }
.nav-bar__title { font-size: 36rpx; font-weight: 500; line-height: 48rpx; color: #000000; }
/* 返回钮：top/bottom 由脚本注入（状态栏以下的内容行），flex 垂直居中 ——
   中心与标题严格同轴（勿改回 top:50%，那是相对含状态栏的整条导航，会偏高） */
.nav-bar__back { position: absolute; left: 36rpx; width: 56rpx; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; }
.nav-bar__back-icon { width: 22rpx; height: 38rpx; }
</style>
