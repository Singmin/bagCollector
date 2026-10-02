<script setup lang="ts">
import { computed, ref } from 'vue';
import { onHide, onShow, onShareAppMessage, onShareTimeline } from '@dcloudio/uni-app';
import type { Collectible, CollectibleSummary, Shelf } from '../../types';
import { dataService } from '../../services/data';
import { daysAgoText, formattedDate } from '../../services/format';
import { resolveCollectibleThumbnail } from '../../services/images';
import { syncTabBar, setTabBarHidden } from '../../services/tab-bar';

const loading = ref(true);
const initialized = ref(false);
const refreshing = ref(false);
const loadError = ref('');
/* 发现页数据源 = 官方精选 feed（别人的纸袋，带 ownerName 与完整标签/备注） */
const items = ref<Collectible[]>([]);
const totalCount = ref(0);
/* 精选上新：一次取到后端上限 100 条，不再按小页分页展示（后端 limit 允许 1~100）。
   官方袋子超过 100 条时，游标翻页仍会继续追加剩余（loadMore / scrolltolower 保留作兜底）。
   翻页只追加不清空，避免主展位跳回第一张。后端 feed 支持 cursor 游标翻页。 */
const FEED_PAGE_SIZE = 100;
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);
const hasMore = computed(() => Boolean(nextCursor.value));
const thumbnailUrls = ref<Record<string, string>>({});
const failedThumbnails = ref<Record<string, boolean>>({});
/* 心愿袋：已在心愿袋的纸袋 id 集合 */
const wishlistIds = ref<Set<string>>(new Set());
/* 已「标记已有」的 feed 条目 → 创建的收藏 id（本页内存态）：标记与心愿互斥；
   再次点击「标记已有」时凭收藏 id 弹删除确认，可撤回标记。
   用普通对象而非 Map —— 小程序端对象属性的响应式最可靠，模板里可直接取用判断图标态 */
const markedMap = ref<Record<string, string>>({});

/* 自定义导航（与全部收藏页同一套对齐方式）：
   标题顶部 = 胶囊按钮顶部；设置钮在头部文档流内，与标题块垂直居中。 */
const headerTop = ref(0);
// #ifdef MP-WEIXIN
try {
  const capsule = uni.getMenuButtonBoundingClientRect();
  headerTop.value = capsule.top;
} catch {
  /* 取不到胶囊矩形（非微信端）时用默认值 */
}
// #endif

// ── 主展位：对齐 H5 的 .flip-card（轻点 3D 翻面）──
// 卡片由「最近收集」里选中的那一张驱动，默认是最新的一张。
// 背面要展示标签与备注，而列表接口只返回摘要，所以选中后补拉一次详情；
// 拉失败就让背面省略标签/备注（正面照常可用），不打断首页。
const heroItem = ref<Collectible | null>(null);
const heroDetail = ref<Collectible | null>(null);
const flipped = ref(false);
const detailCache = new Map<string, Collectible>();

const heroTags = computed(() => heroDetail.value?.tags ?? []);
/* 今日上新件数：addedAt 是今天的 feed 条目数 */
const todayCount = computed(() => items.value.filter(isTodayNew).length);
/* 今日上新判定：addedAt 是今天 → 挂卡左下角挂 NEW 角标 */
function isTodayNew(item: Collectible) {
  return new Date(item.addedAt).toDateString() === new Date().toDateString();
}
const heroNote = computed(() => heroDetail.value?.notes?.trim() ?? '');

/* 编号：对齐 H5 背面的 NO.001。后端没有 no 字段，用「总数 − 倒序下标」倒推
   （列表按 addedAt desc 返回，最新的一张编号最大）。删除收藏会让后续编号前移，
   这点与 H5 写死编号不同 —— 等后端补上 no 字段后应改为直接读字段。 */
const heroNo = computed(() => {
  const item = heroItem.value;
  if (!item || !totalCount.value) return '';
  const index = items.value.findIndex((current) => current.id === item.id);
  if (index < 0) return '';
  return `NO.${String(Math.max(1, totalCount.value - index)).padStart(3, '0')}`;
});

const heroFacts = computed(() => {
  const item = heroItem.value;
  if (!item) return [];
  return [
    { label: '品牌 / 店铺', value: item.ownerName ?? '官方精选' },
    { label: '上架日期', value: formattedDate(item.addedAt).replace(/\//g, '-') },
    { label: '编号', value: heroNo.value }
  ].filter((row) => row.value);
});

// ── 挂袋区（1:1 复刻 挂袋区_轻量调试.html：亚克力横杆 + 滑环 + 喷砂哑光夹具 + 磨砂玻璃卡框）──
// 横杆是刚性直杆（不再下垂），卡片垂距是静态错落 0/7/14/7px（→ rpx ×1.82）；
// 轮心 = 杆心 44.02px = 80rpx，咬口 7.5px = 14rpx，卡宽 106px = 193rpx，重叠 12px = 22rpx。
const RACK_DY = [0, 13, 25, 13] as const;

/* ── 挂袋区虚拟列表 ──
   卡宽 --rack-card-w 160rpx、相邻重叠 --rack-overlap 20rpx → 水平步进恒为 140rpx，
   于是第 i 张的 left 可精确推算为 i × 140rpx，具备做虚拟列表的前提。
   只渲染视口附近若干张（前后各留 VIRTUAL_BUFFER 张缓冲），两侧用占位撑起总宽度，
   避免一次渲染上百个「悬挂动画 + 图片」的卡片节点拖垮首屏与滚动帧率。
   ⚠ stepPx 依赖屏幕宽度，必须在 setup 期间用 getSystemInfoSync 取准。 */
const CARD_STEP_RPX = 140; // --rack-card-w(160) − --rack-overlap(20)
const VIRTUAL_BUFFER = 3;
const railWindowWidth = uni.getSystemInfoSync().windowWidth || 375;
const stepPx = (CARD_STEP_RPX * railWindowWidth) / 750;
const visibleCount = Math.ceil(railWindowWidth / stepPx) + 2;
const visibleStart = ref(0);
const visibleEnd = ref(visibleCount + VIRTUAL_BUFFER);

function updateVisibleRange(scrollLeft: number) {
  const start = Math.max(0, Math.floor(scrollLeft / stepPx) - VIRTUAL_BUFFER);
  visibleStart.value = start;
  visibleEnd.value = Math.min(items.value.length, start + visibleCount + VIRTUAL_BUFFER * 2);
}

/* 渲染窗口内的卡片，并携带原始 index —— 悬挂错落（RACK_DY）与轻晃动画延迟都按原索引取，
   若改用窗口内的偏移索引，窗口滑动时整排的错落节奏会跟着乱跳。 */
const visibleSlots = computed(() =>
  items.value.slice(visibleStart.value, visibleEnd.value).map((item, offset) => ({ item, index: visibleStart.value + offset }))
);
/* 两侧占位宽度：撑住 scroll-view 的总宽，保证滚动条长度与位置和不做虚拟列表时一致 */
const leadSpace = computed(() => visibleStart.value * CARD_STEP_RPX);
const tailSpace = computed(() => Math.max(0, items.value.length - visibleEnd.value) * CARD_STEP_RPX);

function shortDate(value: string) { return formattedDate(value).slice(5).replace('/', '.'); }
function isHero(item: CollectibleSummary) { return heroItem.value?.id === item.id; }
function openLibrary() { uni.switchTab({ url: '/pages/library/index' }); }
let refreshPromise: Promise<void> | undefined;

function assertRenderable(nextItems: CollectibleSummary[]) {
  for (const item of nextItems) {
    if (Number.isNaN(new Date(item.addedAt).getTime())) throw new Error(`收藏“${item.name}”的日期无效`);
  }
}

function hydrateThumbnails(nextItems: Collectible[]) {
  for (const item of nextItems) {
    void resolveCollectibleThumbnail(item).then((url) => {
      if (!url || !items.value.some((current) => current.id === item.id && current.updatedAt === item.updatedAt)) return;
      thumbnailUrls.value[item.id] = url;
      delete failedThumbnails.value[item.id];
    }).catch(() => {
      failedThumbnails.value[item.id] = true;
    });
  }
}

function load() {
  if (refreshPromise) return refreshPromise;
  if (initialized.value) refreshing.value = true;
  else loading.value = true;
  loadError.value = '';
  refreshPromise = (async () => {
    try {
      /* feed = 官方精选纸袋上新；心愿袋状态一并拉取（标记/取消心愿后要保持同步） */
      const [page, wish] = await Promise.all([dataService.feed(`limit=${FEED_PAGE_SIZE}`), dataService.wishlist()]);
      assertRenderable(page.items);
      /* feed 接口声明返回摘要，但后端实际带完整字段（见下方 selectHero 注释），
         这里统一按完整条目使用 —— 与旧的逐处 as 转换等价，只收敛到一个出口。 */
      const feedItems = page.items as unknown as Collectible[];
      items.value = feedItems;
      totalCount.value = page.totalCount;
      nextCursor.value = page.nextCursor;
      updateVisibleRange(0); // 首屏数据到位后立即建立渲染窗口
      initialized.value = true;
      wishlistIds.value = new Set(wish.map((item) => item.id));
      hydrateThumbnails(feedItems);
      // 刷新后沿用当前选中的那一张，它不在列表里才退回最新一张。
      const kept = feedItems.find((item) => item.id === heroItem.value?.id);
      if (kept) heroItem.value = kept;
      else selectHero(feedItems[0] ?? null);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : '发现加载失败';
      if (initialized.value) uni.showToast({ title: message, icon: 'none' });
      else loadError.value = message;
    } finally {
      loading.value = false;
      refreshing.value = false;
    }
  })().finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}

/* 滑到挂袋区末尾自动加载下一页：只追加到列表尾部，不动主展位（避免翻页时主卡跳回第一张）。
   cursor 来自上一页响应，为空即已到末页；连续触发由 loadingMore 拦住，失败只提示不清空列表。 */
async function loadMore() {
  if (loadingMore.value || !nextCursor.value) return;
  loadingMore.value = true;
  try {
    const page = await dataService.feed(`limit=${FEED_PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor.value)}`);
    assertRenderable(page.items);
    const appended = page.items as unknown as Collectible[];
    /* 去重兜底：并发刷新时后端可能返回列表里已有的条目 */
    const known = new Set(items.value.map((item) => item.id));
    const fresh = appended.filter((item) => !known.has(item.id));
    if (fresh.length) {
      items.value = [...items.value, ...fresh];
      hydrateThumbnails(fresh);
    }
    nextCursor.value = page.nextCursor;
    updateVisibleRange(railLastLeft); // 追加后按当前滚动位置重算窗口
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '加载更多失败', icon: 'none' });
  } finally {
    loadingMore.value = false;
  }
}

