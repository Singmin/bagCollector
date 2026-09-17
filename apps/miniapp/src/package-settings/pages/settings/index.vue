<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api, logout } from '../../../services/http';

interface AccountStats { collectibleCount: number; shelfCount: number; storageUsedBytes: number; storageQuotaBytes: number }
const stats = ref<AccountStats | null>(null); const used = ref('—'); const quota = ref('—');
function bytes(value: number) { if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`; return `${(value / 1024 ** 3).toFixed(2)} GB`; }
async function load() { try { stats.value = await api<AccountStats>('/account'); used.value = bytes(stats.value.storageUsedBytes); quota.value = bytes(stats.value.storageQuotaBytes); } catch { uni.showToast({ title: '统计加载失败', icon: 'none' }); } }
function privacy() { uni.showModal({ title: '隐私说明', content: 'BagCollect 使用微信身份建立私人账户。你主动选择的照片会上传到私有对象存储，并用于裁剪、自动抠图和跨设备同步。不会公开展示，也不会获取手机号、昵称或通讯录。', showCancel: false }); }
async function signOut() { await logout(); uni.reLaunch({ url: '/pages/showcase/index' }); }
function removeAccount() { uni.showModal({ title: '永久注销账号？', content: '所有展示架、收藏信息和云端图片都将被删除，且无法恢复。', confirmText: '永久删除', confirmColor: '#9d3d36', success: async (result) => { if (!result.confirm) return; try { await api('/account', { method: 'DELETE' }); await logout(); uni.showModal({ title: '账号已注销', content: '你的数据删除任务已提交。', showCancel: false, success: () => uni.reLaunch({ url: '/pages/showcase/index' }) }); } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '注销失败', icon: 'none' }); } } }); }
function manageShelves() { uni.navigateTo({ url: '/package-settings/pages/shelves/index' }); }
onShow(() => void load());
</script>

<template>
  <view class="page settings-page"><view class="header"><text class="eyebrow">SETTINGS</text><text class="display-title">我的陈列柜</text></view>
    <view class="stats card"><view><text>收藏</text><strong>{{ stats?.collectibleCount || 0 }} 件</strong></view><view><text>展示架</text><strong>{{ stats?.shelfCount || 0 }} 个</strong></view><view><text>云端存储</text><strong>{{ used }} / {{ quota }}</strong></view></view>
    <view class="menu card"><button @tap="manageShelves"><text>展示架管理</text><text>›</text></button><button @tap="privacy"><text>隐私与数据使用</text><text>›</text></button><button @tap="signOut"><text>退出当前登录</text><text>›</text></button></view>
    <view class="privacy-note">照片默认保存于你的私人云端空间。展示图会移除定位等 EXIF 信息；原图仅用于重新编辑，不会公开。</view><button class="secondary-button danger-button remove" @tap="removeAccount">注销账号并删除全部数据</button>
  </view>
</template>

<style scoped>
.header { margin: 18rpx 0 50rpx; }.header .display-title { display: block; margin-top: 10rpx; font-size: 58rpx; }.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 1rpx; overflow: hidden; }.stats view { min-height: 150rpx; padding: 26rpx; display: flex; flex-direction: column; justify-content: space-between; background: rgba(255,253,248,.75); }.stats view:last-child { grid-column: 1/-1; min-height: 120rpx; }.stats text { color: #7a7267; font-size: 22rpx; }.stats strong { font-family: Georgia,"Songti SC",serif; font-size: 32rpx; }.menu { margin-top: 28rpx; overflow: hidden; }.menu button { min-height: 96rpx; margin: 0; padding: 0 28rpx; display: flex; justify-content: space-between; align-items: center; border-bottom: 1rpx solid #e0d8cd; background: transparent; color: #2d2924; font-size: 27rpx; }.menu button:last-child { border-bottom: 0; }.privacy-note { margin-top: 30rpx; padding: 24rpx; color: #746c61; font-size: 23rpx; line-height: 1.7; }.remove { margin-top: 46rpx; }
</style>
