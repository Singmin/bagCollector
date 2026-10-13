import { setTabBarHidden } from './tab-bar';

/** 
 * 页面级浮层（全部收藏的详情卡）打开时，同步底栏与原生导航栏的状态。
 *
 *  1) 页面显式渲染的 BagTabBar —— 与编辑半窗、设置半窗统一：
 *     整条下滑隐藏，关卡片时还原；状态直接驱动 Vue 组件。
 *  2) 原生导航栏 —— 页面内容永远盖不到它。改用 setNavigationBarColor 把底色换成
 *     遮罩同色，视觉上就接上了（标题文字仍是清晰的，系统胶囊也动不了，这是框架底线）。
 *
 * 颜色：遮罩是 rgba(17,15,12,.36)，压在页面底色 #f2f3f7 上正好是 #a1a0a2。
 */
const NAV_BAR_BG = '#f2f3f7';
const NAV_BAR_DIMMED = '#a1a0a2';

export function maskPageChrome(masked: boolean, duration = 300) {
  setTabBarHidden(masked);
  uni.setNavigationBarColor({
    frontColor: '#000000',
    backgroundColor: masked ? NAV_BAR_DIMMED : NAV_BAR_BG,
    animation: { duration, timingFunc: 'easeIn' }
  });
}