/* 日期与「入库时长」已抽到 services/format.ts（formattedDate / daysAgoText），
   与「全部收藏」的详情卡共用同一口径，别在这页再写一份。 */

/* 选中某一张作为主展位展品：先翻回正面。feed 返回的就是完整条目，无需补拉。 */
function selectHero(item: Collectible | null) {
  heroItem.value = item;
  flipped.value = false;
  heroDetail.value = item;
}

/* 轻点挂袋：照 H5 的 pointerup「轻点」分支 —— 先给这张一个摆动冲量（"先荡一下"），
   再把内容送到上方主卡位，而不是直接进详情。
   同一张要能连点重播：先把类摘掉、下一拍再挂上，否则动画不会重新开始。 */
const kickedId = ref('');
let kickTimer: ReturnType<typeof setTimeout> | undefined;
let kickClearTimer: ReturnType<typeof setTimeout> | undefined;

function pickItem(item: Collectible) {
  selectHero(item);
  if (kickTimer) clearTimeout(kickTimer);
  if (kickClearTimer) clearTimeout(kickClearTimer);
  kickedId.value = '';
  kickTimer = setTimeout(() => {
    kickedId.value = item.id;
    kickClearTimer = setTimeout(() => { kickedId.value = ''; }, 2000);
  }, 20);
}

/* ── 心愿袋：加入 / 取消（同一按钮再点一次即取消；官方精选只支持取消心愿）──
   wishToggling：请求在途时忽略再次点击，防止连点竞态导致本地集合与服务端错位 */
let wishToggling = false;
function isWished(id: string) { return wishlistIds.value.has(id); }

async function toggleWish(item: Collectible) {
  /* 互斥：已标记已有的纸袋不能再进心愿袋（文案压到 9 字，微信 toast 一行放得下） */
  if (markedMap.value[item.id]) return void uni.showToast({ title: '已标记，无需心愿袋', icon: 'none' });
  if (wishToggling) return;
  wishToggling = true;
  try {
    if (wishlistIds.value.has(item.id)) {
      await dataService.removeWishlist(item.id);
      const next = new Set(wishlistIds.value);
      next.delete(item.id);
      wishlistIds.value = next;
      uni.showToast({ title: '已移出心愿袋', icon: 'none' });
    } else {
      await dataService.addWishlist(item.id);
      wishlistIds.value = new Set(wishlistIds.value).add(item.id);
      uni.showToast({ title: '已加入心愿袋', icon: 'none' });
    }
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '操作失败', icon: 'none' });
  } finally {
    wishToggling = false;
  }
}

/* ── 标记已有（方案 A：先编辑后入库）──
   点击只打开半窗预填 feed 信息，点「收进收藏」时才真正创建 ——
   取消/关闭不产生任何数据（旧版先 create 再核对，取消会留下默认信息的脏数据） */
/* 标记已有：统一拉起共享 mark-sheet 半窗（components/mark-sheet），本页只管状态与本地同步 */
const markShow = ref(false);
const markItem = ref<Collectible | null>(null);
function openMark(item: Collectible) {
  /* 已标记 → 弹删除确认，可撤回标记（撤回后靶心图标同步回到未标记态） */
  const createdId = markedMap.value[item.id];
  if (createdId) {
    return void uni.showModal({
      title: '删除这条收藏？',
      content: `将从收藏架删除「${item.name}」的记录。`,
      confirmText: '删除',
      confirmColor: '#9d3d36',
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await dataService.removeCollectible(createdId);
          delete markedMap.value[item.id];
          uni.showToast({ title: '已从收藏架移除', icon: 'none' });
        } catch (error) {
          uni.showToast({ title: error instanceof Error ? error.message : '移除失败', icon: 'none' });
        }
      }
    });
  }
  markItem.value = item;
  markShow.value = true;
}
function closeMark() {
  markShow.value = false;
}
function onMarkSaved(source: Collectible, createdId: string) {
  /* 组件已落库并（如在心愿袋）自动移出；这里同步本地互斥与心愿状态 */
  markedMap.value[source.id] = createdId;
  if (wishlistIds.value.has(source.id)) {
    const next = new Set(wishlistIds.value);
    next.delete(source.id);
    wishlistIds.value = next;
  }
}

/* ── 拖动这一排时挂袋的滞后摆动 ──
   小程序里「按住卡片拖动」＝「横向滚动」（手势分不开），所以摆动跟着滚动走：
   挂点被拉动、袋子因惯性往反方向甩（往右拖 → 袋身往左偏），停下后按弹簧曲线弹回。
   倾角 = −滚动速度 × 系数，幅度上限 12°。
   · 为什么不是 H5 的「抓住单张卡片转 ±75°」：H5 的一排卡片已铺满、不需要横向滚动，
     手势可以整块让给卡片；我们最多 9 张必须能滑，所以只做「滚动带出来的摆动」。
   · 滚动事件按帧触发，这里节流到每 80ms 才更新一次倾角（靠 CSS transition 抹平台阶），
     避免每帧 setData。手感要调就改 TILT_PER_SPEED（幅度）与 releaseRail 里的回弹时长。 */
const TILT_PER_SPEED = 6;
const TILT_MAX = 12;
const railTilt = ref(0);
const railReleasing = ref(false);
let railLastLeft = 0;
let railLastAt = 0;
let railIdleTimer: ReturnType<typeof setTimeout> | undefined;
let railReleaseTimer: ReturnType<typeof setTimeout> | undefined;

function onRailScroll(event: Event) {
  const scrollLeft = (event as unknown as { detail?: { scrollLeft?: number } }).detail?.scrollLeft ?? 0;
  /* 虚拟列表窗口要每帧跟随（必须放在下面的 80ms 节流之前），否则快速滑动时会露出空白缺口 */
  updateVisibleRange(scrollLeft);
  const now = Date.now();
  const elapsed = now - railLastAt;
  if (railLastAt && elapsed < 80) return;
  if (railLastAt) {
    const speed = (scrollLeft - railLastLeft) / Math.max(1, elapsed); // px/ms
    const tilt = -speed * TILT_PER_SPEED;
    railReleasing.value = false;
    railTilt.value = Math.max(-TILT_MAX, Math.min(TILT_MAX, tilt));
  }
  railLastLeft = scrollLeft;
  railLastAt = now;
  if (railIdleTimer) clearTimeout(railIdleTimer);
  railIdleTimer = setTimeout(releaseRail, 120);
}

/* 松手（滚动停下）：归零并切成带回弹的曲线，弹一下再落回常态。
   摆动交给 CSS 曲线而不是自己跑动画循环 —— 小程序端 60fps setData 代价太高。 */
function releaseRail() {
  railLastAt = 0;
  railReleasing.value = true;
  railTilt.value = 0;
  if (railReleaseTimer) clearTimeout(railReleaseTimer);
  railReleaseTimer = setTimeout(() => { railReleasing.value = false; }, 700);
}

function toggleFlip() {
  if (!heroItem.value) return;
  flipped.value = !flipped.value;
}

function add() {
  uni.navigateTo({ url: '/package-editor/pages/add/index' });
}

onShow(() => {
  syncTabBar(0);
  void load();
});
/* 切走页面时收起设置半窗（settingsShow 是普通数据，不会随页面隐藏自动归位）。
   半窗开着就等于底栏整条隐藏被推上去过，人回来了半窗还压着、底栏却已经复位，
   会露一条底栏在面板底下 —— 半窗收起时会自行把底栏还原，这里关掉最省事。 */
onHide(() => {
  if (markShow.value) { markShow.value = false; setTabBarHidden(false); }
});
/* 分享：转发给朋友 / 分享到朋友圈（封面用袋子图，5:4 内自动裁切） */
onShareAppMessage(() => ({
  title: '袋袋集 · 收集每一个纸袋的故事',
  path: '/pages/showcase/index'
}));
onShareTimeline(() => ({
  title: '袋袋集 · 收集每一个纸袋的故事',
  query: ''
}));
/* 顶部标题区固定后，下拉刷新迁移到内容区 scroll-view */
const refresherTriggered = ref(false);
async function onRefresherRefresh() {
  refresherTriggered.value = true;
  try { await load(); } finally { refresherTriggered.value = false; }
}
</script>

