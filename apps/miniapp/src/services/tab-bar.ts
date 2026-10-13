import { reactive, readonly } from 'vue';

const state = reactive({ selected: 0 as 0 | 1, hidden: false });

// Both tab pages consume this state directly, without a native component bus.
export const tabBarState = readonly(state);

export function syncTabBar(selected: 0 | 1, hidden: boolean) {
  state.selected = selected;
  state.hidden = hidden;
}

export function setTabBarHidden(hidden: boolean) {
  state.hidden = hidden;
}
