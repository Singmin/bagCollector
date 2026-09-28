/* ⚠ 这是原生小程序组件（不是 vue 文件），与 services/tab-bar.ts 靠 App 实例上的
   一条总线（`__bagTabBarBus`）通信 —— 页面侧推、这里订阅。两边的结构必须一致：
   { sinks: [组件实例], state: { selected, hidden } }。 */

function tabBarBus() {
  const app = getApp();
  if (!app) return null;
  if (!app.__bagTabBarBus) app.__bagTabBarBus = { sinks: [], state: {} };
  return app.__bagTabBarBus;
}

Component({
  // hidden：详情卡、编辑半窗、设置半窗这些「要独占最顶层」的浮层打开时置 true，
  // 整条下滑隐藏 —— 底栏是框架层、渲染在页面内容之上，页面里的遮罩压不住它，
  // 蒙一层也只是变暗（用户 2026-09-28 判定「没挡住」），所以直接收起来。
  data: { selected: 0, hidden: false },
  lifetimes: {
    /* ⚠ 顺序是「先订阅回放状态，再按路由猜高亮」：
       底栏组件会因为输入框聚焦（键盘弹出、页面重排）被重新 attached，data 复位成
       默认值，隐藏态当场丢失 —— 表现就是「编辑半窗里点一下输入框，底栏又冒出来」
       （用户 2026-09-28 实测）。订阅总线后把状态回放回来，重建也能立刻接上。 */
    attached() { this.subscribeBus(); this.syncSelected(); },
    detached() { this.unsubscribeBus(); }
  },
  methods: {
    /* ── 总线订阅：回放服务侧保存的最后一次状态 ── */
    subscribeBus() {
      const bus = tabBarBus();
      if (!bus) return;
      if (bus.sinks.indexOf(this) < 0) bus.sinks.push(this);
      const patch = {};
      if (typeof bus.state.selected === 'number') patch.selected = bus.state.selected;
      if (typeof bus.state.hidden === 'boolean') patch.hidden = bus.state.hidden;
      if (Object.keys(patch).length) this.setData(patch);
    },
    unsubscribeBus() {
      const bus = tabBarBus();
      if (!bus) return;
      bus.sinks = bus.sinks.filter((sink) => sink !== this);
    },

    /* 高亮只有三条来源，故意不留第四条：
       1) attached 里按路由猜一次；
       2) 两个 tab 页自己在 onShow 里调 syncTabBar(0/1) 主动推（见 services/tab-bar.ts）；
       3) 点底栏时 switchTab 立即 setData，保证点了就亮。

       这里原本还有 pageLifetimes.show -> syncSelected（又按当前路由猜一次），
       它会把页面推过来的正确值盖掉：切 tab 时它可能晚于目标页面的 onShow 触发，
       而那一刻 getCurrentPages() 里还是上一个页面，猜出来的是旧索引 ——
       表现就是「从全部收藏切回陈列，底栏高亮不动」（用户实测到的问题）。 */
    syncSelected() {
      const pages = getCurrentPages();
      const route = pages[pages.length - 1]?.route || '';
      this.setData({ selected: route.includes('library') ? 1 : 0 });
    },
    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index);
      const url = index === 0 ? '/pages/showcase/index' : '/pages/library/index';
      this.setData({ selected: index });
      const bus = tabBarBus();
      if (bus) bus.state.selected = index;
      wx.switchTab({ url });
    },
    add() {
      wx.navigateTo({ url: '/package-editor/pages/add/index' });
    },

    /* 吞掉落在底栏任意位置的点击（挂在 .tab-shell 上的 catchtap）。
       为什么光有 CSS 不够：壳虽然写了 pointer-events: auto，但实测仍会穿透 ——
       点底栏会把底下页面里那一排收藏卡一起点到，把详情卡弹出来
       （用户 2026-09-24 报过两次）。底栏是框架层，页面里的 z-index 压不住它，
       所以只能在它自己这侧把点击吃掉。隐藏态（.is-hidden）pointer-events: none，
       这个处理器不会触发，手势照样落到浮层遮罩上去。 */
    swallow() {}
  }
});
