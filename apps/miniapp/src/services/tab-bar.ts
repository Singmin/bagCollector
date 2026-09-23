interface TabBarController {
  setData(data: { selected?: number; masked?: boolean }): void;
}

interface TabPage {
  getTabBar?: () => TabBarController | undefined;
  $vm?: {
    $scope?: {
      getTabBar?: () => TabBarController | undefined;
    };
  };
}

function tabBarController() {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1] as unknown as TabPage | undefined;
  return page?.getTabBar?.() ?? page?.$vm?.$scope?.getTabBar?.();
}

export function syncTabBar(selected: 0 | 1) {
  tabBarController()?.setData({ selected });
}

/* 页面级浮层（如全部收藏的详情卡）打开时把底栏一起盖住。
   为什么要这么绕：自定义底栏是框架画的、渲染在页面内容之上，
   页面里的 `position: fixed` 浮层压不住它（z-index 给到 950 也不行），
   所以只能反过来让底栏自己蒙一层同色遮罩，并关掉点击
   —— 否则浮层打开时还能点底栏切 tab。 */
export function setTabBarMasked(masked: boolean) {
  tabBarController()?.setData({ masked });
}
