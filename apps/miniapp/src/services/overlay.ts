import { setTabBarHidden } from './tab-bar';

/** 
 * 页面级浮层（全部收藏的详情卡）打开时，把「页面之外、但同屏可见」的两块 chrome 一起处理。
 *
 * 为什么页面里的 `position: fixed` 遮罩盖不住它们：
 *  1) 自定义底栏 —— 由框架渲染、层在页面内容之上，页面里 z-index 给到 950 也压不住
 *     （实测：遮罩只盖到页面视口，底栏那一条是亮的）。所以反过来让底栏自己让位：
 *     早先的做法是「蒙一层遮罩同色」（.is-masked），但那种做法只是变暗 + 模糊，
 *     底下那条底栏照样看得见，红色加号最扎眼 —— 用户 2026-09-28 截图说「没挡住」。
 *     现在跟编辑半窗、设置半窗统一：整条下滑隐藏，关卡片时还原。
 *  2) 原生导航栏 —— 页面内容永远盖不到它。改用 setNavigationBarColor 把底色换成
 *     遮罩同色，视觉上就接上了（标题文字仍是清晰的，系统胶囊也动不了，这是框架底线）。
 *
 * 颜色：遮罩是 rgba(17,15,12,.36)，压在页面底色 #f2f3f7 上正好是 #a1a0a2。
 */
const NAV_BAR_BG = '#f2f3f7';
const NAV_BAR_DIMMED = '#a1a0a2';

export function maskPageChrome(masked: boolean) {
  setTabBarHidden(masked);
  uni.setNavigationBarColor({
    frontColor: '#000000',
    backgroundColor: masked ? NAV_BAR_DIMMED : NAV_BAR_BG,
    animation: { duration: 300, timingFunc: 'easeIn' }
  });
}
