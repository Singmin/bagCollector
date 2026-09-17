<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app';
import { ensureLogin } from './services/http';

onLaunch(() => {
  void ensureLogin().catch((error) => {
    console.error('initial login failed', error);
    uni.showToast({ title: '登录失败，请检查网络', icon: 'none' });
  });
});
</script>

<style>
page { min-height: 100%; background: #f2eee6; color: #211f1c; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
view, text, image, button, input, textarea, scroll-view, canvas { box-sizing: border-box; }
button::after { border: 0; }
.page { min-height: 100vh; padding: calc(env(safe-area-inset-top) + 28rpx) 32rpx 190rpx; }
.eyebrow { display: block; color: #777064; font-size: 19rpx; font-weight: 600; letter-spacing: 4rpx; text-transform: uppercase; }
.display-title { font-family: Georgia, "Songti SC", serif; font-size: 70rpx; line-height: 1; font-weight: 600; letter-spacing: -2rpx; }
.section-title { font-family: Georgia, "Songti SC", serif; font-size: 40rpx; font-weight: 600; }
.muted { color: #817a70; }
.card { background: rgba(255,253,248,.86); border: 1rpx solid rgba(55,47,37,.12); border-radius: 32rpx; box-shadow: 0 20rpx 50rpx rgba(51,42,29,.07); }
.primary-button { display: flex; align-items: center; justify-content: center; min-height: 92rpx; margin: 0; padding: 0 30rpx; border-radius: 999rpx; background: #211f1c; color: #fffdf8; font-size: 28rpx; font-weight: 700; }
.secondary-button { display: flex; align-items: center; justify-content: center; min-height: 84rpx; margin: 0; padding: 0 28rpx; border: 1rpx solid #c9c0b2; border-radius: 999rpx; background: rgba(255,255,255,.55); color: #292622; font-size: 27rpx; }
.danger-button { color: #9d3d36; border-color: #d9aaa5; background: #fff5f2; }
.form-label { display: block; margin: 28rpx 0 12rpx; color: #625c53; font-size: 24rpx; }
.form-input, .form-textarea, .form-picker { width: 100%; padding: 25rpx 26rpx; border: 1rpx solid #d4cbbd; border-radius: 20rpx; background: #fffdf8; font-size: 28rpx; }
.form-textarea { min-height: 180rpx; }
.status-pill { display: inline-flex; padding: 8rpx 15rpx; border-radius: 999rpx; background: #eee6da; color: #655e54; font-size: 20rpx; }
</style>
