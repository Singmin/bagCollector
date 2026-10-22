<script setup lang="ts">
import { tabBarState } from '../services/tab-bar';

function switchTab(index: 0 | 1) {
  uni.switchTab({
    url: index === 0 ? '/pages/showcase/index' : '/pages/library/index',
    fail: () => uni.showToast({ title: '页面切换失败，请重试', icon: 'none' })
  });
}

function goCalendar() {
  uni.navigateTo({ url: '/pages/calendar/index' });
}

function add() {
  uni.navigateTo({ url: '/package-editor/pages/add/index' });
}

function swallow() {}
</script>

<template>
  <view class="tab-shell" :class="{ 'is-hidden': tabBarState.hidden }" @tap.stop="swallow">
    <view class="tab-bar">
      <!-- 左胶囊：3 个图标槽位（发现 / 我的 / 预留空位），纯图标无文字 -->
      <view class="nav-capsule">
        <button class="nav-slot" :class="{ 'is-active': tabBarState.selected === 0 }" aria-label="发现" @tap.stop="switchTab(0)">
          <image class="nav-icon" :src="tabBarState.selected === 0 ? '/static/figma/nav-home-active.svg' : '/static/figma/nav-home.svg'" mode="aspectFit" />
        </button>
        <button class="nav-slot" :class="{ 'is-active': tabBarState.selected === 1 }" aria-label="我的" @tap.stop="switchTab(1)">
          <image class="nav-icon" :src="tabBarState.selected === 1 ? '/static/figma/nav-library-active.svg' : '/static/figma/nav-library.svg'" mode="aspectFit" />
        </button>
        <button class="nav-slot" aria-label="收藏日历" @tap.stop="goCalendar">
          <image class="nav-icon" src="/static/figma/calendar.svg" mode="aspectFit" />
        </button>
      </view>
      <!-- 右侧独立 [+］ 添加按钮 -->
      <button class="add-button" aria-label="添加收藏" @tap.stop="add"><text class="add-glyph">＋</text></button>
    </view>
  </view>
</template>

<style scoped>
/* Preserve the original bar's geometry, colors and safe-area padding. */
.tab-shell { position: fixed; z-index: 900; left: 0; right: 0; bottom: 0; height: 150rpx; box-sizing: border-box; padding-bottom: env(safe-area-inset-bottom); background: #f2f3f7; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif; pointer-events: auto; transition: transform .32s cubic-bezier(.2,.75,.22,1), opacity .2s ease-out; }
.tab-bar { display: flex; align-items: center; justify-content: space-between; width: 750rpx; height: 100%; margin: 0 auto; padding: 0 32rpx; box-sizing: border-box; background: #f2f3f7; pointer-events: auto; }
/* 左胶囊容器 */
.nav-capsule { display: flex; align-items: center; gap: 8rpx; padding: 8rpx; border-radius: 999rpx; background: #e8e9ef; }
.nav-slot { width: 112rpx; height: 88rpx; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; border: none; border-radius: 999rpx; background: transparent; }
.nav-slot::after { border: none; }
.nav-icon { width: 52rpx; height: 52rpx; }
.nav-slot.is-active { background: transparent; }
.add-button { width: 104rpx; height: 104rpx; margin: 0; padding: 0; flex: none; display: flex; align-items: center; justify-content: center; border: none; border-radius: 50%; background: #c50405; box-shadow: 0 8rpx 20rpx rgba(197, 4, 5, .28); }
.add-button::after { border: none; }
.add-glyph { margin-top: -4rpx; color: #ffffff; font-size: 56rpx; font-weight: 300; line-height: 1; }
.tab-shell::before { content: ""; position: absolute; left: 0; right: 0; top: -48rpx; height: 48rpx; background: linear-gradient(180deg, rgba(242,243,247,0) 0%, #f2f3f7 100%); pointer-events: none; }
.tab-shell.is-hidden { transform: translateY(320rpx); opacity: 0; pointer-events: none; }
</style>
