<script lang="ts">
export default { options: { virtualHost: true } };
</script>

<script setup lang="ts">
import { computed, getCurrentInstance } from 'vue';
import type { CollectibleSummary } from '../types';
import { cardNodeId, useLibraryCardEvents, type LibraryCardOpen, type LibraryDisplayItem } from '../services/library-card-events';

const props = defineProps<{ entries: LibraryDisplayItem[]; mode: 'mine' | 'wish'; activeId?: string; total: number; columns: number }>();
const emit = defineEmits<{
  open: [request: LibraryCardOpen]; longpress: [item: CollectibleSummary]; imageError: [item: CollectibleSummary];
  'update:columns': [columns: number];
}>();
const layout = computed(() => props.mode === 'wish' ? 'wish' : 'grid');
const cards = useLibraryCardEvents(getCurrentInstance()?.proxy, () => layout.value,
  request => emit('open', request), item => emit('longpress', item));
const gridCols = computed(() => props.columns);
const gridGap = 18, gridPadX = 24;
const gridW = computed(() => Math.floor((750 - 2 * gridPadX - (gridCols.value - 1) * gridGap) / gridCols.value));
const gridCardH = computed(() => Math.round(gridW.value * 1.4161));
const gridArtH = computed(() => Math.round(gridW.value * 1.1946));
const gridArtPad = computed(() => Math.round(gridW.value * 0.0732));
const gridRadius = computed(() => Math.round(gridW.value * 0.17073));
let startDistance = 0;
let startColumns = 4;
function distance(event: Event) {
  const touches = (event as unknown as { touches?: Array<{ x?: number; y?: number; clientX?: number; clientY?: number }> }).touches;
  if (touches?.length !== 2) return 0;
  return Math.hypot((touches[0].clientX ?? touches[0].x ?? 0) - (touches[1].clientX ?? touches[1].x ?? 0),
    (touches[0].clientY ?? touches[0].y ?? 0) - (touches[1].clientY ?? touches[1].y ?? 0));
}
function gridTouchStart(event: Event) {
  startDistance = distance(event);
  if (!startDistance) return;
  cards.blockGesture(); startColumns = gridCols.value;
}
function gridTouchMove(event: Event) {
  const nextDistance = distance(event);
  if (!startDistance || !nextDistance) return;
  cards.blockGesture();
  const next = Math.min(8, Math.max(4, Math.round(startColumns * startDistance / nextDistance)));
  if (next !== gridCols.value) emit('update:columns', next);
}
function gridTouchEnd() { startDistance = 0; cards.touchEnd(); }
</script>

<template>
<view
      class="grid-window"
      @touchstart="gridTouchStart"
      @touchmove="gridTouchMove"
      @touchend="gridTouchEnd"
      @touchcancel="gridTouchEnd"
    >
      <view class="grid-stage">
        <view
          class="collection-grid"
          :style="{ gridTemplateColumns: `repeat(${gridCols}, ${gridW}rpx)`, gap: `${gridGap}rpx`, padding: `0 ${gridPadX}rpx` }"
        >
          <button
            v-for="entry in entries"
            :key="entry.item.id"
            :id="cardNodeId(layout, entry.item.id)"
            class="grid-item"
            :class="{ 'is-card-source': activeId === entry.item.id, 'grid-item--wish': mode === 'wish' }"
            :style="{ width: `${gridW}rpx`, height: `${gridCardH}rpx`, borderRadius: `${gridRadius}rpx` }"
            @tap="cards.open(entry)"
            @longpress.stop="cards.longPress(entry.item)"
            @touchstart="cards.touchStart($event, entry)"
            @touchmove="cards.touchMove"
            @touchend="cards.touchEnd"
            @touchcancel="cards.touchCancel"
          >
            <image
              v-if="entry.imageUrl"
              :src="entry.imageUrl"
              mode="aspectFit"
              lazy-load
              :style="{ width: `${gridW - gridArtPad * 2}rpx`, height: `${gridArtH}rpx` }"
              @error="emit('imageError', entry.item)"
            />
            <view v-else class="grid-image-placeholder" />

            <view v-if="mode === 'mine' && (entry.item.quantity ?? 1) > 1" class="qty-badge" :style="{ borderTopRightRadius: `${gridRadius}rpx` }">×{{ entry.item.quantity }}</view>
          </button>
        </view>
        <text v-if="total > entries.length" class="grid-overflow-note" :style="{ padding: `0 ${gridPadX}rpx` }">已显示 {{ entries.length }} / 共 {{ total }} 件 · 下滑加载更多</text>
      </view>
    </view>
</template>

<style scoped>
@keyframes view-swap { from { opacity: 0; transform: translateY(11rpx); } to { opacity: 1; transform: translateY(0); } }
.grid-window { width: 100%; min-height: 70vh; overflow: hidden; }
.grid-stage { display: inline-block; min-width: 100%; padding: 24rpx 0 8rpx; }
.collection-grid { display: grid; align-content: start; justify-content: start; }
.grid-item { position: relative; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; border: 0; background: linear-gradient(160deg, #fbfbfd, #eef0f4); box-shadow: inset 0 0 0 2rpx rgba(255,255,255,.9); overflow: hidden; }
.qty-badge { position: absolute; z-index: 2; top: 0; right: 0; padding: 2rpx 10rpx; border-radius: 0 0 0 16rpx; background: rgba(255,255,255,.92); color: rgba(197,4,5,.62); font-size: 18rpx; font-weight: 700; line-height: 1.5; }
.grid-item.is-card-source { visibility: hidden; }
.grid-item image, .grid-image-placeholder { position: relative; z-index: 1; }
.grid-item--wish { border: 2rpx dashed rgba(20,20,20,.28); background: rgba(255,255,255,.55); box-shadow: inset 0 0 0 2rpx rgba(255,255,255,.9); }
.grid-item image { filter: drop-shadow(0 4px 10px rgba(0,0,0,.18)); }
.grid-image-placeholder { width: 100rpx; height: 168rpx; border-radius: 20rpx; background: rgba(255,255,255,.62); }
.grid-overflow-note { display: block; margin-top: 18rpx; color: #77736d; font-size: 20rpx; text-align: left; }
.collection-grid { animation: view-swap .26s ease both; }
</style>
