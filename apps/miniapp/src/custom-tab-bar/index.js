Component({
  // masked：页面级浮层（全部收藏的详情卡）打开时置 true，
  // 让底栏自己蒙上遮罩并关掉点击 —— 页面里的浮层压不住框架画的底栏。
  // hidden：编辑半窗等需要独占最顶层的浮层打开时置 true，整条下滑隐藏。
  data: { selected: 0, masked: false, hidden: false },
  lifetimes: {
    // 冷启动先按当前路由猜一次；正确值随后由页面 onShow 里的 syncTabBar() 推过来覆盖
    attached() { this.syncSelected(); }
  },
  methods: {
    /* 高亮只有三条来源，故意不留第四条：
       1) 冷启动 attached 里按路由猜一次；
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
      wx.switchTab({ url });
    },
    add() {
      wx.navigateTo({ url: '/package-editor/pages/add/index' });
    },

    /* 吞掉落在底栏任意位置的点击（挂在 .tab-shell 上的 catchtap）。
       为什么光有 CSS 不够：壳虽然写了 pointer-events: auto，但实测仍会穿透 ——
       点底栏会把底下页面里那一排收藏卡一起点到，把详情卡弹出来
       （用户 2026-09-24 报过两次）。底栏是框架层，页面里的 z-index 压不住它，
       所以只能在它自己这侧把点击吃掉。蒙层态（.is-masked）pointer-events: none，
       这个处理器不会触发，手势照样穿到页面遮罩上去关卡片。 */
    swallow() {}
  }
});
