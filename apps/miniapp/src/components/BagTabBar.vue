<script setup lang="ts">
import { tabBarState } from '../services/tab-bar';

function switchTab(index: 0 | 1) {
  uni.switchTab({
    url: index === 0 ? '/pages/showcase/index' : '/pages/library/index',
    fail: () => uni.showToast({ title: '页面切换失败，请重试', icon: 'none' })
  });
}

function add() {
  uni.navigateTo({ url: '/package-editor/pages/add/index' });
}

function swallow() {}
</script>

<template>
  <view class="tab-shell" :class="{ 'is-hidden': tabBarState.hidden }" @tap.stop="swallow">
    <view class="tab-bar">
      <button class="tab-item" :class="{ 'is-active': tabBarState.selected === 0 }" @tap.stop="switchTab(0)">
        <image class="tab-icon" :src="tabBarState.selected === 0 ? '/static/figma/nav-home-active.svg' : '/static/figma/nav-home.svg'" mode="aspectFit" />
        <text>发现</text>
      </button>
      <view class="add-slot">
        <button class="add-button" aria-label="添加收藏" @tap.stop="add"><text class="add-glyph">＋</text></button>
      </view>
      <button class="tab-item" :class="{ 'is-active': tabBarState.selected === 1 }" @tap.stop="switchTab(1)">
        <image class="tab-icon" :src="tabBarState.selected === 1 ? '/static/figma/nav-library-active.svg' : '/static/figma/nav-library.svg'" mode="aspectFit" />
        <text>我的</text>
      </button>
    </view>
  </view>
</template>

<style scoped>
/* Preserve the original bar's geometry, colors and safe-area padding. */
.tab-shell { position: fixed; z-index: 900; left: 0; right: 0; bottom: 0; height: 150rpx; box-sizing: border-box; padding-bottom: env(safe-area-inset-bottom); background: #f2f3f7; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif; pointer-events: auto; transition: transform .32s cubic-bezier(.2,.75,.22,1), opacity .2s ease-out; }
.tab-bar { position: relative; width: 750rpx; height: 100%; margin: 0 auto; background: #f2f3f7; pointer-events: auto; }
.tab-item { position: absolute; bottom: 12rpx; height: 124rpx; width: 192rpx; margin: 0; padding: 0; display: flex; flex-direction: column; justify-content: center; gap: 12rpx; align-items: center; background: transparent; color: #7a7c80; font-size: 24rpx; font-weight: 600; line-height: 1; }
.tab-item:first-child { left: 20rpx; }
.tab-item:last-child { left: 538rpx; }
.tab-item text { white-space: nowrap; }
.tab-item.is-active { color: #c50405; }
.tab-icon { width: 56rpx; height: 56rpx; }
.tab-shell::before { content: ""; position: absolute; left: 0; right: 0; top: -48rpx; height: 48rpx; background: linear-gradient(180deg, rgba(242,243,247,0) 0%, #f2f3f7 100%); pointer-events: none; }
.tab-shell.is-hidden { transform: translateY(320rpx); opacity: 0; pointer-events: none; }
.add-slot { position: absolute; left: 242rpx; bottom: 40rpx; width: 266rpx; height: 68rpx; }
.add-button { width: 266rpx; height: 68rpx; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: 34rpx; background: #c50405; box-shadow: 0 0 0 6rpx #f2f3f7, 0 0 0 11rpx #c50405; }
.add-glyph { margin-top: -4rpx; color: #ffffff; font-size: 52rpx; font-weight: 300; line-height: 1; }
</style>
