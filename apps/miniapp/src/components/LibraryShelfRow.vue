<script lang="ts">
export default { options: { virtualHost: true } };
</script>

<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import type { CollectibleSummary } from '../types';
import type { LibraryShelfGroup } from '../services/use-library-collection';
import { SHELF_IMAGE_HEIGHT } from '../services/use-library-collection';
import { cardNodeId, useLibraryCardEvents, type LibraryCardOpen } from '../services/library-card-events';

const props = defineProps<{ group: LibraryShelfGroup; index: number; activeId?: string; viewportRevision: number }>();
const emit = defineEmits<{
  open: [request: LibraryCardOpen]; longpress: [item: CollectibleSummary]; imageError: [item: CollectibleSummary];
}>();
const instance = getCurrentInstance();
const cards = useLibraryCardEvents(instance?.proxy, () => 'shelf', request => emit('open', request), item => emit('longpress', item));
const scrollLeft = ref(0);
const edge = ref({ start: true, end: true });
const metrics = { width: 0, max: 0, left: 0 };
let userScrolling = false;
let alive = true;
const tone = computed(() => `acrylic-shelf--${props.group.name.includes('瑞幸') ? 'ROSE' : ['AMBER', 'SKY', 'SAGE'][props.index % 3]}`);

function updateEdge() {
  const start = metrics.left <= 2, end = metrics.left >= metrics.max - 2;
  if (start !== edge.value.start || end !== edge.value.end) edge.value = { start, end };
}
function measure() {
  nextTick(() => {
    if (!alive) return;
    uni.createSelectorQuery().in(instance?.proxy).select('.shelf-scroll').boundingClientRect().exec(rows => {
      if (!alive) return;
      const rect = rows?.[0] as { width?: number } | null;
      if (!rect?.width) return;
      const count = props.group.entries.length;
      metrics.width = rect.width;
      metrics.max = Math.max(0, uni.upx2px(80 + 175 * count + 10 * Math.max(0, count - 1)) - rect.width);
      const left = Math.min(metrics.left, metrics.max);
      if (left !== metrics.left) scrollLeft.value = left;
      metrics.left = left;
      updateEdge();
    });
  });
}
function onScroll(event: { detail: { scrollLeft: number } }) {
  metrics.left = event.detail.scrollLeft;
  updateEdge();
}
function scrollBy(direction: 1 | -1) {
  if (metrics.max <= 0) return;
  metrics.left = Math.min(metrics.max, Math.max(0, metrics.left + metrics.width * 0.8 * direction));
  scrollLeft.value = metrics.left;
  updateEdge();
}
function snap() {
  if (!userScrolling) return;
  userScrolling = false;
  if (metrics.max <= 0) return;
  const slot = uni.upx2px(185);
  metrics.left = Math.min(metrics.max, Math.max(0, Math.round((metrics.left + uni.upx2px(40)) / slot) * slot - uni.upx2px(40)));
  scrollLeft.value = metrics.left;
  updateEdge();
}
onMounted(measure);
watch(() => [props.group.entries.length, props.viewportRevision], measure);
onScopeDispose(() => { alive = false; });
function touchShelf() { userScrolling = true; }
function cancelShelfTouch() { userScrolling = false; }
</script>

<template>
<view class="shelf-group">
        <view class="shelf-heading">
          <text class="shelf-name">{{ group.name }}</text>
          <view class="shelf-hint">
            <text class="shelf-hint__count">共{{ group.entries.length }}件</text>

            <view
              class="shelf-hint__arrow"
              :class="{ 'is-dim': edge.start }"
              hover-class="is-pressed"
              :hover-stay-time="80"
              @tap="scrollBy(-1)"
            >
              <image src="/static/figma/arrow-left.svg" mode="aspectFit" />
            </view>
            <view
              class="shelf-hint__arrow"
              :class="{ 'is-dim': edge.end }"
              hover-class="is-pressed"
              :hover-stay-time="80"
              @tap="scrollBy(1)"
            >
              <image src="/static/figma/arrow-right.svg" mode="aspectFit" />
            </view>
          </view>
        </view>
        <scroll-view
          :id="`shelf-scroll-${group.id}`"
          class="shelf-scroll"
          scroll-x
          enhanced
          :show-scrollbar="false"
          scroll-with-animation
          :scroll-left="scrollLeft"
          @scroll="onScroll($event)"
          @touchstart="touchShelf"
          @touchend="snap" @touchcancel="cancelShelfTouch"
        >
          <view class="shelf-items">
            <button v-for="entry in group.entries" :key="entry.item.id" :id="cardNodeId('shelf', entry.item.id)" class="shelf-item" :class="{ 'is-card-source': activeId === entry.item.id }" @tap="cards.open(entry)" @longpress.stop="cards.longPress(entry.item)" @touchstart="cards.touchStart($event, entry)" @touchmove="cards.touchMove" @touchend="cards.touchEnd" @touchcancel="cards.touchCancel">
              <image
                v-if="entry.imageUrl"
                class="shelf-image"
                :src="entry.imageUrl"
                mode="aspectFit"
                lazy-load
                :style="{ width: `${entry.imageWidth}rpx`, height: `${SHELF_IMAGE_HEIGHT}rpx` }"
                @error="emit('imageError', entry.item)"
              />
              <view v-else class="shelf-image-placeholder" />

              <view v-if="(entry.item.quantity ?? 1) > 1" class="qty-badge qty-badge--shelf">×{{ entry.item.quantity }}</view>
            </button>
          </view>
        </scroll-view>
        <view class="acrylic-shelf" :class="tone">
          <view class="shelf-fastener shelf-fastener--left" />
          <view class="shelf-fastener shelf-fastener--right" />
        </view>
      </view>
