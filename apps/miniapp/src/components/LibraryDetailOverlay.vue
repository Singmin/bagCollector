<script lang="ts">
export default { options: { virtualHost: true } };
</script>

<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import type { ImageSideDto } from '../services/image-editor';
import type { Collectible, CollectibleSummary, Shelf } from '../types';
import type { LibraryCardOpen } from '../services/library-card-events';
import { dataService } from '../services/data';
import { setTabBarHidden } from '../services/tab-bar';
import { useLibraryDetail } from '../services/use-library-detail';
import { createCardBackgroundResolver } from '../services/library-card-background';
import BagImagePreview from './BagImagePreview.vue';
import LibraryCardSurface from './LibraryCardSurface.vue';
import LibraryEditSheet from './LibraryEditSheet.vue';

const props = defineProps<{ request: LibraryCardOpen | null; number: string; shelves: Shelf[]; knownTagCounts: Array<[string, number]>; preloadArtwork?: string }>();
const emit = defineEmits<{
  closed: []; updated: [item: Collectible]; detailLoaded: [item: Collectible]; shelfCreated: [shelf: Shelf];
  remove: [item: CollectibleSummary]; removeWish: [item: CollectibleSummary];
  marked: [source: Collectible, createdId: string]; unmarked: [createdId: string];
}>();
const detail = useLibraryDetail({ instance: getCurrentInstance()?.proxy, number: () => props.number,
  closed: () => emit('closed'), loaded: item => emit('detailLoaded', item) });
const { detailItem, detailData, detailArtwork, detailLoading, detailSurface,
  detailMotion, detailBusy, detailBackVisible, detailFlipping, detailTurning, detailTranslateStyle, detailRotateStyle,
  detailNo, detailTags, detailNote, detailFacts, detailAtEnd, editing, previewShow, previewSide, preparing, isWishDetail,
  toggleDetailFace, onDetailMotionEnd, onDetailScroll, previewDetailArtwork, startEdit } = detail;
const resolveCardBackground = createCardBackgroundResolver();
const detailBrand = computed(() => isWishDetail.value ? (detailItem.value?.ownerName ?? '官方精选') : detailItem.value?.shelfName);
// A/B 面：摘要里的 backThumbnailUrl 让卡片在打开瞬间就按并排布局渲染（不跳变），
// 详情到了后 B 面升级为高清 displayImageUrl；没有 B 面则维持单图展示。
const detailFrontImage = computed(() => detailData.value?.sides?.FRONT?.displayImageUrl || detailArtwork.value || '');
const detailBackImage = computed(() => detailData.value?.sides?.BACK?.displayImageUrl || detailItem.value?.backThumbnailUrl || '');
const hasBackImage = computed(() => !!detailBackImage.value);
// 大图预览的两面数据：详情没到之前用摘要缩略图补位，保证 B 面也能预览。
const previewSides = computed(() => {
  const sides: { FRONT?: ImageSideDto; BACK?: ImageSideDto } = { ...detailData.value?.sides };
  if (!sides.FRONT?.displayImageUrl && detailArtwork.value) {
    sides.FRONT = { side: 'FRONT', sourceVersion: 1, processingVersion: 1, publishedVersion: 1, processingStatus: 'READY', displayImageUrl: detailArtwork.value };
  }
  if (!sides.BACK?.displayImageUrl && detailItem.value?.backThumbnailUrl) {
    sides.BACK = { side: 'BACK', sourceVersion: 1, processingVersion: 1, publishedVersion: 1, processingStatus: 'READY', displayImageUrl: detailItem.value.backThumbnailUrl };
  }
  return sides;
});
const cardBackground = computed(() => detailItem.value
  ? resolveCardBackground(detailItem.value.id, detailBrand.value ?? '', detailItem.value.name)
  : null);