<template>
  <view class="home-page">
    <!-- 头部：与全部收藏页同一套对齐（标题顶 = 胶囊顶，padding-top 由胶囊矩形注入）。
         设置入口已迁至「我的」页头部右上角（2026-09-29） -->
    <view class="bags-header" :style="{ paddingTop: `${headerTop}px` }">
      <view class="bags-header__text">
        <text class="bags-title">袋袋集</text>
        <text class="bags-tagline">收集每一个纸袋的故事</text>
      </view>
    </view>

    <scroll-view
      class="home-scroll"
      scroll-y
      :refresher-enabled="true"
      :refresher-triggered="refresherTriggered"
      refresher-default-style="black"
      @refresherrefresh="onRefresherRefresh"
    >
      <view class="home-body">
    <view v-if="loadError" class="load-error">{{ loadError }}</view>

    <!-- 主展位：轻点卡片 3D 翻面，正面看袋子，背面看详细信息 -->
    <view class="stage-section">
      <view v-if="loading && !initialized" class="flip-card skeleton-card">
        <view class="skeleton-art" />
        <view class="skeleton-line skeleton-line--wide" />
        <view class="skeleton-line" />
      </view>

      <view v-else-if="heroItem && !loadError" class="flip-card" :class="{ 'is-flipped': flipped }">
        <view class="flip-card__hit" @tap="toggleFlip" />

        <!-- 右上角固定快捷操作（仅正面显示；背面有同功能的文字按钮，不重复）：
             心形 = 加入/移出心愿袋（实心红 = 已在），靶心 = 标记已有 -->
        <view v-if="!flipped" class="hero-quick">
          <view class="hero-quick__btn" hover-class="is-pressed" :hover-stay-time="80" @tap.stop="toggleWish(heroItem)">
            <image class="hero-quick__icon" :src="isWished(heroItem.id) ? '/static/figma/heart-active.svg' : '/static/figma/heart.svg'" mode="aspectFit" />
          </view>
          <view class="hero-quick__btn" hover-class="is-pressed" :hover-stay-time="80" @tap.stop="openMark(heroItem)">
            <image class="hero-quick__icon" :src="markedMap[heroItem.id] ? '/static/figma/target-marked.svg' : '/static/figma/target.svg'" mode="aspectFit" />
          </view>
        </view>

        <view class="flip-face flip-face--front">
          <image class="frame85-background" src="/static/figma/indexBg.svg" mode="scaleToFill" />
          <view class="glass-glow" />
          <view class="corner-glow" />

          <view class="flip-face__art">
            <image
              v-if="thumbnailUrls[heroItem.id] && !failedThumbnails[heroItem.id]"
              :src="thumbnailUrls[heroItem.id]"
              mode="aspectFit"
              @error="failedThumbnails[heroItem.id] = true"
            />
            <view v-else class="art-placeholder" />
          </view>

          <view class="front-caption">
            <text class="front-caption__title">{{ heroItem.name }}</text>
            <view class="front-caption__sub">
              <text class="front-caption__part">{{ heroItem.ownerName ?? '官方精选' }}</text>
              <view class="front-caption__dot" />
              <text class="front-caption__part front-caption__part--fixed">{{ formattedDate(heroItem.addedAt) }}</text>
            </view>
          </view>

          <text class="flip-hint">轻点翻面 · 查看详情</text>
        </view>

        <view class="flip-face flip-face--back" @tap="toggleFlip">
          <image class="frame85-background" src="/static/figma/indexBg.svg" mode="scaleToFill" />
          <view class="glass-glow" />
          <view class="corner-glow" />

          <!-- 背面内容超出卡片高度时，在卡内上下滚动。
               ⚠ enhanced 必须开：show-scrollbar 是「增强特性属性」，只在 enhanced 为 true 时生效，
               只写 show-scrollbar="false" 卡片右侧仍会冒出一条竖向滚动条（与详情页 detail-scroll 同坑）。
               不加 @tap.stop —— 点击背面（非按钮区）仍需冒泡到 flip-face--back 翻回正面 -->
          <scroll-view class="back-scroll" scroll-y enhanced :show-scrollbar="false">
            <view class="back-inner">
              <text v-if="heroNo" class="back-eyebrow">{{ heroNo }}</text>
              <text class="back-name">{{ heroItem.name }}</text>
              <text class="back-brand">{{ heroItem.ownerName ?? '官方精选' }}</text>
              <view class="back-divider" />
              <view class="back-facts">
                <view v-for="row in heroFacts" :key="row.label" class="back-facts__row">
                  <text class="back-facts__key">{{ row.label }}</text>
                  <text class="back-facts__value">{{ row.value }}</text>
                </view>
              </view>
              <view v-if="heroTags.length" class="back-tags">
                <text v-for="tag in heroTags" :key="tag"># {{ tag }}</text>
              </view>
              <text v-if="heroNote" class="back-note">{{ heroNote }}</text>
              <!-- 发现页操作：加入/取消心愿袋 + 标记已有（收进我的收藏并核对信息） -->
              <view class="back-actions">
                <button class="back-action" :class="{ 'is-on': isWished(heroItem.id) }" @tap.stop="toggleWish(heroItem)">
                  <image class="back-action__icon" :src="isWished(heroItem.id) ? '/static/figma/heart-active.svg' : '/static/figma/heart.svg'" mode="aspectFit" />
                  <text>{{ isWished(heroItem.id) ? '已在心愿袋' : '加入心愿袋' }}</text>
                </button>
                <button class="back-action" :class="{ 'back-action--primary': !markedMap[heroItem.id] }" @tap.stop="openMark(heroItem)">
                  <image class="back-action__icon" :src="markedMap[heroItem.id] ? '/static/figma/target-marked.svg' : '/static/figma/target-white.svg'" mode="aspectFit" />
                  <text>{{ markedMap[heroItem.id] ? '已拥有' : '标记已有' }}</text>
                </button>
              </view>
            </view>
          </scroll-view>
        </view>
      </view>

      <view v-else-if="!loading && !loadError" class="flip-card empty-card" @tap="add">
        <image class="frame85-background" src="/static/figma/indexBg.svg" mode="scaleToFill" />
        <image class="empty-illustration" src="/static/figma/empty-state.png" mode="aspectFit" />
        <view class="front-caption empty-caption">
          <text class="front-caption__title">暂无纸袋记录</text>
          <text class="front-caption__hint">每一个纸袋都有故事，期待你的记录</text>
        </view>
      </view>
    </view>

    <view v-if="items.length && !loadError" class="recent-section">
      <view class="recent-heading">
        <text class="recent-title">精选上新</text>
      </view>
      <view class="recent-sub">
        <text class="stage-count">今日上新 · {{ todayCount }} 件</text>
        <button class="recent-all" @tap="openLibrary">我的收藏架 <image class="recent-all-arrow" src="/static/figma/arrow-right.svg" mode="aspectFit" /></button>
      </view>
      <!-- 滑到最右端自动加载下一页（游标翻页，只追加不清空） -->
      <scroll-view class="recent-scroll" scroll-x :show-scrollbar="false" @scroll="onRailScroll" @scrolltolower="loadMore">
        <view class="recent-scene">
          <!-- 亚克力展示杆：半透杆身 + 两端银钢夹块 + 外伸螺纹杆 + 朱红圆球头 -->
          <view class="rack-cable" aria-hidden="true">
            <view class="rack-rail" />
            <view class="rack-stud rack-stud--l" />
            <view class="rack-stud rack-stud--r" />
            <view class="rack-endcap rack-endcap--l" />
            <view class="rack-endcap rack-endcap--r" />
            <view class="rack-knob rack-knob--l" />
            <view class="rack-knob rack-knob--r" />
          </view>
          <view class="recent-row">
            <!-- 虚拟列表左占位：撑出窗口之前那些卡片的宽度，保证滚动位置与总长不变 -->
            <view v-if="leadSpace" class="rail-spacer" :style="{ width: `${leadSpace}rpx` }" />
            <button
              v-for="slot in visibleSlots"
              :key="slot.item.id"
              class="recent-item"
              :class="{ 'is-active': isHero(slot.item) }"
              @tap="pickItem(slot.item)"
            >
              <view
                class="rail-hang"
                :class="[slot.index % 2 === 0 ? 'hang-tilt-right' : 'hang-tilt-left', kickedId === slot.item.id ? 'is-kicking' : '']"
                :style="{ animationDelay: `${(slot.index % 4) * -1.3}s, 0s` }"
              >
                <!-- 拖动这一排时的滞后摆动挂在这一层，与上层的轻晃 / 轻点摆动互不干扰 -->
                <view
                  class="rail-swing"
                  :class="{ 'is-releasing': railReleasing }"
                  :style="{ transform: `rotate(${railTilt}deg)`, '--dy': `${RACK_DY[slot.index % RACK_DY.length]}rpx` }"
                >
                  <!-- 滑环：轮心压杆心（轮心 = 旋转轴），吊线从轮心垂到夹具顶 -->
                  <view class="rack-clip">
                    <view class="pulley">
                      <view class="pulley__arm pulley__arm--l" />
                      <view class="pulley__arm pulley__arm--r" />
                      <view class="pulley__hub" />
                    </view>
                  </view>
                  <view class="rack-wire" />
                  <view class="grip"><view class="grip__mouth" /></view>
                  <!-- 磨砂玻璃卡框 + 四角不锈钢螺点，照片区透明底 -->
                  <view class="rack-frame">
                    <view class="rack-screw rack-screw--tl" />
                    <view class="rack-screw rack-screw--tr" />
                    <view class="rack-screw rack-screw--bl" />
                    <view class="rack-screw rack-screw--br" />
                    <view class="rack-photo">
                      <image
                        v-if="thumbnailUrls[slot.item.id] && !failedThumbnails[slot.item.id]"
                        :src="thumbnailUrls[slot.item.id]"
                        mode="aspectFit"
                        lazy-load
                        @error="failedThumbnails[slot.item.id] = true"
                      />
                      <view v-else class="recent-placeholder" />
                    </view>
                    <view v-if="isTodayNew(slot.item)" class="rack-new">New!</view>
                    <!-- 心愿袋按钮：点按加入/取消，不影响轻点送主卡位 -->
                    <view
                      class="card-wish"
                      :class="{ 'is-on': isWished(slot.item.id) }"
                      hover-class="is-pressed"
                      :hover-stay-time="80"
                      @tap.stop="toggleWish(slot.item)"
                    >♥</view>
                  </view>
                  <view class="rail-meta">
                    <text class="rail-name">{{ slot.item.name }}</text>
                    <text class="rail-info">{{ slot.item.ownerName ?? '官方精选' }} · {{ shortDate(slot.item.addedAt) }}</text>
                  </view>
                </view>
              </view>
            </button>
            <!-- 虚拟列表右占位：撑出窗口之后剩余卡片的宽度 -->
            <view v-if="tailSpace" class="rail-spacer" :style="{ width: `${tailSpace}rpx` }" />
          </view>
        </view>
      </scroll-view>
      <!-- 翻页状态：只在加载中 / 翻过页且已到底时出现，单页不打扰 -->
      <text v-if="loadingMore" class="rail-status">正在加载更多…</text>
      <text v-else-if="!hasMore && items.length > FEED_PAGE_SIZE" class="rail-status">已经到底啦 · 共 {{ items.length }} 件</text>
      <text class="rack-hint">↤ 左右滑动 · 轻点在上方查看 ↦</text>
    </view>
      </view>
    </scroll-view>

    <!-- 标记已有半窗：共享组件（首页/我的页统一交互），show=false 时自动还原底栏 -->
    <mark-sheet :show="markShow" :item="markItem" :wished="markItem ? isWished(markItem.id) : false" @close="closeMark" @saved="onMarkSaved" />
  </view>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   陈列（首页）—— 版式与材质对齐 H5 原型
   （袋袋集原型_交付包/袋袋集原型.html，data-screen="showcase"）。

   ── 字号一律走微信设计规范，不再按 H5 的 px 直接换算 ──
   规范（§5.1 微信字体）只给六档常用字号，落在小程序就是 App.vue 里的
   --wc-font-* 变量（微信 1pt = 2rpx）：
     Headline    22pt = 44rpx  一级标题
     EmTitle     17pt = 34rpx  二级标题（常用）
     Title       17pt = 34rpx  正文内容
     EmGroupTitle 15pt = 30rpx 三级标题
     EmDesc      14pt = 28rpx  辅助内容
     Footnote    12pt = 24rpx  注释内容
   H5 那套 px 里 8.5~11px 的“小字”折过来只有 7~9pt，真机上不可读，
   所以全部提到 Footnote / EmDesc 两档。
   字重**不采用规范里的 Medium，跟 H5**（用户 2026-09-23 确认）：h1 900、
   卡片名 700、背面名 600、角标 700、字段值 600、设置按钮 650。
   几何（宽高、内边距）仍按 H5 换算：1 H5 px = 750/412 ≈ 1.820rpx。
   ══════════════════════════════════════════════════════════════ */
