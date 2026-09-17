Component({
  data: { selected: 0 },
  pageLifetimes: {
    show() { this.syncSelected(); }
  },
  methods: {
    syncSelected() {
      const pages = getCurrentPages();
      const route = pages[pages.length - 1]?.route || '';
      this.setData({ selected: route.includes('library') ? 1 : 0 });
    },
    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index);
      const url = index === 0 ? '/pages/showcase/index' : '/pages/library/index';
      wx.switchTab({ url });
      this.setData({ selected: index });
    },
    add() {
      wx.navigateTo({ url: '/package-editor/pages/add/index' });
    }
  }
});
