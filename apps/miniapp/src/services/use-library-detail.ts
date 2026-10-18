import { computed, nextTick, onScopeDispose, ref, watch, type ComponentPublicInstance } from 'vue';
import type { Collectible, CollectibleSummary } from '../types';
import { dataService } from './data';
import { formattedDate, daysAgoText } from './format';
import { maskPageChrome } from './overlay';
import { createLibraryCardMotion, type CardMotionFrame, type CardRect } from './library-card-motion';
import { validSurfaceBounds, type LibraryCardSurfaceHandle } from './library-card-surface';
import { strokeRevision } from './stroke-preference';
import type { LibraryCardOpen } from './library-card-events';

interface DetailOptions {
  instance: ComponentPublicInstance | null | undefined;
  number: () => string;
  closed: () => void;
  loaded: (detail: Collectible) => void;
}
const cacheKey = (item: CollectibleSummary) => `${item.id}:${item.imageRevision ?? ''}:${item.updatedAt}:${strokeRevision()}`;

export function useLibraryDetail(options: DetailOptions) {
  const pageInstance = { proxy: options.instance };
  const editing = ref(false);
  const previewShow = ref(false);
  const preparing = ref(false);
  const sourceLayout = ref<LibraryCardOpen['layout']>('shelf');
  const isWishDetail = computed(() => sourceLayout.value === 'wish');
  const detailCache = new Map<string, Collectible>();
  let detailToken = 0;
  let alive = true;
  let pageActive = true;
  const detailAtEnd = ref(false);
  let detailClientHeight = 0;

  function onDetailScroll(event: { detail: { scrollTop: number; scrollHeight: number } }) {
    detailSurface.value?.notifyScroll?.();
    if (!detailClientHeight) return;
    detailAtEnd.value = event.detail.scrollHeight - event.detail.scrollTop - detailClientHeight <= 2;
  }

  function measureDetailScroll() {
    nextTick(() => {
      if (!alive) return;
      const query = uni.createSelectorQuery().in(pageInstance?.proxy);
      query.select('.detail-scroll').boundingClientRect();
      query.exec((rows) => {
        const rect = rows?.[0] as { height?: number } | null;
        if (alive && rect?.height) detailClientHeight = rect.height;
      });
    });
  }


  const detailItem = ref<CollectibleSummary | null>(null);
  const detailData = ref<Collectible | null>(null);
  const detailArtwork = ref('');
  const detailLoading = ref(false);
  const detailSurface = ref<LibraryCardSurfaceHandle | null>(null);
  const detailSurfaceBounds = ref<CardRect | null>(null);
  const detailMotion = ref<CardMotionFrame>({ phase: 'idle', x: 0, y: 0, scaleX: 1, scaleY: 1, angle: 0, opacity: 0 });
  let pendingDetail: { token: number; detail: Collectible } | null = null;
  let detailMeasureTimer: ReturnType<typeof setTimeout> | undefined;
  let detailOpeningToken: number | null = null;
  let destinationRect: CardRect | null = null;
  let destinationRevision = 0;
  let prepared = false;
  let preparationRevision = 0;
  let preparationTimer: ReturnType<typeof setTimeout> | undefined;

  function commitNativeView(callback: () => void) {
    const native = (options.instance as unknown as {
      $scope?: { setData: (data: Record<string, unknown>, callback: () => void) => void }
    } | null | undefined)?.$scope;
    if (native?.setData) native.setData({}, callback);
    else callback();
  }
  function cancelPreparation() {
    preparationRevision += 1;
    clearTimeout(preparationTimer);
    preparationTimer = undefined;
    preparing.value = false;
  }
  function finishPreparation() {
    if (!preparing.value || detailItem.value) return;
    prepared = true;
    cancelPreparation();
  }
  function warmup() {
    if (!alive || !pageActive || prepared || preparing.value || detailItem.value || detailMotion.value.phase !== 'idle') return;
    const revision = ++preparationRevision;
    preparing.value = true;
    // Bound the invisible preparation even if the native animation event is lost.
    preparationTimer = setTimeout(() => {
      if (alive && revision === preparationRevision) finishPreparation();
    }, 500);
    nextTick(() => {
      if (!alive || revision !== preparationRevision || !preparing.value) return;
      const committed = () => {
        if (!alive || revision !== preparationRevision || !preparing.value) return;
        clearTimeout(preparationTimer);
        preparationTimer = setTimeout(finishPreparation, 160);
      };
      try { commitNativeView(committed); }
      catch { committed(); }
    });
  }

  function prepare(refresh = false) {
    if (!refresh) pageActive = true;
    if (!alive || !pageActive) return;
    if (refresh && !detailItem.value) { prepared = false; cancelPreparation(); }
    warmup();
    const revision = ++destinationRevision;
    nextTick(() => {
      if (!alive || !pageActive || editing.value || revision !== destinationRevision) return;
      try {
        uni.createSelectorQuery().in(options.instance).select('#library-detail-motion')
          .boundingClientRect().exec(rows => {
            if (!alive || !pageActive || revision !== destinationRevision) return;
            const rect = (rows?.[0] as CardRect | null) ?? null;
            if (!validSurfaceBounds(rect)) return;
            destinationRect = rect;
            if (detailMotion.value.phase === 'open' && !editing.value) detailSurfaceBounds.value = rect;
          });
      } catch { /* Opening retains its scoped measurement when preparation is unavailable. */ }
    });
  }
  function resize() { destinationRect = null; prepare(true); }
  const cardMotion = createLibraryCardMotion((frame) => {
    detailMotion.value = frame;
    if (frame.phase === 'open' && !frame.animation && !detailSurfaceBounds.value) measureDetailSurface();
    if (frame.phase === 'open' && !frame.animation && pendingDetail) {
      const pending = pendingDetail;
      pendingDetail = null;
      if (pending.token === detailToken && detailItem.value?.id === pending.detail.id) applyLoadedDetail(pending.detail);
    }
  }, clearDetail);
  const detailTurning = computed(() => detailMotion.value.phase === 'open' && !!detailMotion.value.animation);
  const detailBusy = computed(() => detailMotion.value.phase !== 'open' || detailTurning.value);
  // 翻面切面：普通播放全在 WXSS，动画期间 frame.angle 停在起点 —— 靠 turnMidFlipped
  // 在动画中点（卡片≈90° 侧立）把显示面交给目标面。原先这套时机押在
  // @keyframes 内 var(--card-front/back-*) + steps(1,end) 上，真机渲染器对该组合
  // 支持不可靠：转过 90° 后正面以镜像形式露出，动画结束内联 opacity 接管时
  // 再跳变一次 —— 这就是翻面「割裂」的来源。CSS 侧另有 backface-visibility 兜底。
  const turnMidFlipped = ref(false);
  let turnMidTimer: ReturnType<typeof setTimeout> | undefined;
  const backAtAngle = (angle: number) => Math.cos(angle * Math.PI / 180) < 0;
  const detailBackVisible = computed(() => {
    const frame = detailMotion.value;
    const animation = frame.phase === 'open' ? frame.animation : undefined;
    if (animation) return turnMidFlipped.value ? backAtAngle(animation.to.angle) : backAtAngle(animation.from.angle);
    return backAtAngle(frame.angle);
  });
  watch(detailMotion, (frame) => {
    clearTimeout(turnMidTimer);
    turnMidTimer = undefined;
    const animation = frame.phase === 'open' ? frame.animation : undefined;
    if (!animation) { turnMidFlipped.value = false; return; }
    turnMidFlipped.value = false;
    turnMidTimer = setTimeout(() => {
      turnMidTimer = undefined;
      turnMidFlipped.value = true;
    }, animation.duration / 2);
  });
  const detailFlipping = computed(() => detailMotion.value.phase === 'opening' && detailMotion.value.animation?.to.angle === 360);
  function detailTransform(pose: Pick<CardMotionFrame, 'x' | 'y' | 'scaleX' | 'scaleY'>) {
    return `translate3d(${pose.x}px, ${pose.y}px, 0) scale(${pose.scaleX}, ${pose.scaleY})`;
  }
  const detailTranslateStyle = computed(() => {
    const frame = detailMotion.value;
    const motion = frame.animation;
    return {
      transform: detailTransform(frame),
      opacity: frame.opacity,
      '--card-motion-from': detailTransform(motion?.from ?? frame),
      '--card-motion-to': detailTransform(motion?.to ?? frame),
      '--card-opacity-from': String(motion?.from.opacity ?? frame.opacity),
      '--card-opacity-to': String(motion?.to.opacity ?? frame.opacity),
      '--card-motion-duration': `${motion?.duration ?? 0}ms`
    };
  });
  const detailRotateStyle = computed(() => {
    const frame = detailMotion.value;
    const from = frame.animation?.from.angle ?? frame.angle;
    const to = frame.animation?.to.angle ?? frame.angle;
    return {
      transform: `rotateY(${frame.angle}deg)`,
      '--card-flip-duration': `${frame.animation?.duration ?? 0}ms`,
      '--card-turn-from': `rotateY(${from}deg)`,
      '--card-turn-mid': `rotateY(${(from + to) / 2}deg)`,
      '--card-turn-to': `rotateY(${to}deg)`
    };
  });
  function measureDetailSurface() {
    const token = detailOpeningToken;
    nextTick(() => {
      if (token !== detailOpeningToken || detailMotion.value.phase !== 'open') return;
      try {
        const query = uni.createSelectorQuery().in(pageInstance?.proxy);
        query.select('#library-detail-motion').boundingClientRect();
        query.exec((rows) => {
          if (token !== detailOpeningToken || detailMotion.value.phase !== 'open') return;
          const bounds = (rows?.[0] as CardRect | null) ?? null;
          detailSurfaceBounds.value = validSurfaceBounds(bounds) ? bounds : null;
          if (detailSurfaceBounds.value) destinationRect = detailSurfaceBounds.value;
        });
      } catch { /* A temporarily unavailable native node must not interrupt the card. */ }
    });
  }
  const detailNo = computed(options.number);
  const detailTags = computed(() => detailData.value?.tags ?? []);
  const detailNote = computed(() => detailData.value?.notes?.trim() ?? '');
  const detailFacts = computed(() => {
    const item = detailItem.value;
    if (!item) return [];

    const wish = isWishDetail.value;
    return [
      { label: wish ? '上架日期' : '收藏日期', value: formattedDate(item.addedAt, '-') },
      { label: wish ? '上架天数' : '入库时长', value: daysAgoText(item.addedAt) },

      { label: '数量', value: !wish ? `×${item.quantity ?? 1}` : '' }
    ].filter((row) => row.value);
  });


  function applyLoadedDetail(detail: Collectible) {
    const officialChanged = !!detail.sourceOfficialBagId && detailItem.value?.imageRevision !== detail.imageRevision;
    detailData.value = detail;
    if (officialChanged) detailArtwork.value = detail.displayImageUrl || detail.thumbnailUrl || '';
    if (!detailArtwork.value) detailArtwork.value = detail.displayImageUrl || detail.thumbnailUrl || '';
    detailLoading.value = false;
    options.loaded(detail);
  }

  let pendingRequest: { key: string; promise: Promise<Collectible | null> } | undefined;
  function loadDetail(item: CollectibleSummary): Promise<Collectible | null> {
    const key = cacheKey(item);
    const cached = detailCache.get(key);
    if (cached && !item.sourceOfficialBagId) return Promise.resolve(cached);
    if (pendingRequest?.key === key) return pendingRequest.promise;
    const token = detailToken;
    const promise = (async () => {
      try {
        const detail = await dataService.collectible(item.id);
        if (!alive || token !== detailToken || detailItem.value?.id !== item.id) return null;
        detailCache.set(cacheKey(detail), detail);
        if (detailMotion.value.phase === 'open' && !detailMotion.value.animation) applyLoadedDetail(detail);
        else if (detailMotion.value.phase === 'measuring' || detailMotion.value.phase === 'opening' || detailTurning.value) pendingDetail = { token, detail };
        return detail;
      } catch (error) {
        if (alive && token === detailToken) {
          detailLoading.value = false;
          uni.showToast({ title: error instanceof Error ? error.message : '标签与备注加载失败', icon: 'none' });
        }
        return null;
      } finally { if (pendingRequest?.key === key && token === detailToken) pendingRequest = undefined; }
    })();
    pendingRequest = { key, promise };
    return promise;
  }

  function open(request: LibraryCardOpen) {
    if (!alive || !pageActive) return;
    const motionToken = cardMotion.prepare(request.item.id);
    if (motionToken === null) return;
    cancelPreparation();
    detailToken += 1;
    detailOpeningToken = motionToken;
    pendingRequest = undefined;
    sourceLayout.value = request.layout;
    detailSurfaceBounds.value = null;
    const cached = detailCache.get(cacheKey(request.item));
    detailItem.value = request.item;
    detailData.value = cached ?? null;
    detailArtwork.value = request.imageUrl || cached?.displayImageUrl || cached?.thumbnailUrl || '';
    detailLoading.value = !cached;
    editing.value = false;
    detailAtEnd.value = false;
    detailClientHeight = 0;
    maskPageChrome(true);
    const startMotion = (destination: CardRect | null) => {
      if (!alive || detailOpeningToken !== motionToken || detailMotion.value.phase !== 'measuring') return;
      clearTimeout(detailMeasureTimer);
      detailMeasureTimer = undefined;
      detailSurfaceBounds.value = validSurfaceBounds(destination) ? destination : null;
      if (detailSurfaceBounds.value) destinationRect = detailSurfaceBounds.value;
      cardMotion.open(motionToken, request.sourceRect, destination);
      prepared = true;
      measureDetailScroll();
      if (!cached || request.item.sourceOfficialBagId) void loadDetail(request.item);
      else options.loaded(cached);
    };
    detailMeasureTimer = setTimeout(() => startMotion(destinationRect), 200);
    nextTick(() => {
      if (!alive || detailOpeningToken !== motionToken || detailMotion.value.phase !== 'measuring') return;
      try {
        if (destinationRect) {
          // Vue's flush submits native setData; its callback establishes the
          // initial pose before adding the animation class in a separate update.
          commitNativeView(() => startMotion(destinationRect));
          return;
        }
        uni.createSelectorQuery().in(options.instance).select('#library-detail-motion')
          .boundingClientRect().exec(rows => startMotion((rows?.[0] as CardRect | null) ?? null));
      } catch { startMotion(null); }
    });
  }

  function closeDetail(immediate = false) {
    try { detailSurface.value?.freeze?.(); }
    catch (error) { console.warn('detail surface freeze failed', error); }
    clearTimeout(detailMeasureTimer);
    detailMeasureTimer = undefined;
    detailToken += 1;
    pendingRequest = undefined;
    previewShow.value = false;
    cardMotion.close(immediate || editing.value);
  }
  function clearDetail() {
    const hadDetail = !!detailItem.value;
    pendingDetail = null;
    detailOpeningToken = null;
    clearTimeout(detailMeasureTimer);
    detailMeasureTimer = undefined;
    detailToken += 1;
    detailItem.value = null;
    detailSurfaceBounds.value = null;
    detailData.value = null;
    detailArtwork.value = '';
    detailLoading.value = false;
    previewShow.value = editing.value = false;
    if (hadDetail) { maskPageChrome(false, 0); options.closed(); }
  }
  function toggleDetailFace() {
    if (detailBusy.value || editing.value || previewShow.value || !detailItem.value) return;
    cardMotion.flip();
  }
  function onDetailMotionEnd(event: Event) {
    const value = event as unknown as { detail?: { animationName?: string }; animationName?: string;
      currentTarget?: { dataset?: { motionToken?: number | string } } };
    const name = value.detail?.animationName ?? value.animationName ?? '';
    if (!name.startsWith('library-card-retreat')) return;
    const token = Number(value.currentTarget?.dataset?.motionToken);
    if (Number.isFinite(token)) cardMotion.finishClosing(token);
  }
  const previewSide = ref<'FRONT' | 'BACK'>('FRONT');
  function previewDetailArtwork(side: 'FRONT' | 'BACK' = 'FRONT') {
    if (detailBusy.value) return;
    const sideUrl = side === 'BACK'
      ? (detailData.value?.sides?.BACK?.displayImageUrl ?? detailItem.value?.backThumbnailUrl)
      : detailData.value?.sides?.FRONT?.displayImageUrl;
    const url = sideUrl || detailArtwork.value;
    if (!url) return;
    previewSide.value = side;
    previewShow.value = true;
  }
  async function startEdit() {
    if (isWishDetail.value || detailBusy.value) return;
    const item = detailItem.value;
    if (!item) return;
    const detail = detailData.value ?? await loadDetail(item);
    if (!alive || detailItem.value?.id !== item.id || detailBusy.value) return;
    if (!detail) return void uni.showToast({ title: '标签与备注还没读出来，稍后再试', icon: 'none' });
    // Editing always starts from full data, never from a summary with missing tags.
    detailData.value = detail;
    editing.value = true;
  }
  function acceptUpdated(updated: Collectible) {
    if (detailItem.value) detailCache.delete(cacheKey(detailItem.value));
    detailCache.set(cacheKey(updated), updated);
    detailItem.value = updated;
    detailData.value = updated;
  }
  function suspend() {
    pageActive = false;
    prepared = false;
    cancelPreparation();
    detailSurface.value?.suspend?.(); closeDetail(true);
  }
  onScopeDispose(() => {
    alive = false; pageActive = false; detailToken += 1;
    cancelPreparation();
    clearTimeout(turnMidTimer);
    detailSurface.value?.suspend?.();
    cardMotion.destroy(); clearTimeout(detailMeasureTimer);
    if (detailItem.value) maskPageChrome(false, 0);
  });
  return { detailItem, detailData, detailArtwork, detailLoading, detailSurface, detailSurfaceBounds,
    detailMotion, detailBusy, detailBackVisible, detailFlipping, detailTurning, detailTranslateStyle, detailRotateStyle,
    detailNo, detailTags, detailNote, detailFacts, detailAtEnd, editing, previewShow, previewSide, preparing, isWishDetail,
    open, prepare, resize, finishPreparation, closeDetail, toggleDetailFace, onDetailMotionEnd, onDetailScroll, measureDetailSurface,
    previewDetailArtwork, startEdit, acceptUpdated, suspend };
}