// Template handlers do not forward native tap events as the immediate-close flag.
function closeDetail() { detail.closeDetail(); }
function blockScroll() {}
function onArtworkLoad() { if (!detailItem.value) detail.prepare(true); }
function onPreparationEnd(event: Event) {
  const value = event as unknown as { detail?: { animationName?: string }; animationName?: string };
  if ((value.detail?.animationName ?? value.animationName ?? '').startsWith('library-card-prepare-flip')) detail.finishPreparation();
}
const markShow = ref(false);
const markItem = ref<Collectible | null>(null);
const justMarkedMap = ref(new Map<string, string>());
const isOwnedDetail = computed(() => !isWishDetail.value || justMarkedMap.value.has(detailItem.value?.id ?? ''));
const wishPop = ref(false), wishShrink = ref(false);
let wishTimer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

function toggleDetailWish() {
  if (detailBusy.value || !detailItem.value || !isWishDetail.value) return;
  wishShrink.value = false;
  nextTick(() => {
    if (!alive) return;
    wishShrink.value = true;
    clearTimeout(wishTimer);
    wishTimer = setTimeout(() => { wishShrink.value = false; }, 340);
  });
  emit('removeWish', detailItem.value);
}
function markFromDetail() {
  if (detailBusy.value || !detailItem.value) return;
  const item = detailItem.value;
  const createdId = justMarkedMap.value.get(item.id);
  if (createdId) {
    uni.showModal({ title: '删除这条收藏？', content: `将从收藏架删除「${item.name}」的记录。`,
      confirmText: '删除', confirmColor: '#9d3d36', success: async result => {
        if (!result.confirm) return;
        try {
          await dataService.removeCollectible(createdId);
          justMarkedMap.value.delete(item.id); emit('unmarked', createdId);
          uni.showToast({ title: '已从收藏架移除', icon: 'none' });
        } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '移除失败', icon: 'none' }); }
      } });
    return;
  }
  if (!isWishDetail.value) return emit('remove', item);
  markItem.value = (detailData.value ?? item) as Collectible;
  markShow.value = true;
}
function onMarkSaved(source: Collectible, createdId: string) {
  justMarkedMap.value.set(source.id, createdId);
  emit('marked', source, createdId);
}
function onSaved(updated: Collectible) {
  detail.acceptUpdated(updated); emit('updated', updated); closeDetail();
}
function suspend() { markShow.value = false; clearTimeout(wishTimer); detail.suspend(); }
watch(() => props.request, request => { if (request) detail.open(request); }, { immediate: true });
watch(() => props.preloadArtwork, value => {
  if (value && !detailItem.value) detail.prepare(true);
});
watch(() => editing.value || previewShow.value || markShow.value, paused => {
  if (!paused && detailMotion.value.phase === 'open') detail.measureDetailSurface();
});
// Shared sheets also update the bar; restore the aggregate state after their watchers.
watch([detailItem, markShow], () => setTabBarHidden(!!detailItem.value || markShow.value), { flush: 'post' });
onScopeDispose(() => { alive = false; clearTimeout(wishTimer); });
onMounted(detail.prepare);
defineExpose({ close: closeDetail, suspend, prepare: detail.prepare, resize: detail.resize });
</script>