</template>

<style scoped>
.shelf-group { position: relative; margin-bottom: 40rpx; }
.shelf-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12rpx; margin: 0 40rpx 8rpx; }
.shelf-name { color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 33rpx; font-weight: 700; line-height: 1.05; margin-bottom: 7rpx; }
.shelf-hint { display: flex; align-items: center; flex: 0 0 auto; }
.shelf-hint__count { color: #77736d; font-size: 24rpx; line-height: 1; margin-right: 9rpx; }
.shelf-hint__arrow { display: flex; align-items: center; justify-content: center; width: 31rpx; height: 40rpx; opacity: .55; transition: opacity .18s ease, transform .18s ease; }
.shelf-hint__arrow image { width: 27rpx; height: 27rpx; }
.shelf-hint__arrow.is-pressed { transform: scale(.86); opacity: 1; }
.shelf-hint__arrow.is-dim { opacity: .18; pointer-events: none; }
.shelf-scroll { position: relative; z-index: 2; width: 100%; font-size: 0; line-height: 0; }
.shelf-items { display: inline-flex; align-items: flex-end; gap: 10rpx; min-width: 100%; padding: 29rpx 40rpx 15rpx; }
.shelf-item { position: relative; width: 175rpx; height: 240rpx; flex: 0 0 175rpx; margin: 0; padding: 0; display: flex; align-items: flex-end; justify-content: center; background: transparent; overflow: visible; }
.shelf-item .shelf-image { transform: translateY(-18rpx); filter: drop-shadow(0 7rpx 18rpx rgba(0,0,0,.18)); }
.shelf-image-placeholder { width: 140rpx; height: 20rpx; border-radius: 24rpx; background: rgba(255,255,255,.62); transform: translateY(-18rpx); }
.acrylic-shelf { position: absolute; z-index: 3; left: 25rpx; right: 25rpx; bottom: 25rpx; height: 104rpx; border: 2rpx solid rgba(255,255,255,.40); border-radius: 16rpx; box-shadow: 0 15rpx 29rpx rgba(43,35,29,.13), inset 0 2rpx 0 rgba(255,255,255,.55); background: linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,0) 55%), var(--shelf-fill, rgba(240,154,42,.72)); }
.shelf-fastener { position: absolute; top: 50%; width: 22rpx; height: 22rpx; transform: translateY(-50%); border-radius: 50%; background: radial-gradient(circle at 34% 26%, rgba(255,255,255,.95) 0 12%, rgba(255,255,255,0) 34%), radial-gradient(circle at 50% 50%, rgba(255,255,255,.9) 0 8%, rgba(255,255,255,0) 30%), linear-gradient(150deg, #f2efe9, #b8b1a6 25%, #8d857a 50%, #cfc8bd 75%, #f2efe9 100%); box-shadow: 0 1rpx 3rpx rgba(0,0,0,.40), 0 3rpx 8rpx rgba(0,0,0,.22), inset 0 0 0 1rpx rgba(255,255,255,.60), inset 0 -2rpx 3rpx rgba(0,0,0,.30); }
.shelf-fastener--left { left: 20rpx; }
.shelf-fastener--right { right: 20rpx; }
.acrylic-shelf--SAGE { --shelf-fill: rgba(117,168,141,.72); }
.acrylic-shelf--AMBER { --shelf-fill: rgba(240,154,42,.72); }
.acrylic-shelf--SKY { --shelf-fill: rgba(34,158,232,.66); }
.acrylic-shelf--ROSE { --shelf-fill: rgba(253,83,192,.72); }
.qty-badge { position: absolute; z-index: 2; top: 0; right: 0; padding: 2rpx 10rpx; border-radius: 0 0 0 16rpx; background: rgba(255,255,255,.92); color: rgba(197,4,5,.62); font-size: 18rpx; font-weight: 700; line-height: 1.5; }
.qty-badge--shelf { top: -14rpx; right: 4rpx; border-radius: 16rpx; }
.shelf-item.is-card-source { visibility: hidden; }
</style>
