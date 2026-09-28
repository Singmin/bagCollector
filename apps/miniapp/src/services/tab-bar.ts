interface TabBarController {
  setData(data: TabBarPatch): void;
}

interface TabPage {
  getTabBar?: () => TabBarController | undefined;
  $vm?: {
    $scope?: {
      getTabBar?: () => TabBarController | undefined;
    };
  };
}

export type TabBarPatch = { selected?: number; hidden?: boolean };

/* ── 状态通道 ──
   自定义底栏是原生组件（src/custom-tab-bar），渲染在页面之上、页面里的
   `position: fixed` 浮层压不住它，所以「隐藏」只能反过来推给底栏自己。

   推的通道有两条，缺一不可：

   ① `getTabBar()`（原来只有这条）—— 直连当前页那一份底栏实例，够快；
   ② App 实例上的总线（新增）—— 底栏组件会因为**输入框聚焦**（键盘弹出、
      页面重排）被重新 attached，data 复位成默认值，隐藏态当场丢失：
      表现就是「编辑半窗里点一下名称输入框，底部那条底栏又冒出来了」
      （用户 2026-09-28 截图指出：设置半窗 / 编辑半窗 / 详情卡打开时底部一直不对）。
      组件在 attached 时订阅这条总线并回放最后一次状态，重建也能立刻接上。

   总线挂在 `getApp()` 上而不是模块作用域：页面（vite 打的包）与底栏组件
   （小程序直接拷贝的原生 Component）不在同一个模块图里，只有 App 实例是
   双方都够得着的。组件侧同样一份逻辑写在 custom-tab-bar/index.js。 */
interface TabBarBus {
  sinks: TabBarController[];
  state: TabBarPatch;
}

function appInstance() {
  const scope = (typeof globalThis !== 'undefined' ? globalThis : {}) as unknown as {
    getApp?: () => { __bagTabBarBus?: TabBarBus } | undefined;
  };
  return typeof scope.getApp === 'function' ? scope.getApp() : undefined;
}

export function tabBarBus(): TabBarBus | undefined {
  const app = appInstance();
  if (!app) return undefined;
  if (!app.__bagTabBarBus) app.__bagTabBarBus = { sinks: [], state: {} };
  return app.__bagTabBarBus;
}

function tabBarController() {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1] as unknown as TabPage | undefined;
  return page?.getTabBar?.() ?? page?.$vm?.$scope?.getTabBar?.();
}

/* 所有推状态的地方都走这里：先在总线上记下当前状态（供重建后的组件回放），
   再广播给订上的组件实例，最后补一次 getTabBar() 的直连（幂等，保证首帧不等订阅）。 */
function publish(patch: TabBarPatch) {
  const bus = tabBarBus();
  if (bus) {
    Object.assign(bus.state, patch);
    bus.sinks = bus.sinks.filter((sink) => {
      try {
        sink.setData(patch);
        return true;
      } catch {
        /* 组件已经销毁（切过页面），顺手从订阅表里清掉 */
        return false;
      }
    });
  }
  tabBarController()?.setData(patch);
}

export function syncTabBar(selected: 0 | 1) {
  publish({ selected });
}

/* 浮层打开时让底栏整条让位（下滑出屏 + 关掉点击），关闭时还原。
   三种浮层现在共用这一条通道：详情卡（services/overlay.ts 的 maskPageChrome）、
   编辑半窗（open/startEdit 与 closeDetail 成对）、设置半窗（settings-sheet 的 watch）。

   为什么不用「蒙一层遮罩同色 + 模糊」：底栏是框架层、渲染在页面内容之上，
   蒙起来只是变暗，底下那条栏照样看得见（红色加号最明显），
   用户 2026-09-28 截图判定「没挡住」—— 所以直接整条隐藏。 */
export function setTabBarHidden(hidden: boolean) {
  publish({ hidden });
}
