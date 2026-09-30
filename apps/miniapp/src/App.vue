<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app';
import { ensureLogin } from './services/http';

onLaunch(() => {
  void ensureLogin().catch((error) => {
    console.error('initial login failed', error);
    uni.showToast({ title: '登录失败，请检查网络', icon: 'none' });
  });
  /* 开启右上角菜单的「转发给朋友 / 分享到朋友圈」；页面侧由各页的 onShareAppMessage / onShareTimeline 提供内容 */
  uni.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] });
});
</script>

<style>
page {
  --wc-font-headline: 44rpx;
  --wc-font-em-title: 34rpx;
  --wc-font-title: 34rpx;
  --wc-font-group-title: 30rpx;
  --wc-font-description: 28rpx;
  --wc-font-footnote: 24rpx;
  min-height: 100%;
  background: #f2f3f7;
  color: #000;
  /* 正文字体栈照搬 H5 原型（袋袋集原型.html:26）：西文/数字优先命中 SF Pro Text，
     中文回退 PingFang SC。别把 "PingFang SC" 提到前面 —— 那样西文数字也会用苹方的字形，
     和 H5 的观感对不上。 */
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
}
view, text, image, button, input, textarea, scroll-view, canvas { box-sizing: border-box; }
button::after { border: 0; }
.page { min-height: 100vh; padding: 48rpx 30rpx 186rpx; }
.eyebrow { display: block; color: #777064; font-size: var(--wc-font-footnote); font-weight: 500; letter-spacing: 4rpx; text-transform: uppercase; }
.display-title { font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: 70rpx; line-height: 1; font-weight: 600; letter-spacing: -2rpx; }
.section-title { font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: 40rpx; font-weight: 600; }
.muted { color: #817a70; }
.card { background: rgba(255,253,248,.86); border: 1rpx solid rgba(55,47,37,.12); border-radius: 32rpx; box-shadow: 0 20rpx 50rpx rgba(51,42,29,.07); }
.primary-button { display: flex; align-items: center; justify-content: center; min-height: 92rpx; margin: 0; padding: 0 30rpx; border-radius: 999rpx; background: #211f1c; color: #fffdf8; font-size: var(--wc-font-em-title); font-weight: 500; }
.secondary-button { display: flex; align-items: center; justify-content: center; min-height: 84rpx; margin: 0; padding: 0 28rpx; border: 1rpx solid #c9c0b2; border-radius: 999rpx; background: rgba(255,255,255,.55); color: #292622; font-size: var(--wc-font-em-title); font-weight: 500; }
.danger-button { color: #9d3d36; border-color: #d9aaa5; background: #fff5f2; }
.form-label { display: block; margin: 28rpx 0 12rpx; color: #57514a; font-size: var(--wc-font-group-title); font-weight: 500; }
.form-input, .form-textarea, .form-picker { width: 100%; padding: 25rpx 26rpx; border: 1rpx solid #d4cbbd; border-radius: 20rpx; background: #fffdf8; font-size: var(--wc-font-title); }
.form-input { height: 88rpx; min-height: 88rpx; padding: 0 26rpx; line-height: 88rpx; }
.form-textarea { min-height: 180rpx; }
.status-pill { display: inline-flex; padding: 8rpx 15rpx; border-radius: 999rpx; background: #eee6da; color: #655e54; font-size: 20rpx; }
</style>