<template>
<view class="detail-layer" :class="{ 'is-hidden': !detailItem, 'is-preparing': preparing, 'is-closing': detailMotion.phase === 'closing' }">
      <view class="detail-backdrop" @tap="closeDetail" @touchmove.stop.prevent="blockScroll" />

      <view v-show="!editing" id="library-detail-motion" class="detail-motion-frame">
        <view class="detail-translater" :class="{ 'is-opening': detailMotion.animation && detailMotion.phase === 'opening', 'is-closing': detailMotion.animation && detailMotion.phase === 'closing' }" :style="detailTranslateStyle" :data-motion-token="detailMotion.animation?.token" @animationend="onDetailMotionEnd">
          <LibraryCardSurface ref="detailSurface" :phase="detailMotion.phase" :paused="preparing || detailTurning || editing || previewShow || markShow">
          <view class="detail-rotator" :class="{ 'is-flipping': detailFlipping, 'is-turning': detailTurning, 'is-back-visible': detailBackVisible }" :style="detailRotateStyle" @animationend="onPreparationEnd">
            <view class="detail-card-back" :style="{ opacity: detailBackVisible ? 1 : 0 }" @tap.stop="toggleDetailFace">
              <image v-if="cardBackground" class="detail-card-back__background" :src="cardBackground.src" mode="scaleToFill" />
              <view class="detail-card-back__copy" :class="{ 'is-light': cardBackground?.lightText }">
                <text class="detail-card-back__name">{{ detailItem?.name }}</text>
                <text class="detail-card-back__brand">{{ detailBrand }}</text>
              </view>
              <text class="detail-card-back__watermark">@袋袋集 · 2026</text>
            </view>
            <view class="detail-card" :style="{ opacity: detailBackVisible ? 0 : 1 }" @tap.stop="toggleDetailFace">

        <view class="detail-quick" data-surface-control="true">
          <view v-if="isWishDetail" class="detail-quick__btn" data-surface-control="true" hover-class="is-pressed" :hover-stay-time="80" @tap.stop="toggleDetailWish">
            <image class="detail-quick__icon like-icon" data-surface-control="true" :class="{ 'is-pop': wishPop, 'is-shrink': wishShrink }" src="/static/figma/heart-active.svg" mode="aspectFit" />
          </view>
          <view class="detail-quick__btn" data-surface-control="true" hover-class="is-pressed" :hover-stay-time="80" @tap.stop="markFromDetail">
            <image class="detail-quick__icon" data-surface-control="true" :src="isOwnedDetail ? '/static/figma/target-marked.svg' : '/static/figma/target.svg'" mode="aspectFit" />
          </view>
        </view>
        <view class="detail-glass">
          <view class="detail-glow" />
          <view class="detail-noise" />
          <view class="detail-beam-glow" />
          <view class="detail-beam" />
        </view>


        <scroll-view
          class="detail-scroll"
          :class="{ 'is-at-end': detailAtEnd }"
          scroll-y
          enhanced
          :show-scrollbar="false"
          @scroll="onDetailScroll"
          @tap.stop="toggleDetailFace"
        >

          <view v-if="hasBackImage" class="detail-sides" data-surface-control="true">
            <view class="detail-sides__pane" data-surface-control="true" @tap.stop="previewDetailArtwork('FRONT')">
              <view class="detail-sides__figure" data-surface-control="true">
                <image :src="detailFrontImage" mode="aspectFit" />
              </view>
            </view>
            <view class="detail-sides__divider" />
            <view class="detail-sides__pane" data-surface-control="true" @tap.stop="previewDetailArtwork('BACK')">
              <view class="detail-sides__figure" data-surface-control="true">
                <image :src="detailBackImage" mode="aspectFit" />
              </view>
            </view>
          </view>
          <view v-else class="detail-artwork" @tap.stop="previewDetailArtwork('FRONT')">
            <image v-if="detailArtwork || preloadArtwork" :src="detailArtwork || preloadArtwork" mode="aspectFit" @load="onArtworkLoad" />
            <view v-else class="detail-artwork__placeholder" />
          </view>


          <view>
            <text v-if="detailNo" class="detail-eyebrow">{{ detailNo }}</text>
            <text class="detail-name">{{ detailItem?.name }}</text>
            <text class="detail-brand">{{ isWishDetail ? (detailItem?.ownerName ?? '官方精选') : detailItem?.shelfName }}</text>
            <view class="detail-divider" />
            <view class="detail-facts">
              <view v-for="row in detailFacts" :key="row.label" class="detail-facts__row">
                <text class="detail-facts__key">{{ row.label }}</text>
                <text class="detail-facts__value">{{ row.value }}</text>
              </view>
            </view>
            <view v-if="detailTags.length" class="detail-tags">
              <text v-for="tag in detailTags" :key="tag"># {{ tag }}</text>
            </view>
            <text v-if="detailNote" class="detail-note">{{ detailNote }}</text>
            <text v-if="detailLoading && !detailTags.length && !detailNote" class="detail-loading">正在读取标签与备注…</text>
          </view>
        </scroll-view>


        <view class="detail-actions" data-surface-control="true" @tap.stop="blockScroll">
          <button v-if="!isWishDetail" class="detail-edit" data-surface-control="true" @tap.stop="startEdit()">编辑</button>
          <button class="detail-done" data-surface-control="true" @tap.stop="closeDetail">完成</button>
        </view>
            </view>

            <view v-if="detailBusy" class="detail-motion-hit" @tap.stop="detailTurning ? blockScroll() : closeDetail()" @touchmove.stop.prevent="blockScroll" />
          </view>
          </LibraryCardSurface>
        </view>
      </view>
    </view>


    <BagImagePreview :show="previewShow" :sides="previewSides" :fallback="detailData?.displayImageUrl ?? detailArtwork" :start-side="previewSide" @close="previewShow = false" />

    <mark-sheet :show="markShow" :item="markItem" :wished="true" @close="markShow = false" @saved="onMarkSaved" />
    <LibraryEditSheet v-if="editing && detailData" :item="detailData" :artwork="detailArtwork" :number="number" :shelves="shelves" :known-tag-counts="knownTagCounts" @saved="onSaved" @shelf-created="emit('shelfCreated', $event)" @cancel="closeDetail" @preview="previewDetailArtwork" />