/* 左右内边距交给各区块自带（H5 就是这么分段的）：
   这样挂袋区的 scroll-view 才能真正铺满整块屏幕 */
/* 顶部标题区固定：页面改为 100vh 弹性列，头部不滚，内容区独立滚动（scroll-view） */
.home-page { position: relative; height: 100vh; display: flex; flex-direction: column; overflow: hidden; background-color: #f2f3f7; }
.home-scroll { flex: 1 1 auto; min-height: 0; }
.home-body { padding-bottom: 176rpx; }

/* ── 头部：一级标题 + 辅助文案，右侧设置钮与标题块垂直居中（H5 .bags-header 同款：
   align-items:center + space-between，右钮与左侧文字块中线对齐，两页位置一致）──
   padding-top 由脚本按胶囊矩形注入，与全部收藏页同款对齐方式 */
.bags-header { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; padding: 0 36rpx 29rpx; }
.bags-header__text { display: flex; flex-direction: column; min-width: 0; }
/* 一级标题：H5 .bags-title 是 38px × 1.82 = 69rpx（900 / 字距 2px = 3.6rpx）。
   ⚠ 这一档**没有**用微信六档的 Headline(44rpx)：首页的「袋袋集」和「全部收藏」在 H5 里
   共用同一个 .bags-title，两页必须一样大（用户 2026-09-24 专门点过这件事）。
   想改字号两页一起改，别只动这一处。 */
/* 字体栈照搬 H5 的 h1（袋袋集原型.html:117）：Iowan Old Style / Baskerville 都是 iOS 系统
   衬线，中文没有对应字形会回退到 "Songti SC"（宋体）—— 截图里「袋袋集」的宋体感就来自这里。
   Android 上前面几个都缺失，落到通用 serif，属于预期内的降级。 */
/* 2026-09-29 用户要求：54rpx / 900 / 无字距
   2026-09-30 用户要求再粗一点：font-weight 已到 900 上限，但回退的宋体（Songti SC）
   字族没有更重的字面，光靠字重已经加不动了 —— 用 -webkit-text-stroke 补一层描边
   （与 .rack-new 角标同一套加粗手法）。描边是沿字形轮廓中心向两侧各扩一半，
   1rpx ≈ 视觉上多 0.5rpx，够加粗又不糊；再粗会让笔画粘死，别往上调。 */
.bags-title { margin-bottom: 11rpx; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 54rpx; font-weight: 900; line-height: 1; letter-spacing: 0; -webkit-text-stroke: 1rpx #141414; }
/* 辅助内容：EmDesc 14pt（与「全部收藏」的副文案同档，两页一致） */
.bags-tagline { color: #77736d; font-size: var(--wc-font-description); line-height: 1.4; }
/* 设置钮已迁至「我的」页头部（2026-09-29），首页头部只保留标题块 */

.load-error { margin: 28rpx 36rpx; padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: var(--wc-font-description); text-align: center; }

/* ── 主展位：玻璃卡 + 3D 翻面（H5 .stage-section / .flip-card）── */
/* H5 margin: 0 18px 26px；perspective 让子元素的 3D 变换不被父层压平 */
.stage-section { margin: 0 33rpx 47rpx; perspective: 1400px; }
/* 卡片宽度：H5 是 308/412（左右各留 52px），按需求把左右间隔收到 47rpx（≈26px），
   于是 750 − 47×2 = 656rpx。高度按放大后的字号抬到 660rpx（两面都装得下）。
   2026-09-26 用户指定卡片尺寸 300×318（px 口径 → 600×636rpx）；高度随后又按要求再矮 12px → 612rpx。
   rotateY(-180deg) 是「把卡片向右翻过去」的方向。 */
.flip-card { position: relative; width: 600rpx; height: 612rpx; margin: 0 auto; border: 2rpx solid rgba(255,255,255,.62); border-radius: 47rpx; transform-style: preserve-3d; transition: transform .78s cubic-bezier(.2,.78,.22,1); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.9); }
.flip-card.is-flipped { transform: rotateY(-180deg); }
/* 点击遮罩：铺满整卡，翻到背面后依然可点（整块卡片都能翻回正面）；
   背面的「翻回去」「查看完整详情」层级更高，压在它之上 */
.flip-card__hit { position: absolute; z-index: 6; top: 0; left: 0; right: 0; bottom: 0; border-radius: 47rpx; }

/* 两个面各自固定预旋转，靠透明度做前后切换（不依赖 backface-visibility：
   背面固定 -180°，与父级同号抵消成 -360°≡0°，可见的那一面净角度始终 ≈ 0°）。
   淡入延时必须等父级转过 90° 再出现，否则会在卡片还很宽时露出镜像内容。 */
.flip-face { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow: hidden; border-radius: 47rpx; }
/* 下内边距 46rpx（H5 是 33rpx）：字号提到 12pt 后底部提示语变高，
   还按 33rpx 会顶到上面那两行文字 */
/* 2026-09-26 多轮调整：内容整体上移一点，给底部「轻点翻面」提示留出上方间距 */
.flip-face--front { z-index: 1; display: flex; flex-direction: column; align-items: center; padding: 60rpx 36rpx 40rpx; }
.flip-face--back { z-index: 2; transform: rotateY(-180deg); opacity: 0; }
.flip-card.is-flipped .flip-face--front { opacity: 0; transition: opacity .06s linear 0s; }
/* 翻面后把整个背面层提到整卡点击层（.flip-card__hit z 6）之上：
   背面的「加入心愿袋 / 标记已有」按钮才能点到，否则点击全被翻面截走 */
.flip-card.is-flipped .flip-face--back { opacity: 1; z-index: 7; transition: opacity .1s linear .11s; }
.flip-card:not(.is-flipped) .flip-face--front { opacity: 1; transition: opacity .1s linear .11s; }
.flip-card:not(.is-flipped) .flip-face--back { opacity: 0; transition: opacity .06s linear 0s; }

/* 卡片底：H5 正面走「宫格卡片那套底色」——左上微亮 / 右下微暗 + 1px 内白边。
   indexBg.svg 自带右上角那束暖黄斜光（与 H5 的 light-beam 同源）。 */
.frame85-background { position: absolute; z-index: 0; top: 0; left: 0; width: 100%; height: 100%; border-radius: 47rpx; background: linear-gradient(160deg, #fbfbfd, #eef0f4); pointer-events: none; }
/* 左上角冷白高光 + 1px 内白边（H5 .glass-glow / .flip-face--front）。
   内白边必须画在这一层而不是卡片底图上：底图是替换元素，会整块盖住自身的 inset 阴影。 */
.glass-glow { position: absolute; z-index: 1; top: 0; left: 0; right: 0; bottom: 0; border-radius: 47rpx; box-shadow: inset 0 0 0 2rpx rgba(255,255,255,.9); pointer-events: none; background: radial-gradient(120% 78% at 16% -12%, rgba(255,255,255,.95) 0%, rgba(255,255,255,0) 58%), linear-gradient(128deg, rgba(255,255,255,.5) 0%, rgba(255,255,255,0) 34%, rgba(255,255,255,0) 66%, rgba(255,255,255,.34) 100%); }
/* 右上角黄色光晕：radial 渐变锚定在卡片右上角（中心 = 100% 0%），
   天然柔和无线条 —— 替代 indexBg.svg 的光带（微信 <image> 不支持 SVG 滤镜，
   30px 高斯模糊不生效，光带硬边渲染成两条细线）。右上圆角随卡片裁形 */
.corner-glow { position: absolute; z-index: 1; top: 0; right: 0; width: 260rpx; height: 260rpx; border-radius: 0 47rpx 0 0; pointer-events: none; background: radial-gradient(circle at 100% 0%, rgba(240,224,117,.62) 0%, rgba(240,224,117,.34) 32%, rgba(240,224,117,0) 70%); }

/* 「最新」徽标已按用户要求移除（2026-09-29） */

/* 袋子区：H5 固定 248px 高、宽度按图片自身比例（这里交给 aspectFit 在定高框内等比居中）。
   2026-09-26 用户两轮要求收小：451 → 436 → 400rpx */
.flip-face__art { position: relative; z-index: 3; flex: 0 0 auto; width: 100%; height: 400rpx; }
.flip-face__art image { width: 100%; height: 400rpx; filter: drop-shadow(0 7rpx 18rpx rgba(0,0,0,.18)); }
.art-placeholder { position: absolute; left: 50%; top: 50%; width: 258rpx; height: 340rpx; margin: -170rpx 0 0 -129rpx; border-radius: 28rpx; background: rgba(255,255,255,.46); }

/* 袋子下方两行（H5 .front-caption：margin-top 8px；title 21px；sub 10.5px、gap 7px、margin 5px）。
   ⚠ 字号换算基准：H5 字体是固定 px，在 375 屏上不随手壳缩放，所以这里按 1px=2rpx
   （375 屏基准）而非 1.82，否则比 H5 均匀小 10% —— 用户 2026-09-26 实测反馈。 */
.front-caption { position: relative; z-index: 3; flex: 0 0 auto; width: 100%; margin-top: 15rpx; text-align: center; }
/* 卡片标题是另一套栈（H5 .front-caption__title / .back-name，均以 Georgia 打头） */
.front-caption__title { display: block; color: #1a1815; font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: 38rpx; font-weight: 700; line-height: 1.2; letter-spacing: .2rpx; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.front-caption__sub { display: flex; align-items: center; justify-content: center; gap: 13rpx; margin-top: 9rpx; color: #8d877c; font-size: 24rpx; line-height: 1.4; letter-spacing: .4rpx; }
.front-caption__part { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.front-caption__part--fixed { flex: 0 0 auto; }
.front-caption__dot { flex: 0 0 auto; width: 6rpx; height: 6rpx; border-radius: 50%; background: currentColor; opacity: .55; }

/* 轻点提示：贴卡片底部通栏居中（H5 .flip-hint：bottom 6px、8.5px 字、字距 .3px） */
.flip-hint { position: absolute; z-index: 4; bottom: 11rpx; left: 0; right: 0; color: #c0bab1; font-size: 20rpx; line-height: 1.2; letter-spacing: .5rpx; text-align: center; pointer-events: none; }

/* ── 背面：详细信息（H5 .back-inner：padding 16px 18px 14px；eyebrow 8.5px；
   name 19px；brand 11px；divider 11px；facts gap 6px、dt 9.5px、dd 10.5px；
   tags gap 5px、9.5px、padding 4px 9px；note 10px、padding 8px 10px。
   字号按 1px=2rpx（375 屏基准，见正面说明）── */
/* 背面滚动区：撑满卡片，内容超高时在卡内上下滚（滚动条已由 enhanced + show-scrollbar 关闭） */
.back-scroll { position: relative; z-index: 3; height: 100%; }
/* 原 height:100% + overflow:hidden 会把超高内容直接裁掉且滚不动；
   改为 min-height:100%（内容少时仍撑满，观感不变）+ 自然高度，超出部分交给外层 scroll-view */
.back-inner { display: flex; flex-direction: column; min-height: 100%; padding: 29rpx 33rpx 25rpx; }
.back-eyebrow { color: #77736d; font-size: 20rpx; font-weight: 700; line-height: 1.2; letter-spacing: 3rpx; }
/* 背面字段与正面对齐：名称 19px/700 同 .front-caption__title，
   品牌行 24rpx #8d877c 同 .front-caption__sub（2026-09-29 用户要求两面对齐） */
.back-name { margin-top: 7rpx; color: #1a1815; font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: 38rpx; font-weight: 700; line-height: 1.2; letter-spacing: .2rpx; }
.back-brand { margin-top: 9rpx; color: #8d877c; font-size: 24rpx; line-height: 1.4; letter-spacing: .4rpx; }
.back-divider { height: 1rpx; margin: 20rpx 0; background: linear-gradient(90deg, rgba(20,20,20,.12), rgba(20,20,20,.04) 70%, transparent); }
.back-facts { display: flex; flex-direction: column; gap: 11rpx; }
.back-facts__row { display: flex; align-items: baseline; justify-content: space-between; gap: 18rpx; }
.back-facts__key { flex: 0 0 auto; color: #77736d; font-size: 24rpx; line-height: 1.4; letter-spacing: .5rpx; }
.back-facts__value { flex: 0 1 auto; min-width: 0; color: #2b2720; font-size: 24rpx; font-weight: 600; line-height: 1.4; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.back-tags { display: flex; flex-wrap: wrap; gap: 9rpx; margin-top: 22rpx; }
.back-tags text { padding: 7rpx 16rpx; border-radius: 18rpx; background: rgba(20,20,20,.055); color: #5d594f; font-size: 24rpx; line-height: 1.2; }
/* 备注：引用式文字。后端 notes 最长 2000 字而卡内高度固定，限两行裁掉 */
.back-note { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; margin-top: 20rpx; padding: 15rpx 18rpx; border-left: 4rpx solid rgba(20,20,20,.14); border-radius: 0 16rpx 16rpx 0; background: rgba(20,20,20,.035); color: #5f5b53; font-size: 24rpx; line-height: 1.55; }
/* 背面右上角的「翻回去」按钮已删除：整卡点击区（.flip-card__hit）本身就能翻回 */

/* 空状态：卡片收成一个安静的占位，不参与翻面 */
.empty-card { display: flex; flex-direction: column; align-items: center; }
.empty-illustration { position: absolute; z-index: 3; left: 50%; top: 82rpx; width: 334rpx; height: 332rpx; margin-left: -167rpx; }
/* width:auto 覆盖 .front-caption 的 width:100%：左右定位同时生效才真正居中
   （否则 left+width 过度约束，right 被忽略，文字整体右偏 36rpx） */
.empty-caption { position: absolute; z-index: 3; left: 36rpx; right: 36rpx; bottom: 78rpx; width: auto; }
.front-caption__hint { display: block; margin-top: 9rpx; color: #8d877c; font-size: var(--wc-font-description); line-height: 1.5; }

/* 骨架屏 */
.skeleton-card { display: flex; flex-direction: column; align-items: center; padding-top: 33rpx; border-color: transparent; background: rgba(255,255,255,.32); box-shadow: none; }
.skeleton-art { width: 470rpx; height: 451rpx; border-radius: 34rpx; background: rgba(255,255,255,.7); }
.skeleton-line { width: 260rpx; height: 24rpx; margin-top: 18rpx; border-radius: 999rpx; background: rgba(255,255,255,.75); }
.skeleton-line--wide { width: 340rpx; margin-top: 48rpx; }

/* ── 最近收集（H5 .rack-section / .section-heading / .stage-count）──
   2026-09-26 用户要求去掉区块底色（原先加的米色底让玻璃卡框更显形，但用户不需要） */
/* 负 margin 生效：与上一区块的 47rpx 下边距折叠后为 47−14=33rpx，
   标题整体上移（2026-09-26 用户要求上移一点） */
.recent-section { margin-top: -14rpx; }
/* H5 .section-heading：两端对齐、基线贴底 */
.recent-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16rpx; padding: 0 40rpx 6rpx; }
/* 区块标题：EmTitle 34rpx → 2026-09-26 用户要求调大一点 → 38rpx（仍 700 衬线） */
.recent-title { color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 38rpx; font-weight: 700; line-height: 1.05; letter-spacing: -1rpx; }
/* 标题与副行小字的间距：原为 0（贴死），2026-09-26 用户要求调大 */
.recent-heading { padding-bottom: 16rpx; }
/* 副行：「最近15天 · N 件」与「查看全部」垂直居中对齐（两端撑开） */
.recent-sub { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; padding: 0 40rpx 18rpx; }
/* flex 垂直居中：图片是内联元素时按基线对齐，27rpx 的图标底边坐在文字基线上，
   视觉上箭头比文字高一截 —— 改 flex 后图标与文字垂直居中 */
.recent-all { min-height: 0; margin: 0; padding: 0; border: 0; background: transparent; color: #77736d; font-size: 24rpx; line-height: 32rpx; display: flex; align-items: center; }
/* 箭头与展架标题行的同款 SVG 图标（#77736d 描边、27rpx），观感一致 */
.recent-all-arrow { width: 27rpx; height: 27rpx; margin-left: 6rpx; }
.stage-count { display: block; color: #77736d; font-size: 24rpx; line-height: 1.4; }
/* 挂袋区通栏：scroll-view 铺满整块屏幕，横杆（left/right 0）才能真正顶到左右尽头 */
.recent-scroll { position: relative; z-index: 1; width: 100%; }
/* ⚠ 轮心对齐的唯一真源：--rail-center（杆心离场景顶的高度）与 --hang-origin（轮心到卡顶的距离）。
   padding-top = 两者之和 → 杆心与轮心从同一组常量推导，数学上保证重合；
   滑环 top、吊线 top、摆动轴心全部引用这两个变量，改轮位只动这里。
   卡宽是调参入口（原型 --rack-card-w）：106px → 96px → 2026-09-26 方案 A 再调小至 80px = 160rpx
   （重叠同步 22 → 20rpx）；照片区高度与 meta 字号都按卡宽 calc 派生，改这一个变量整排跟着缩。 */
.recent-scene { --rail-center: 26rpx; --hang-origin: 80rpx; --rack-card-w: 160rpx; --rack-overlap: 20rpx; position: relative; display: inline-flex; min-width: 100%;
  /* rail-center 必须 ≥ 滑轮半径 19.5rpx + 高亮环 2rpx + 余量：否则滑轮顶超出滚动内容上缘被裁。
     26rpx 时轮顶留 4.5rpx 余量，且轮心（卡顶 − hang-origin）天然等于杆心，勿用 padding 补 */
  padding: calc(var(--rail-center) + var(--hang-origin)) 22rpx 22rpx; }
.recent-row { position: relative; z-index: 1; display: inline-flex; align-items: flex-start; }
/* 轻叠 -12px（后压前）；--lift 给选中上提 4px=7rpx */
.recent-item { --lift: 0rpx; width: var(--rack-card-w); flex: 0 0 var(--rack-card-w); margin: 0; padding: 0; overflow: visible; background: transparent; text-align: center; }
.recent-item + .recent-item { margin-left: calc(-1 * var(--rack-overlap)); }
/* 虚拟列表占位：只撑宽度、不占高度（1rpx 不影响 inline-flex 行的垂直排布），
   宽度由行内样式按「窗口外卡片数 × 140rpx」给出，滚动总长与不做虚拟列表时完全一致 */
.rail-spacer { flex: 0 0 auto; height: 1rpx; }
.recent-item.is-active { --lift: 7rpx; z-index: 3; }
.rail-hang { position: relative; transform-origin: 50% calc(-1 * var(--hang-origin)); }
/* ── 拖动这一排时的滞后摆动层 ──
   两层变换叠加：父层（.rail-hang）跑常态轻晃 / 轻点摆动，本层跑拖动倾斜，
   分开是为了不互相覆盖 —— 同一个 transform 上，动画会压掉 inline 样式。
   倾角由脚本按滚动速度写成 inline transform；松手时切到带过冲的曲线弹回（模拟弹簧落回），
   .16s 的短过渡把脚本 80ms 一次的台阶抹平。 */
/* ⚠ 垂距 --dy 用 swing 的 padding-top 承载（原来是卡框的 margin-top）：
   block 容器里第一个子元素的 margin-top 会塌陷穿透到父元素，把整个 swing
   连滑环一起往下推 —— 表现就是「只有第一张卡(dy=0)的滑环在杆心上」。
   padding 不参与塌陷，且绝对定位的滑环/吊线/夹具参照 padding box 边缘、
   位置不受 padding 影响 —— 这是零副作用的阻断方式（等价 H5 的 flow-root） */
.rail-swing { position: relative; padding-top: calc(var(--dy, 0rpx) - var(--lift, 0rpx)); transform-origin: 50% calc(-1 * var(--hang-origin)); transition: transform .16s ease-out, padding-top .28s cubic-bezier(.2, .8, .25, 1); }
.rail-swing.is-releasing { transition: transform .62s cubic-bezier(.34, 1.42, .5, 1), padding-top .28s cubic-bezier(.2, .8, .25, 1); }
.hang-tilt-left { animation: sway-left 5.6s ease-in-out infinite alternate; }
.hang-tilt-right { animation: sway-right 6.4s ease-in-out infinite alternate; }
@keyframes sway-left { from { transform: rotate(-3.4deg); } to { transform: rotate(-1.6deg); } }
@keyframes sway-right { from { transform: rotate(1.6deg); } to { transform: rotate(3.4deg); } }

/* ── 轻点的一下摆动（对齐 H5 的 pointerup「轻点」分支）──
   H5 的卡片静止时不晃：轻点/拨动才给冲量，然后按
     velocity += -angle * 0.018（回复力）；velocity *= 0.952（阻尼）；冲量 +7；±26° 限位
   这套弹簧模型摆动。这里把同一组参数按 60fps 逐帧采样，落成一条 2s 的 keyframes
   （密集段在前 0.2s，尾巴按线性收尾），所以「荡出去 → 回摆 → 逐次衰减」的幅度与节奏与 H5 一致。
   两条动画都写 transform 时，后面的优先 —— 摆动期间由 kick 接管，播完自动交还常态轻晃。
   ⚠ keyframes 里的角度是「基准角 + 摆角」：偶数位基准 +2.5°、奇数位 -2.5°（H5 rackBaseAngle）。 */
.hang-tilt-right.is-kicking { animation: sway-right 6.4s ease-in-out infinite alternate, kick-right 2s linear 1; }
.hang-tilt-left.is-kicking { animation: sway-left 5.6s ease-in-out infinite alternate, kick-left 2s linear 1; }
@keyframes kick-right { 0% { transform: rotate(2.5deg); } 2.5% { transform: rotate(21.1deg); } 5% { transform: rotate(26.1deg); } 7.5% { transform: rotate(17.6deg); } 10% { transform: rotate(8deg); } 15% { transform: rotate(-8.4deg); } 20% { transform: rotate(-14.9deg); } 25% { transform: rotate(-10.7deg); } 30% { transform: rotate(-0.7deg); } 37.5% { transform: rotate(11.1deg); } 45% { transform: rotate(9.9deg); } 52.5% { transform: rotate(1.6deg); } 60% { transform: rotate(-2.8deg); } 70% { transform: rotate(1.4deg); } 80% { transform: rotate(5.1deg); } 90% { transform: rotate(2.8deg); } 100% { transform: rotate(2.5deg); } }
@keyframes kick-left { 0% { transform: rotate(-2.5deg); } 2.5% { transform: rotate(16.1deg); } 5% { transform: rotate(21.1deg); } 7.5% { transform: rotate(12.6deg); } 10% { transform: rotate(3deg); } 15% { transform: rotate(-13.4deg); } 20% { transform: rotate(-19.9deg); } 25% { transform: rotate(-15.7deg); } 30% { transform: rotate(-5.7deg); } 37.5% { transform: rotate(6.1deg); } 45% { transform: rotate(4.9deg); } 52.5% { transform: rotate(-3.4deg); } 60% { transform: rotate(-7.8deg); } 70% { transform: rotate(-3.6deg); } 80% { transform: rotate(0.1deg); } 90% { transform: rotate(-2.2deg); } 100% { transform: rotate(-2.5deg); } }
/* ── 亚克力展示杆（原型 .rack-cable / .rack-rail / 端件，1px→1.82rpx 换算）──
   半透芥黄杆身（原型 color-mix 已手工混成 rgba/实色）+ 背板模糊 + 四缘棱光；
   杆体 top 8.88px→16rpx，厚 10px→18rpx；端件 9×13.5px→16×25rpx */
.rack-cable { position: absolute; z-index: 0; top: 0; left: 0; right: 0; height: 40rpx; pointer-events: none; }
.rack-rail { position: absolute; top: calc(var(--rail-center) - 9rpx); left: 44rpx; right: 44rpx; height: 18rpx; border-radius: 5rpx;
  background: linear-gradient(180deg, #F8DD9D 0%, rgba(240,180,37,.68) 28%, rgba(240,180,37,.86) 64%, rgba(240,180,37,.52) 100%);
  -webkit-backdrop-filter: blur(5rpx) saturate(1.25); backdrop-filter: blur(5rpx) saturate(1.25);
  box-shadow: 0 4rpx 7rpx rgba(90,60,10,.14), inset 0 2rpx 0 rgba(255,255,255,.85), inset 0 -2rpx 2rpx rgba(255,255,255,.28), inset 3rpx 0 4rpx rgba(255,255,255,.42), inset -3rpx 0 4rpx rgba(255,255,255,.42); }
.rack-rail::before { content: ""; position: absolute; left: 5%; right: 34%; top: 3rpx; height: 5rpx; border-radius: 4rpx;
  background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.6) 20%, rgba(255,255,255,.42) 60%, rgba(255,255,255,0)); }
/* 端部夹块：不锈钢 conic 拉丝 + 左上高光 + 沉边（与四角螺点同材质族）。
   ⚠ top 必须随 --rail-center 走（H5 端件中心 = 杆心 15.98px）：上一轮杆身下移
   16rpx 时端件没跟，悬在杆上方 8px —— 就是「没对齐」的元凶 */
/* 端件三件套 top 全部绑定 --rail-center，几何中心与杆心一致（曾试过光学上提，已回退） */
.rack-endcap { position: absolute; top: calc(var(--rail-center) - 12rpx); width: 16rpx; height: 25rpx; border-radius: 4rpx;
  /* 原用 conic-gradient 模拟拉丝，其最暗扇区（#97a1ab @ 50%）指向顶部，叠上高光淡出带
     形成顶部「黑点」——改平滑纵向金属渐变，暗部落在中下并柔和过渡 */
  background: linear-gradient(180deg, rgba(255,255,255,.55), rgba(255,255,255,0) 30%, rgba(0,0,0,.08) 100%), linear-gradient(180deg, #f8fafb 0%, #d4dae0 45%, #bcc5cd 70%, #e6eaee 100%);
  box-shadow: 0 2rpx 4rpx rgba(0,0,0,.40), 0 2rpx 5rpx rgba(0,0,0,.18), inset 0 0 0 1rpx rgba(255,255,255,.60), inset 0 -1rpx 2rpx rgba(0,0,0,.30); }
.rack-endcap--l { left: 31rpx; }
.rack-endcap--r { right: 31rpx; }
/* 外伸螺纹杆（repeating 车螺纹纹理），中心对齐杆心 */
.rack-stud { position: absolute; top: calc(var(--rail-center) - 3rpx); width: 24rpx; height: 6rpx; border-radius: 3rpx;
  background: linear-gradient(180deg, rgba(255,255,255,.85), rgba(122,134,146,.55)), repeating-linear-gradient(90deg, transparent 0 3rpx, rgba(96,108,120,.55) 3rpx 4rpx), #C3CCD5;
  box-shadow: 0 2rpx 4rpx rgba(40,48,58,.30); }
.rack-stud--l { left: 11rpx; }
.rack-stud--r { right: 11rpx; }
/* 朱红圆球头：光面亚克力珠（穹面渐变 + 高光点 + 次反光），8.5px→15rpx，中心对齐杆心 */
.rack-knob { position: absolute; top: calc(var(--rail-center) - 7.5rpx); width: 15rpx; height: 15rpx; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #FF8A70 0%, #E23C2D 55%, #A32415 100%);
  box-shadow: 0 4rpx 6rpx rgba(120,20,10,.35), inset 0 0 0 1rpx rgba(150,25,12,.4); }
.rack-knob::before { content: ""; position: absolute; left: 19%; top: 17%; width: 26%; height: 26%; border-radius: 50%; background: rgba(255,255,255,.95); }
.rack-knob::after { content: ""; position: absolute; left: 60%; bottom: 20%; width: 14%; height: 14%; border-radius: 50%; background: rgba(255,255,255,.4); }
.rack-knob--l { left: 2rpx; }
.rack-knob--r { right: 2rpx; }

/* ── 滑环（原型 SVG 滑轮的 CSS 化）：盒 21.496px→39rpx，轮心 = 盒中心 = 杆心
   → 盒 top = -54.77px→-100rpx。小程序 image 不渲染 SVG，改纯 CSS：
   银钢环（border + 渐变棱影）+ 两根水平银臂 + 芥黄轮毂。 */
.rack-clip { position: absolute; top: calc(-1 * var(--hang-origin) - 19.5rpx); left: 50%; transform: translateX(-50%); z-index: 3; }
.pulley { position: relative; box-sizing: border-box; width: 39rpx; height: 39rpx; border-radius: 50%;
  /* 环带粗细对齐 H5（stroke 3.4px → 6rpx）：孔径 27rpx > 杆厚 18rpx，杆从孔中穿过、上下各留 ~4rpx 空隙 */
  border: 6rpx solid #E9EEF3;
  /* 孔必须透空：芥黄杆从孔中穿过（预期图的关键特征），背景保持透明，光影靠描边 */
  box-shadow: 0 0 0 1rpx rgba(88,100,112,.32), 0 0 0 2rpx rgba(255,255,255,.75), inset 0 2rpx 2rpx rgba(255,255,255,.9), inset 0 -2rpx 3rpx rgba(0,0,0,.12); }
/* 银臂：从轮毂边缘连到环内缘（原型 M7.371→4.021，即盒内 8~15rpx 一段） */
.pulley__arm { position: absolute; top: 50%; height: 2rpx; width: 7rpx; margin-top: -1rpx; background: #9AA4AE; }
.pulley__arm--l { left: 8rpx; }
.pulley__arm--r { right: 8rpx; }
/* 轮毂：芥黄（直径对齐 H5 r2.2 → 9rpx），选中变红 #c50205（原型⑯） */
.pulley__hub { position: absolute; left: 50%; top: 50%; width: 9rpx; height: 9rpx; margin: -4.5rpx 0 0 -4.5rpx; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #F9D86C 0%, #F0B425 55%, #C08C10 100%);
  border: 1rpx solid #B88810; box-shadow: 0 1rpx 2rpx rgba(90,60,10,.35); }
.pulley__hub::before { content: ""; position: absolute; left: 18%; top: 14%; width: 32%; height: 32%; border-radius: 50%; background: rgba(255,255,255,.95); }
.recent-item.is-active .pulley__hub { background: #c50205; border-color: #8f0204; }
/* 选中滑环：玻璃层只留一圈细亮边（0.25s 淡入，原型⑰⑱⑲）。
   白色必须近乎不透明：背后是压暗蒙层（深色），55% 白会混成灰圈 */
.rack-clip::after { content: ""; position: absolute; inset: -2rpx; border-radius: 50%; z-index: 2; opacity: 0; border: 2rpx solid rgba(255,255,255,.95); pointer-events: none; transition: opacity .25s ease; }
.recent-item.is-active .rack-clip::after { opacity: 1; }

/* 吊线：从轮心垂到夹具顶，上半段藏在轮体后面，选中上提时跟着缩短 */
.rack-wire { position: absolute; top: calc(-1 * var(--hang-origin)); left: 50%; margin-left: -2rpx; width: 4rpx; height: calc(66rpx + var(--dy, 0rpx) - var(--lift, 0rpx)); border-radius: 2rpx; z-index: 2;
  background: linear-gradient(90deg, #A9B2BB, #F2F6F9 42%, #939DA7); transition: height .28s cubic-bezier(.2,.8,.25,1); }

/* ── 夹具：统一用原型卡3「喷砂哑光」款（低反差漫射），咬住卡顶 7.5px=14rpx ── */
.grip { position: absolute; top: calc(-14rpx + var(--dy, 0rpx) - var(--lift, 0rpx)); left: 50%; margin-left: -11rpx; z-index: 6;
  width: 21rpx; height: 27rpx; border-radius: 5rpx 5rpx 4rpx 4rpx;
  background: linear-gradient(180deg, #F2F5F7 0%, #DFE5EA 30%, #CBD4DB 64%, #B0BAC3 100%);
  box-shadow: 0 2rpx 5rpx rgba(46,56,66,.26), inset 0 2rpx 0 rgba(255,255,255,.7), inset -1rpx 0 0 rgba(120,132,144,.28), inset 1rpx 0 0 rgba(255,255,255,.4);
  transition: top .28s cubic-bezier(.2,.8,.25,1); }
.grip::before { content: ""; position: absolute; left: 3rpx; right: 3rpx; top: 10rpx; height: 2rpx; border-radius: 2rpx; background: rgba(112,124,136,.5); }
.grip::after { content: ""; position: absolute; left: 50%; top: 4rpx; margin-left: -2.5rpx; width: 5rpx; height: 3.5rpx; border-radius: 50%;
  background: radial-gradient(circle at 34% 30%, #FDFEFE, #AEB8C2 62%, #87919B); box-shadow: 0 1rpx 2rpx rgba(46,56,66,.5); }
.grip__mouth { position: absolute; left: 3rpx; right: 3rpx; bottom: 6rpx; height: 4rpx; border-radius: 2rpx;
  background: linear-gradient(180deg, rgba(120,132,144,.65), rgba(72,84,96,.85)); }
/* ── 卡框：玻璃边框（2026-09-26 用户要求所有卡片观感统一）──
   边框改**不透明白**、玻璃底提高不透明度、去掉 backdrop-filter ——
   半透明 + 磨砂会透出背后内容且真机渲染不一致，导致各卡边框有色差；
   现在所有未选中卡片渲染完全一致（选中红环不受影响）。
   垂距已由 swing 的 padding-top 承载（含选中上提 -lift），卡框自身不再带 margin */
.rack-frame { position: relative; z-index: 1;
  border: 2rpx solid #ffffff; border-radius: 11rpx; padding: 9rpx;
  background: linear-gradient(160deg, rgba(255,255,255,.80) 0%, rgba(255,255,255,.58) 48%, rgba(244,240,233,.66) 100%);
  box-shadow: 0 7rpx 25rpx rgba(60,52,40,.16), inset 0 2rpx 0 rgba(255,255,255,.85), inset 0 -2rpx 0 rgba(255,255,255,.28); }
/* 四角螺点：不锈钢样式（conic 拉丝环 + 左上高光 + 沉孔阴影，冷银调），4px=7rpx */
.rack-screw { position: absolute; width: 7rpx; height: 7rpx; border-radius: 50%; z-index: 5;
  background: radial-gradient(circle at 34% 26%, rgba(255,255,255,.95) 0 12%, rgba(255,255,255,0) 34%), radial-gradient(circle at 50% 50%, rgba(255,255,255,.9) 0 8%, rgba(255,255,255,0) 30%), conic-gradient(from 210deg, #f4f6f8, #c3cad1 25%, #97a1ab 50%, #d5dce2 75%, #f4f6f8 100%);
  box-shadow: 0 1.5rpx 3rpx rgba(0,0,0,.38), 0 1.5rpx 4rpx rgba(0,0,0,.16), inset 0 0 0 1rpx rgba(255,255,255,.60), inset 0 -1rpx 2rpx rgba(0,0,0,.30); }
.rack-screw--tl { top: 5rpx; left: 5rpx; }
.rack-screw--tr { top: 5rpx; right: 5rpx; }
.rack-screw--bl { bottom: 5rpx; left: 5rpx; }
.rack-screw--br { bottom: 5rpx; right: 5rpx; }
/* 今日上新角标「New!」（用户选定方案 A 并要求描边加粗）：
   亮黄字身 #FFDE59 + 深红描边 #8F0204（3rpx，比初版 2rpx 粗一档）+ 白外圈（八向偏移画在字形后面，
   须比描边宽一档才露出环边）+ 底部软影；微斜 -6° 俏皮姿态 */
.rack-new { position: absolute; z-index: 4; left: 10rpx; bottom: 12rpx; color: #1da84a; font-size: 22rpx; font-weight: 900; font-style: italic; line-height: 1; font-family: "Yuanti SC", "YouYuan", "PingFang SC", sans-serif; -webkit-text-stroke: 0; text-shadow: -2rpx -2rpx 0 #ffffff, 2rpx -2rpx 0 #ffffff, -2rpx 2rpx 0 #ffffff, 2rpx 2rpx 0 #ffffff, -3rpx 0 0 #ffffff, 3rpx 0 0 #ffffff, 0 -3rpx 0 #ffffff, 0 3rpx 0 #ffffff, 0 4rpx 6rpx rgba(6, 80, 30, .4); }
/* 照片区：无底色（原型④），袋子直接落在玻璃卡内的透明底上；袋宽 84% 靠左（.paper-bag 规则）；
   高度 = 卡宽 × 1.29（H5 .rack-photo 用 --rack-card-w 推导，这里同式） */
.rack-photo { position: relative; height: calc(var(--rack-card-w) * 1.29); border-radius: 4rpx; overflow: hidden; display: flex; align-items: center; justify-content: flex-start;
  background: linear-gradient(180deg, rgba(255,255,255,.10), rgba(0,0,0,.10)); }
/* 袋图撑满照片区（aspectFit 等比、居中）—— 预期图里袋子几乎占满玻璃卡 */
.rack-photo image { width: 100%; height: 100%; filter: drop-shadow(0 7rpx 18rpx rgba(0, 0, 0, .18)); }
.recent-placeholder { width: 120rpx; height: 200rpx; border-radius: 12rpx; background: rgba(255, 255, 255, .4); }
/* meta：字号随卡宽推导（H5 .rack-meta：.064/.118/.082），靠左 */
.rail-meta { padding: calc(var(--rack-card-w) * 0.064) 5rpx 0; text-align: left; }
.rail-name { display: block; overflow: hidden; color: #4a3a22; font-family: Georgia, serif; font-size: calc(var(--rack-card-w) * 0.118); font-weight: 700; line-height: 1.2; white-space: nowrap; text-overflow: ellipsis; }
.rail-info { display: block; overflow: hidden; margin-top: 4rpx; color: #a09274; font-size: calc(var(--rack-card-w) * 0.082); line-height: 1.4; white-space: nowrap; text-overflow: ellipsis; }
/* 选中态：红环 + 红晕 + 红轮毂（原型⑯），玻璃与标题金不变；
   上提由 --lift 变量驱动（吊线缩短 / 夹具与卡框上移），不再用 translateY */
.recent-item.is-active .rail-frame { box-shadow: 0 0 0 3rpx #c50205, 0 11rpx 29rpx rgba(150,10,10,.28), inset 0 2rpx 0 rgba(255,255,255,.85); }
.recent-item.is-active .rail-name { color: #8a5a10; }
/* 与大卡片「轻点翻面 · 查看详情」（.flip-hint）字号/颜色/字距完全一致 */
.rack-hint { display: block; padding: 2rpx 36rpx 0; color: #c0bab1; font-size: 20rpx; line-height: 1.2; letter-spacing: .5rpx; text-align: center; }
/* 挂袋区翻页状态（加载中 / 已到底）：与 .rack-hint 同版式，颜色略深以示区分 */
.rail-status { display: block; padding: 12rpx 36rpx 0; color: #a8a49d; font-size: 20rpx; line-height: 1.2; letter-spacing: .5rpx; text-align: center; }

/* ── 发现页：心愿袋按钮 / 主卡操作区（标记已有半窗壳层复用 styles/edit-form.css）── */
/* 挂卡心愿按钮：右上角小圆钮，空心灰 → 实心红（已在心愿袋） */
.card-wish { position: absolute; z-index: 6; top: 10rpx; right: 10rpx; width: 44rpx; height: 44rpx; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(255,255,255,.88); color: #b3afa8; font-size: 24rpx; line-height: 1; transition: transform .18s ease, color .18s ease; }
.card-wish.is-on { color: #c50405; }
.card-wish.is-pressed { transform: scale(.86); }
/* 主卡右上角固定快捷操作：心形（心愿袋）+ 靶心（标记已有）。
   ⚠ 放在 flip-card 直属层（不在任何一面里），翻面时位置不动、始终可见；
   z-index 8 必须 > 整卡点击层 .flip-card__hit(6)，否则点击会被翻面截走 */
.hero-quick { position: absolute; z-index: 8; top: 22rpx; right: 22rpx; display: flex; gap: 14rpx; }
.hero-quick__btn { width: 60rpx; height: 60rpx; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(255,255,255,.88); transition: transform .18s ease; }
.hero-quick__btn.is-pressed { transform: scale(.88); }
.hero-quick__icon { width: 32rpx; height: 32rpx; }
/* 主卡背面的操作区：加入心愿袋（描边）+ 标记已有（黑色实心）。
   ⚠ 必须 position + z-index 7 高于整卡点击层 .flip-card__hit(6)，否则点击会被翻面截走 */
.back-actions { position: relative; z-index: 7; display: flex; gap: 16rpx; margin-top: 24rpx; }
.back-action { flex: 1 1 0; display: flex; align-items: center; justify-content: center; gap: 10rpx; height: 84rpx; margin: 0; padding: 0; border: 2rpx solid rgba(20,20,20,.18); border-radius: 42rpx; background: transparent; color: #141414; font-size: var(--wc-font-footnote); font-weight: 650; line-height: 1; }
/* 按钮内小图标：心形（空心/实心红随心愿状态切换）、白色对勾 */
.back-action__icon { flex: 0 0 30rpx; width: 30rpx; height: 30rpx; }
.back-action.is-on { border-color: #c50405; color: #c50405; }
.back-action--primary { border: 0; background: #141414; color: #ffffff; }
/* 标记半窗已抽为共享组件 components/mark-sheet（含 mark-hint / detail-artwork 样式） */
</style>

<style>
/* ⚠️ 标记已有半窗的壳层与表单样式全在 styles/edit-form.css（与全部收藏页编辑半窗共用）。
   本页 scoped 样式里没有这些类 —— 少了这个引入半窗会裸奔（无底 sheet、无遮罩、表单无版式），
   这就是「点击标记已有 UI 不对」的根因。必须非 scoped 引入，与 library/index.vue 同款。 */
@import '../../styles/edit-form.css';
</style>
