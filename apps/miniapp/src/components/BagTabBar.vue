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
      <!-- 右侧独立拍照按钮：白底圆框 + 拍照识别图标 -->
      <button class="add-button" aria-label="添加收藏" @tap.stop="add">
        <image class="add-icon" src="/static/figma/scan-add.svg" mode="aspectFit" />
      </button>
    </view>
  </view>
</template>

<style scoped>
/* Preserve the original bar's geometry, colors and safe-area padding. */
.tab-shell { position: fixed; z-index: 900; left: 0; right: 0; bottom: 0; height: 150rpx; box-sizing: border-box; padding-bottom: env(safe-area-inset-bottom); background: #f2f3f7; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif; pointer-events: auto; transition: transform .32s cubic-bezier(.2,.75,.22,1), opacity .2s ease-out; }
.tab-bar { display: flex; align-items: center; justify-content: space-between; width: 750rpx; height: 100%; margin: 0 auto; padding: 0 32rpx; box-sizing: border-box; background: #f2f3f7; pointer-events: auto; }
/* 左胶囊容器：白色 stadium（两端半圆，宽矩形不能用 50%，会变成椭圆） */
.nav-capsule { display: flex; align-items: center; gap: 8rpx; padding: 8rpx; border-radius: 999rpx; background: #ffffff; }
.nav-slot { position: relative; width: 88rpx; height: 88rpx; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; border: none; border-radius: 50%; background: transparent; }
.nav-slot::after { border: none; }
.nav-icon { width: 52rpx; height: 52rpx; }
/* 选中态：浅灰圆底 + 图标下方小黄点 */
.nav-slot.is-active { background: #f0f1f5; }
.nav-slot.is-active::before { content: ""; position: absolute; left: 50%; bottom: 8rpx; width: 8rpx; height: 8rpx; margin-left: -4rpx; border-radius: 50%; background: #FFCF45; }
.add-button { width: 104rpx; height: 104rpx; margin: 0; padding: 0; flex: none; display: flex; align-items: center; justify-content: center; border: none; border-radius: 50%; background: #ffffff; box-shadow: 0 4rpx 16rpx rgba(17, 18, 20, .08); }
.add-button::after { border: none; }
.add-icon { width: 56rpx; height: 56rpx; }
.tab-shell::before { content: ""; position: absolute; left: 0; right: 0; top: -48rpx; height: 48rpx; background: linear-gradient(180deg, rgba(242,243,247,0) 0%, #f2f3f7 100%); pointer-events: none; }
.tab-shell.is-hidden { transform: translateY(320rpx); opacity: 0; pointer-events: none; }
</style>