</template>

<style scoped>
@keyframes library-detail-dismiss { from { opacity: 1; } to { opacity: 0; } }
.detail-layer { position: fixed; z-index: 950; top: 0; left: 0; right: 0; bottom: 0; }
.detail-layer.is-hidden { visibility: hidden; pointer-events: none; }
.detail-layer.is-hidden .detail-backdrop { animation: none; }
/* A sub-pixel-alpha pass prepares the real card layers without showing a sheet. */
.detail-layer.is-hidden.is-preparing { visibility: visible; opacity: .001; pointer-events: none; }
.detail-layer.is-preparing .detail-backdrop { visibility: hidden; }
.detail-layer.is-preparing .detail-translater { animation: library-card-prepare-enter 80ms linear both; }
.detail-layer.is-preparing .detail-rotator { animation: library-card-prepare-flip 80ms linear both; }
.detail-layer.is-preparing .detail-card { animation: library-card-prepare-front 80ms steps(1, end) both; }
.detail-layer.is-preparing .detail-card-back { animation: library-card-prepare-back 80ms steps(1, end) both; }
@keyframes library-card-prepare-enter {
  from { transform: translateZ(0) scale(.92); opacity: 1; }
  to { transform: translateZ(0) scale(1); opacity: 1; }
}
@keyframes library-card-prepare-flip {
  from { transform: rotateY(0deg); }
  to { transform: rotateY(360deg); }
}
@keyframes library-card-prepare-front {
  0%, 75%, 100% { opacity: 1; }
  25% { opacity: 0; }
}
@keyframes library-card-prepare-back {
  0%, 75%, 100% { opacity: 0; }
  25% { opacity: 1; }
}
.detail-layer.is-closing .detail-backdrop { animation: library-detail-dismiss .3s linear both; }
.detail-motion-frame { position: absolute; z-index: 1; top: 0; right: 0; bottom: 0; left: 0; width: 637rpx; height: 1023rpx; max-height: calc(100vh - 171rpx); margin: auto; perspective: 600px; }
.detail-translater, .detail-rotator { position: absolute; top: 0; right: 0; bottom: 0; left: 0; transform-origin: center; transform-style: preserve-3d; }
.detail-translater { will-change: transform, opacity; }
.detail-rotator { perspective: 600px; will-change: transform; }
.detail-translater.is-opening { animation: library-card-enter var(--card-motion-duration) cubic-bezier(.333333,1.216667,.666667,1) both, library-card-show var(--card-motion-duration) linear both; }
.detail-translater.is-closing { animation: library-card-retreat var(--card-motion-duration) cubic-bezier(.333333,0,.666667,.333333) both, library-card-hide var(--card-motion-duration) linear both; }
.detail-rotator.is-flipping { animation: library-card-flip var(--card-flip-duration) linear both; }
.detail-rotator.is-turning { animation: library-card-turn var(--card-flip-duration) linear both; }
.is-turning > .detail-card { animation: library-card-turn-front var(--card-flip-duration) steps(1, end) both; }
.is-turning > .detail-card-back { animation: library-card-turn-back var(--card-flip-duration) steps(1, end) both; }
.is-back-visible > .detail-card { pointer-events: none; }
.detail-rotator:not(.is-back-visible) > .detail-card-back { pointer-events: none; }
@keyframes library-card-turn {
  0% { transform: var(--card-turn-from); animation-timing-function: cubic-bezier(.333333,0,.666667,0); }
  50% { transform: var(--card-turn-mid); animation-timing-function: cubic-bezier(.333333,1,.666667,1); }
  100% { transform: var(--card-turn-to); }
}
@keyframes library-card-turn-front {
  0% { opacity: var(--card-front-from); }
  50%, 100% { opacity: var(--card-front-to); }
}
@keyframes library-card-turn-back {
  0% { opacity: var(--card-back-from); }
  50%, 100% { opacity: var(--card-back-to); }
}
/* Swap faces at the flip's 90/270-degree crossings in the view layer. */
.is-flipping > .detail-card { animation: library-card-front var(--card-flip-duration) steps(1, end) both; }
.is-flipping > .detail-card-back { animation: library-card-back var(--card-flip-duration) steps(1, end) both; }
@keyframes library-card-enter {
  from { transform: var(--card-motion-from); }
  to { transform: var(--card-motion-to); }
}
@keyframes library-card-retreat {
  from { transform: var(--card-motion-from); }
  to { transform: var(--card-motion-to); }
}
@keyframes library-card-show {
  0% { opacity: var(--card-opacity-from); }
  33.333%, 100% { opacity: var(--card-opacity-to); }
}
@keyframes library-card-hide {
  0% { opacity: var(--card-opacity-from); }
  80%, 100% { opacity: var(--card-opacity-to); }
}
@keyframes library-card-flip {
  0% { transform: rotateY(0deg); animation-timing-function: cubic-bezier(.333333,0,.666667,0); }
  50% { transform: rotateY(180deg); animation-timing-function: cubic-bezier(.333333,1,.666667,1); }
  100% { transform: rotateY(360deg); }
}
@keyframes library-card-front {
  0% { opacity: 1; }
  39.685% { opacity: 0; }
  60.315%, 100% { opacity: 1; }
}
@keyframes library-card-back {
  0% { opacity: 0; }
  39.685% { opacity: 1; }
  60.315%, 100% { opacity: 0; }
}
.detail-card { position: absolute; z-index: 2; top: 0; right: 0; bottom: 0; left: 0; width: 100%; height: 100%; box-sizing: border-box; overflow: hidden; border: 2rpx solid rgba(255,255,255,.38); border-radius: 55rpx; background: linear-gradient(160deg, #ffffff 0%, #fafbfd 56%, #f2f4f8 100%); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.95), inset 0 -2rpx 0 rgba(255,255,255,.34), inset 0 0 0 2rpx rgba(255,255,255,.72), inset 0 0 22rpx rgba(255,255,255,.55), 0 0 26rpx rgba(255,255,255,.28), 0 0 80rpx rgba(255,255,255,.14), 0 29rpx 65rpx rgba(52,66,92,.16), 0 5rpx 18rpx rgba(52,66,92,.07), 0 55rpx 145rpx rgba(0,0,0,.26); }
.detail-card-back { position: absolute; z-index: 1; top: 0; right: 0; bottom: 0; left: 0; box-sizing: border-box; overflow: hidden; border: 2rpx solid rgba(255,255,255,.4); border-radius: 55rpx; background: linear-gradient(160deg, #fbfbfd, #eef0f4); box-shadow: inset 0 0 0 14rpx rgba(255,255,255,.4), inset 0 0 22rpx rgba(255,255,255,.5), 0 0 26rpx rgba(255,255,255,.26), 0 0 80rpx rgba(255,255,255,.13), 0 29rpx 65rpx rgba(52,66,92,.16); transform: rotateY(180deg); }
.detail-card-back__background { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
.detail-card-back__copy { position: absolute; z-index: 1; top: 62%; right: 44rpx; bottom: 18%; left: 44rpx; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28rpx; }
.detail-card-back__name { color: #5592e6; font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: var(--wc-font-headline); font-weight: 600; line-height: 1.4; text-align: center; }
.detail-card-back__brand { color: #6f6a62; font-size: var(--wc-font-description); text-align: center; }
.detail-card-back__copy.is-light .detail-card-back__name { color: #fff; }
.detail-card-back__copy.is-light .detail-card-back__brand { color: rgba(255,255,255,.78); }
.detail-card-back__watermark { position: absolute; z-index: 1; right: 0; bottom: 60rpx; left: 0; color: #a48000; font-size: 20rpx; font-weight: 400; line-height: 1; text-align: center; pointer-events: none; }
.detail-motion-hit { position: absolute; z-index: 20; top: 0; right: 0; bottom: 0; left: 0; border-radius: 55rpx; }
@keyframes detail-fade { from { opacity: 0; } to { opacity: 1; } }
.detail-glass { position: absolute; z-index: 1; top: 0; left: 0; right: 0; bottom: 0; overflow: hidden; border-radius: 55rpx; pointer-events: none; }
.detail-glow { position: absolute; top: 0; left: 0; right: 0; bottom: 0; opacity: .85; background: radial-gradient(120% 78% at 16% -12%, rgba(255,255,255,.95) 0%, rgba(255,255,255,0) 58%), linear-gradient(128deg, rgba(255,255,255,.5) 0%, rgba(255,255,255,0) 34%, rgba(255,255,255,0) 66%, rgba(255,255,255,.34) 100%); }
.detail-noise { position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: .045; pointer-events: none; }
.detail-beam-glow { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: radial-gradient(96% 74% at 100% 0%, rgba(236,236,178,.26) 0%, rgba(236,236,178,.13) 29%, rgba(236,236,178,0) 58%); }
.detail-beam { position: absolute; top: 27rpx; right: 16rpx; left: 34%; height: 3rpx; border-radius: 4rpx; background: linear-gradient(90deg, rgba(255,236,190,0) 0%, rgba(255,246,220,.9) 58%, rgba(255,236,190,0) 100%); opacity: .26; }
/* 高度与按钮区(87+20)及上下边距(20/20)配平，恰好填满 1023rpx 卡片，按钮贴底不留空 */
.detail-scroll { position: relative; z-index: 3; width: 100%; height: 892rpx; max-height: calc(100vh - 320rpx); box-sizing: border-box; padding: 40rpx 44rpx 20rpx; -webkit-mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 20rpx), transparent 100%); mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 20rpx), transparent 100%); }
.detail-scroll.is-at-end { -webkit-mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 20rpx), transparent 100%); mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 20rpx), transparent 100%); }
.detail-scroll::-webkit-scrollbar, .detail-scroll ::-webkit-scrollbar { width: 0; height: 0; display: none; }
.detail-artwork { display: flex; align-items: center; justify-content: center; height: 306rpx; margin: 0 0 33rpx; padding: 18rpx; box-sizing: border-box; overflow: hidden; border-radius: 36rpx; }
.detail-artwork image { width: 100%; height: 269rpx; filter: drop-shadow(0 7rpx 18rpx rgba(0,0,0,.18)); }
.detail-artwork__placeholder { width: 234rpx; height: 269rpx; border-radius: 28rpx; background: rgba(20,20,20,.045); }
/* ── A/B 面并排展示（仅当存在 B 面图时）：左 A 面右 B 面，中间竖分隔线 ── */
.detail-sides { display: flex; align-items: stretch; margin: 0 0 18rpx; }
.detail-sides__pane { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; }
.detail-sides__divider { flex: 0 0 1rpx; align-self: stretch; margin: 10rpx 0; background: rgba(20,20,20,.1); }
.detail-sides__figure { display: flex; align-items: center; justify-content: center; width: 100%; height: 306rpx; }
.detail-sides__figure image { width: 100%; height: 100%; filter: drop-shadow(0 7rpx 18rpx rgba(0,0,0,.18)); }
.detail-eyebrow { display: block; margin-bottom: 7rpx; color: #77736d; font-size: var(--wc-font-footnote); font-weight: 700; line-height: 1.2; letter-spacing: 3rpx; }
.detail-name { display: block; color: #1d1a15; font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: var(--wc-font-headline); font-weight: 600; line-height: 1.2; }
.detail-brand { display: block; margin-top: 11rpx; color: #6f6a62; font-size: var(--wc-font-description); line-height: 1.4; }
.detail-divider { height: 1rpx; margin: 25rpx 0; background: linear-gradient(90deg, rgba(20,20,20,.12), rgba(20,20,20,.04) 70%, transparent); }
.detail-facts { display: flex; flex-direction: column; gap: 16rpx; }
.detail-facts__row { display: flex; align-items: baseline; justify-content: space-between; gap: 18rpx; }
.detail-facts__key { flex: 0 0 auto; color: #77736d; font-size: var(--wc-font-description); line-height: 1.4; letter-spacing: .6rpx; }
.detail-facts__value { flex: 0 1 auto; min-width: 0; color: #2b2720; font-size: var(--wc-font-description); font-weight: 600; line-height: 1.4; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail-tags { display: flex; flex-wrap: wrap; gap: 13rpx; margin-top: 29rpx; }
.detail-tags text { padding: 11rpx 22rpx; border-radius: 22rpx; background: rgba(20,20,20,.055); color: #5d594f; font-size: var(--wc-font-footnote); line-height: 1.2; }
.detail-note { display: block; margin-top: 27rpx; padding: 20rpx 24rpx; border-left: 4rpx solid rgba(20,20,20,.14); border-radius: 0 20rpx 20rpx 0; background: rgba(20,20,20,.035); color: #5f5b53; font-size: var(--wc-font-description); line-height: 1.6; white-space: pre-wrap; }
.detail-loading { display: block; margin-top: 27rpx; color: #77736d; font-size: var(--wc-font-footnote); line-height: 1.4; }
.detail-quick { position: absolute; z-index: 9; top: 22rpx; right: 22rpx; display: flex; gap: 14rpx; }
.detail-quick__btn { width: 60rpx; height: 60rpx; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(255,255,255,.88); transition: transform .18s ease; }
.detail-quick__btn.is-pressed { transform: scale(.88); }
.detail-quick__icon { width: 32rpx; height: 32rpx; }
.detail-actions { position: relative; z-index: 4; display: flex; gap: 18rpx; margin: 20rpx 44rpx 20rpx; }
.detail-edit, .detail-done, .detail-save { display: flex; align-items: center; justify-content: center; min-height: 87rpx; margin: 0; padding: 0; border-radius: 44rpx; font-size: var(--wc-font-description); font-weight: 700; line-height: 1.2; }
.detail-edit { flex: 0 0 175rpx; border: 2rpx solid rgba(20,20,20,.12); background: transparent; color: #141414; }
.detail-done, .detail-save { flex: 1 1 auto; border: 0; background: #141414; color: #ffffff; }
</style>

<style>
@import '../styles/edit-form.css';
@import '../styles/like-burst.css';
</style>
