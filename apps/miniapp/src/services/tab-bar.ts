import { reactive, readonly } from 'vue';

const state = reactive({ selected: 0 as 0 | 1 | 2 | -1, hidden: false });

/* Both tab pages consume this state directly, without a native component bus.
   selected = -1 表示当前页面不属于任何 tab，底栏不高亮任何图标。 */
export const tabBarState = readonly(state);

export function syncTabBar(selected: 0 | 1 | 2 | -1, hidden: boolean) {
  state.selected = selected;
  state.hidden = hidden;
}

export function setTabBarHidden(hidden: boolean) {
  state.hidden = hidden;
}
