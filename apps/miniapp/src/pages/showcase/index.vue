<script setup lang="ts">
import { computed, ref } from 'vue';
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import type { Collectible, CollectibleSummary } from '../../types';
import { dataService } from '../../services/data';
import { daysAgoText, formattedDate } from '../../services/format';
import { resolveCollectibleThumbnail } from '../../services/images';
import { syncTabBar } from '../../services/tab-bar';

const loading = ref(true);
const initialized = ref(false);
const refreshing = ref(false);
const loadError = ref('');
const items = ref<CollectibleSummary[]>([]);
const totalCount = ref(0);
const thumbnailUrls = ref<Record<string, string>>({});
const failedThumbnails = ref<Record<string, boolean>>({});

// ── 主展位：对齐 H5 的 .flip-card（轻点 3D 翻面）──
// 卡片由「最近收集」里选中的那一张驱动，默认是最新的一张。
// 背面要展示标签与备注，而列表接口只返回摘要，所以选中后补拉一次详情；
// 拉失败就让背面省略标签/备注（正面照常可用），不打断首页。
const heroItem = ref<CollectibleSummary | null>(null);
const heroDetail = ref<Collectible | null>(null);
const flipped = ref(false);
const detailCache = new Map<string, Collectible>();

const heroTags = computed(() => heroDetail.value?.tags ?? []);
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
    { label: '品牌 / 店铺', value: item.shelfName },
    { label: '收藏日期', value: formattedDate(item.addedAt).replace(/\//g, '-') },
    { label: '入库时长', value: daysAgoText(item.addedAt) },
    { label: '编号', value: heroNo.value }
  ].filter((row) => row.value);
});

// ── 挂袋绳区（对齐 h5-prototype 的 rack-section）──
// 卡片 220rpx 宽、相邻重叠 40rpx；绳索是 400x40 坐标系里的下垂曲线 M0,6 Q200,52 400,6，
// 以 PNG 位图（rail-rope.png）scaleToFill 硬拉伸到整条内容宽——微信 image 对 SVG 会按
// 内在宽高比留白渲染，两头够不到屏幕边缘，所以必须用位图。孔环夹和卡片上沿的位置按
// 曲线逐项解算（X(t)=400t，y=6+92t(1-t)），保证夹子钉在绳上。
const RAIL = { cardW: 220, step: 180, padX: 24, padTop: 96, ropeTop: 40, ropeH: 56, clip: 52 };
const RAIL_TONES = ['vermillion', 'kraft', 'blue', 'black', 'green', 'pink'] as const;

const sceneWidth = computed(() => RAIL.padX * 2 + RAIL.cardW + RAIL.step * Math.max(0, items.value.length - 1));
const ropeWidth = computed(() => Math.max(sceneWidth.value, 750));

function ropeYAt(index: number) {
  const centerX = RAIL.padX + RAIL.step * index + RAIL.cardW / 2;
  const t = Math.min(1, Math.max(0, centerX / ropeWidth.value));
  return RAIL.ropeTop + ((6 + 92 * t * (1 - t)) / 40) * RAIL.ropeH;
}

function clipTop(index: number) { return Math.round(ropeYAt(index) - RAIL.padTop - RAIL.clip / 2); }
function hangDrop(index: number) { return Math.round(ropeYAt(index) - RAIL.padTop + 20); }
function railTone(index: number) { return RAIL_TONES[index % RAIL_TONES.length]; }
function shortDate(value: string) { return formattedDate(value).slice(5).replace('/', '.'); }
function isHero(item: CollectibleSummary) { return heroItem.value?.id === item.id; }
function openLibrary() { uni.switchTab({ url: '/pages/library/index' }); }
function openSettings() { uni.navigateTo({ url: '/package-settings/pages/settings/index' }); }
function openHero() {
  if (!heroItem.value) return;
  uni.navigateTo({ url: `/package-library/pages/detail/index?id=${heroItem.value.id}` });
}
let refreshPromise: Promise<void> | undefined;

function assertRenderable(nextItems: CollectibleSummary[]) {
  for (const item of nextItems) {
    if (Number.isNaN(new Date(item.addedAt).getTime())) throw new Error(`收藏“${item.name}”的日期无效`);
  }
}

function hydrateThumbnails(nextItems: CollectibleSummary[]) {
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

async function loadRecentCollectibles() {
  const page = await dataService.collectibles('limit=9');
  if (page.items.length || page.totalCount === 0) return page;

  const recoveryPage = await dataService.collectibles('limit=30');
  return { ...recoveryPage, items: recoveryPage.items.slice(0, 9) };
}

function load() {
  if (refreshPromise) return refreshPromise;
  if (initialized.value) refreshing.value = true;
  else loading.value = true;
  loadError.value = '';
  refreshPromise = (async () => {
    try {
      const page = await loadRecentCollectibles();
      assertRenderable(page.items);
      items.value = page.items;
      totalCount.value = page.totalCount;
      initialized.value = true;
      hydrateThumbnails(page.items);
      // 刷新后沿用当前选中的那一张（可能刚被改名/换架），它不在列表里才退回最新一张。
      // 与 H5 的「每次渲染都重置到最新」有意不同：小程序从详情页返回会重新 load，
      // 重置会让用户刚挑的那张突然跳掉。
      const kept = page.items.find((item) => item.id === heroItem.value?.id);
      if (kept) heroItem.value = kept;
      else selectHero(page.items[0] ?? null);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : '陈列加载失败';
      if (initialized.value) uni.showToast({ title: message, icon: 'none' });
      else loadError.value = message;
    } finally {
      loading.value = false;
      refreshing.value = false;
    }
  })().finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}

/* 日期与「入库时长」已抽到 services/format.ts（formattedDate / daysAgoText），
   与「全部收藏」的详情卡共用同一口径，别在这页再写一份。 */

/* 选中某一张作为主展位展品：先翻回正面（对齐 H5 换袋子时的行为），再补拉详情。 */
function selectHero(item: CollectibleSummary | null) {
  heroItem.value = item;
  flipped.value = false;
  heroDetail.value = item ? detailCache.get(item.id) ?? null : null;
  if (!item || heroDetail.value) return;
  void dataService.collectible(item.id).then((detail) => {
    detailCache.set(item.id, detail);
    if (heroItem.value?.id === item.id) heroDetail.value = detail;
  }).catch(() => {
    // 详情拉不到：背面省略标签与备注即可，不弹提示打断首页
  });
}

/* 轻点挂袋：照 H5 的 pointerup「轻点」分支 —— 先给这张一个摆动冲量（"先荡一下"），
   再把内容送到上方主卡位，而不是直接进详情。
   同一张要能连点重播：先把类摘掉、下一拍再挂上，否则动画不会重新开始。 */
const kickedId = ref('');
let kickTimer: ReturnType<typeof setTimeout> | undefined;
let kickClearTimer: ReturnType<typeof setTimeout> | undefined;

function pickItem(item: CollectibleSummary) {
  selectHero(item);
  if (kickTimer) clearTimeout(kickTimer);
  if (kickClearTimer) clearTimeout(kickClearTimer);
  kickedId.value = '';
  kickTimer = setTimeout(() => {
    kickedId.value = item.id;
    kickClearTimer = setTimeout(() => { kickedId.value = ''; }, 2000);
  }, 20);
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

function flipBack() { flipped.value = false; }

function add() {
  uni.navigateTo({ url: '/package-editor/pages/add/index' });
}

onShow(() => {
  syncTabBar(0);
  void load();
});
onPullDownRefresh(() => void load().finally(() => uni.stopPullDownRefresh()));
</script>

<template>
  <view class="home-page">
    <view class="bags-header">
      <view class="bags-header__text">
        <text class="bags-title">袋袋集</text>
        <text class="bags-tagline">收集每一个纸袋的故事</text>
      </view>
      <button class="header-settings" aria-label="打开设置" @tap="openSettings">
        <image class="header-settings__icon" src="/static/figma/settings-nut.svg" mode="aspectFit" />
        <text>设置</text>
      </button>
    </view>

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

        <view class="flip-face flip-face--front">
          <image class="frame85-background" src="/static/figma/indexBg.svg" mode="scaleToFill" />
          <view class="glass-glow" />
          <view class="light-beam" />
          <view class="brand-badge">最新</view>

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
              <text class="front-caption__part">{{ heroItem.shelfName }}</text>
              <view class="front-caption__dot" />
              <text class="front-caption__part front-caption__part--fixed">{{ formattedDate(heroItem.addedAt) }}</text>
            </view>
          </view>

          <text class="flip-hint">轻点翻面 · 查看详情</text>
        </view>

        <view class="flip-face flip-face--back">
          <image class="frame85-background" src="/static/figma/indexBg.svg" mode="scaleToFill" />
          <view class="glass-glow" />
          <button class="flip-back" aria-label="翻回正面" @tap.stop="flipBack">
            <text>↺</text>
          </button>

          <view class="back-inner">
            <text v-if="heroNo" class="back-eyebrow">{{ heroNo }}</text>
            <text class="back-name">{{ heroItem.name }}</text>
            <text class="back-brand">{{ heroItem.shelfName }}</text>
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
            <button class="back-more" @tap.stop="openHero">查看完整详情 →</button>
          </view>
        </view>
      </view>

      <view v-else-if="!loading && !loadError" class="flip-card empty-card" @tap="add">
        <image class="frame85-background" src="/static/figma/indexBg.svg" mode="scaleToFill" />
        <image class="empty-illustration" src="/static/figma/empty-bag.svg" mode="aspectFit" />
        <view class="front-caption empty-caption">
          <text class="front-caption__title">暂无纸袋记录</text>
          <text class="front-caption__hint">每一个纸袋都有故事，期待你的记录</text>
        </view>
      </view>
    </view>

    <view v-if="items.length && !loadError" class="recent-section">
      <view class="recent-heading">
        <text class="recent-title">最近收集</text>
        <button class="recent-all" @tap="openLibrary">查看全部 <text class="recent-all-arrow">→</text></button>
      </view>
      <text class="stage-count">最近收藏 · {{ items.length }} 件</text>
      <scroll-view class="recent-scroll" scroll-x :show-scrollbar="false" @scroll="onRailScroll">
        <view class="recent-scene">
          <image class="rail-rope" src="/static/figma/rail-rope.png" mode="scaleToFill" />
          <view class="recent-row">
            <button
              v-for="(item, index) in items"
              :key="item.id"
              class="recent-item"
              :class="{ 'is-active': isHero(item) }"
              @tap="pickItem(item)"
            >
              <view
                class="rail-hang"
                :class="[index % 2 === 0 ? 'hang-tilt-right' : 'hang-tilt-left', kickedId === item.id ? 'is-kicking' : '']"
                :style="{ animationDelay: `${(index % 4) * -1.3}s, 0s` }"
              >
                <!-- 拖动这一排时的滞后摆动挂在这一层，与上层的轻晃 / 轻点摆动互不干扰 -->
                <view
                  class="rail-swing"
                  :class="{ 'is-releasing': railReleasing }"
                  :style="{ transform: `rotate(${railTilt}deg)` }"
                >
                  <view class="rail-clip" :style="{ top: `${clipTop(index)}rpx` }" />
                  <view class="rail-frame" :style="{ marginTop: `${hangDrop(index)}rpx` }">
                    <view class="rail-photo" :class="`tone-${railTone(index)}`">
                      <image
                        v-if="thumbnailUrls[item.id] && !failedThumbnails[item.id]"
                        :src="thumbnailUrls[item.id]"
                        mode="aspectFit"
                        lazy-load
                        @error="failedThumbnails[item.id] = true"
                      />
                      <view v-else class="recent-placeholder" />
                    </view>
                  </view>
                  <view class="rail-meta">
                    <text class="rail-name">{{ item.name }}</text>
                    <text class="rail-info">{{ item.shelfName }} · {{ shortDate(item.addedAt) }}</text>
                  </view>
                </view>
              </view>
            </button>
          </view>
        </view>
      </scroll-view>
      <text class="rack-hint">↤ 左右滑动 · 轻点在上方查看 ↦</text>
    </view>
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
.home-page { min-height: 100vh; padding: 0 0 206rpx; overflow: hidden; background-color: #f2f3f7; }

/* ── 头部：一级标题 + 辅助文案，右侧玻璃托底「设置」入口（H5 .bags-header / .header-settings）── */
.bags-header { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; padding: 18rpx 36rpx 29rpx; }
.bags-header__text { display: flex; flex-direction: column; min-width: 0; }
/* 一级标题：H5 .bags-title 是 38px × 1.82 = 69rpx（900 / 字距 2px = 3.6rpx）。
   ⚠ 这一档**没有**用微信六档的 Headline(44rpx)：首页的「袋袋集」和「全部收藏」在 H5 里
   共用同一个 .bags-title，两页必须一样大（用户 2026-09-24 专门点过这件事）。
   想改字号两页一起改，别只动这一处。 */
/* 字体栈照搬 H5 的 h1（袋袋集原型.html:117）：Iowan Old Style / Baskerville 都是 iOS 系统
   衬线，中文没有对应字形会回退到 "Songti SC"（宋体）—— 截图里「袋袋集」的宋体感就来自这里。
   Android 上前面几个都缺失，落到通用 serif，属于预期内的降级。 */
.bags-title { margin-bottom: 11rpx; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 69rpx; font-weight: 900; line-height: 1; letter-spacing: 3.6rpx; }
/* 辅助内容：EmDesc 14pt（与「全部收藏」的副文案同档，两页一致） */
.bags-tagline { color: #77736d; font-size: var(--wc-font-description); line-height: 1.4; }
/* H5 padding 9px 12px 7px、radius 16px、图标 24px；文字走注释档 Footnote 12pt */
.header-settings { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 5rpx; min-width: 0; margin: 0; padding: 16rpx 22rpx 13rpx; border: 2rpx solid rgba(255,255,255,.75); border-radius: 29rpx; background: rgba(255,255,255,.6); box-shadow: 0 11rpx 25rpx rgba(52,66,92,.08), inset 0 2rpx 0 rgba(255,255,255,.8); color: #77736d; font-size: var(--wc-font-footnote); font-weight: 650; line-height: 1.1; letter-spacing: 2rpx; }
.header-settings__icon { width: 44rpx; height: 44rpx; }

.load-error { margin: 28rpx 36rpx; padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: var(--wc-font-description); text-align: center; }

/* ── 主展位：玻璃卡 + 3D 翻面（H5 .stage-section / .flip-card）── */
/* H5 margin: 0 18px 26px；perspective 让子元素的 3D 变换不被父层压平 */
.stage-section { margin: 0 33rpx 47rpx; perspective: 1400px; }
/* 卡片宽度：H5 是 308/412（左右各留 52px），按需求把左右间隔收到 47rpx（≈26px），
   于是 750 − 47×2 = 656rpx。高度按放大后的字号抬到 660rpx（两面都装得下）。
   rotateY(-180deg) 是「把卡片向右翻过去」的方向。 */
.flip-card { position: relative; width: 656rpx; height: 660rpx; margin: 0 auto; border: 2rpx solid rgba(255,255,255,.62); border-radius: 47rpx; transform-style: preserve-3d; transition: transform .78s cubic-bezier(.2,.78,.22,1); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.9), 0 29rpx 65rpx rgba(52,66,92,.16), 0 5rpx 18rpx rgba(52,66,92,.07); }
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
.flip-face--front { z-index: 1; display: flex; flex-direction: column; align-items: center; padding: 33rpx 36rpx 46rpx; }
.flip-face--back { z-index: 2; transform: rotateY(-180deg); opacity: 0; }
.flip-card.is-flipped .flip-face--front { opacity: 0; transition: opacity .06s linear 0s; }
.flip-card.is-flipped .flip-face--back { opacity: 1; transition: opacity .1s linear .11s; }
.flip-card:not(.is-flipped) .flip-face--front { opacity: 1; transition: opacity .1s linear .11s; }
.flip-card:not(.is-flipped) .flip-face--back { opacity: 0; transition: opacity .06s linear 0s; }

/* 卡片底：H5 正面走「宫格卡片那套底色」——左上微亮 / 右下微暗 + 1px 内白边。
   indexBg.svg 自带右上角那束暖黄斜光（与 H5 的 light-beam 同源）。 */
.frame85-background { position: absolute; z-index: 0; top: 0; left: 0; width: 100%; height: 100%; border-radius: 47rpx; background: linear-gradient(160deg, #fbfbfd, #eef0f4); pointer-events: none; }
/* 左上角冷白高光 + 1px 内白边（H5 .glass-glow / .flip-face--front）。
   内白边必须画在这一层而不是卡片底图上：底图是替换元素，会整块盖住自身的 inset 阴影。 */
.glass-glow { position: absolute; z-index: 1; top: 0; left: 0; right: 0; bottom: 0; border-radius: 47rpx; box-shadow: inset 0 0 0 2rpx rgba(255,255,255,.9); pointer-events: none; background: radial-gradient(120% 78% at 16% -12%, rgba(255,255,255,.95) 0%, rgba(255,255,255,0) 58%), linear-gradient(128deg, rgba(255,255,255,.5) 0%, rgba(255,255,255,0) 34%, rgba(255,255,255,0) 66%, rgba(255,255,255,.34) 100%); }
/* 卡面顶沿一道细亮线：射灯打在玻璃上沿的反光（H5 .light-beam::before） */
.light-beam { position: absolute; z-index: 2; top: 22rpx; right: 11rpx; left: 34%; height: 3rpx; border-radius: 4rpx; pointer-events: none; background: linear-gradient(90deg, rgba(255,236,190,0) 0%, rgba(255,246,220,.9) 58%, rgba(255,236,190,0) 100%); }

/* 右上角「最新」徽标（H5 .brand-badge：top/right 12px、padding 4px 10px、radius 12px）
   文字走注释档 Footnote */
.brand-badge { position: absolute; z-index: 4; top: 22rpx; right: 22rpx; padding: 7rpx 18rpx; border-radius: 22rpx; background: rgba(255,255,255,.58); box-shadow: inset 0 2rpx 0 rgba(255,255,255,.9), 0 6rpx 18rpx rgba(40,34,24,.09); color: #96703a; font-size: var(--wc-font-footnote); font-weight: 700; line-height: 1.1; letter-spacing: 1rpx; }

/* 袋子区：H5 固定 248px 高、宽度按图片自身比例（这里交给 aspectFit 在定高框内等比居中） */
.flip-face__art { position: relative; z-index: 3; flex: 0 0 auto; width: 100%; height: 451rpx; }
.flip-face__art image { width: 100%; height: 451rpx; filter: drop-shadow(0 7rpx 18rpx rgba(0,0,0,.18)); }
.art-placeholder { position: absolute; left: 50%; top: 50%; width: 258rpx; height: 340rpx; margin: -170rpx 0 0 -129rpx; border-radius: 28rpx; background: rgba(255,255,255,.46); }

/* 袋子下方两行：名字（二级标题 EmTitle 17pt）+「品牌 · 日期」（EmDesc 14pt） */
.front-caption { position: relative; z-index: 3; flex: 0 0 auto; width: 100%; margin-top: 15rpx; text-align: center; }
/* 卡片标题是另一套栈（H5 .front-caption__title / .back-name，均以 Georgia 打头） */
.front-caption__title { display: block; color: #1a1815; font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: var(--wc-font-em-title); font-weight: 700; line-height: 1.2; letter-spacing: .2rpx; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.front-caption__sub { display: flex; align-items: center; justify-content: center; gap: 13rpx; margin-top: 9rpx; color: #8d877c; font-size: var(--wc-font-description); line-height: 1.4; letter-spacing: .4rpx; }
.front-caption__part { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.front-caption__part--fixed { flex: 0 0 auto; }
.front-caption__dot { flex: 0 0 auto; width: 6rpx; height: 6rpx; border-radius: 50%; background: currentColor; opacity: .55; }

/* 轻点提示：贴卡片底部通栏居中，走注释档 Footnote */
.flip-hint { position: absolute; z-index: 4; bottom: 11rpx; left: 0; right: 0; color: #c0bab1; font-size: var(--wc-font-footnote); line-height: 1.2; text-align: center; pointer-events: none; }

/* ── 背面：详细信息（H5 .back-inner 起）── */
.back-inner { position: relative; z-index: 3; height: 100%; display: flex; flex-direction: column; padding: 29rpx 33rpx 25rpx; overflow: hidden; }
.back-eyebrow { color: #77736d; font-size: var(--wc-font-footnote); font-weight: 700; line-height: 1.2; letter-spacing: 3rpx; }
.back-name { margin-top: 7rpx; color: #1d1a15; font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: var(--wc-font-em-title); font-weight: 600; line-height: 1.2; }
.back-brand { margin-top: 9rpx; color: #6f6a62; font-size: var(--wc-font-description); line-height: 1.4; }
.back-divider { height: 1rpx; margin: 20rpx 0; background: linear-gradient(90deg, rgba(20,20,20,.12), rgba(20,20,20,.04) 70%, transparent); }
.back-facts { display: flex; flex-direction: column; gap: 10rpx; }
.back-facts__row { display: flex; align-items: baseline; justify-content: space-between; gap: 18rpx; }
.back-facts__key { flex: 0 0 auto; color: #77736d; font-size: var(--wc-font-description); line-height: 1.4; letter-spacing: .6rpx; }
.back-facts__value { flex: 0 1 auto; min-width: 0; color: #2b2720; font-size: var(--wc-font-description); font-weight: 600; line-height: 1.4; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.back-tags { display: flex; flex-wrap: wrap; gap: 9rpx; margin-top: 20rpx; }
.back-tags text { padding: 7rpx 16rpx; border-radius: 18rpx; background: rgba(20,20,20,.055); color: #5d594f; font-size: var(--wc-font-footnote); line-height: 1.2; }
/* 备注：引用式文字，走辅助档 EmDesc。后端 notes 最长 2000 字而卡内高度固定，
   限两行裁掉（原 H5 是不裁的，但字号从 10px 提到 14pt 后三行装不下） */
.back-note { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; margin-top: 20rpx; padding: 15rpx 18rpx; border-left: 4rpx solid rgba(20,20,20,.14); border-radius: 0 16rpx 16rpx 0; background: rgba(20,20,20,.035); color: #5f5b53; font-size: var(--wc-font-description); line-height: 1.55; }
/* 详情页入口：挂袋区点击改成「送到上方主卡位」后，进详情的入口落在这里 */
.back-more { display: flex; align-items: center; justify-content: center; min-height: 0; margin: auto 0 0; padding: 0; border: 0; background: transparent; color: #8a8479; font-size: var(--wc-font-description); line-height: 1.4; letter-spacing: .4rpx; }
/* 背面右上角的「翻回去」：图标按钮不受字号规范约束，z-index 必须高于
   .flip-card__hit(6) 才点得到（H5 .flip-back） */
.flip-back { position: absolute; z-index: 8; top: 22rpx; right: 22rpx; display: flex; align-items: center; justify-content: center; width: 51rpx; height: 51rpx; min-width: 0; margin: 0; padding: 0; border: 0; border-radius: 50%; background: rgba(20,20,20,.055); color: #6d675e; font-size: 30rpx; line-height: 1; }

/* 空状态：卡片收成一个安静的占位，不参与翻面 */
.empty-card { display: flex; flex-direction: column; align-items: center; }
.empty-illustration { position: absolute; z-index: 3; left: 50%; top: 82rpx; width: 334rpx; height: 332rpx; margin-left: -167rpx; }
.empty-caption { position: absolute; z-index: 3; left: 36rpx; right: 36rpx; bottom: 78rpx; }
.front-caption__hint { display: block; margin-top: 9rpx; color: #8d877c; font-size: var(--wc-font-description); line-height: 1.5; }

/* 骨架屏 */
.skeleton-card { display: flex; flex-direction: column; align-items: center; padding-top: 33rpx; border-color: transparent; background: rgba(255,255,255,.32); box-shadow: none; }
.skeleton-art { width: 470rpx; height: 451rpx; border-radius: 34rpx; background: rgba(255,255,255,.7); }
.skeleton-line { width: 260rpx; height: 24rpx; margin-top: 18rpx; border-radius: 999rpx; background: rgba(255,255,255,.75); }
.skeleton-line--wide { width: 340rpx; margin-top: 48rpx; }

/* ── 最近收集（H5 .rack-section / .section-heading / .stage-count）── */
.recent-section { margin-top: 6rpx; }
/* H5 .section-heading：两端对齐、基线贴底 */
.recent-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16rpx; padding: 0 40rpx 6rpx; }
/* 区块标题：二级标题 EmTitle 17pt（h2 默认 bold，跟 H5 的 700） */
.recent-title { color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: var(--wc-font-em-title); font-weight: 700; line-height: 1.05; letter-spacing: -1rpx; }
.recent-all { min-height: 0; margin: 0 0 6rpx; padding: 0; border: 0; background: transparent; color: #77736d; font-size: var(--wc-font-description); line-height: 32rpx; }
.recent-all-arrow { color: #141414; margin-left: 6rpx; }
.stage-count { display: block; padding: 0 40rpx 22rpx; color: #77736d; font-size: var(--wc-font-description); line-height: 1.4; }
/* 挂袋区通栏：scroll-view 铺满整块屏幕，绳子（width:100%）才能真正顶到左右尽头 */
.recent-scroll { position: relative; z-index: 1; width: 100%; }
.recent-scene { position: relative; display: inline-flex; min-width: 100%; padding: 96rpx 24rpx 28rpx; }
/* 宽度必须用 CSS 100%（相对 recent-scene 的 padding box = 整条内容宽）：
   实测微信对 image 内联 style 里的动态 rpx 宽度不生效，元素会回落到默认 320px，
   导致绳子两头够不到屏幕边缘 */
.rail-rope { position: absolute; z-index: 0; left: 0; top: 40rpx; width: 100%; height: 56rpx; pointer-events: none; }
.recent-row { position: relative; z-index: 1; display: inline-flex; align-items: flex-start; }
.recent-item { width: 220rpx; flex: 0 0 220rpx; margin: 0; padding: 0; overflow: visible; background: transparent; text-align: center; transition: transform .28s cubic-bezier(.2,.8,.25,1); }
.recent-item + .recent-item { margin-left: -40rpx; }
.rail-hang { position: relative; transform-origin: 50% 0; }
/* ── 拖动这一排时的滞后摆动层 ──
   两层变换叠加：父层（.rail-hang）跑常态轻晃 / 轻点摆动，本层跑拖动倾斜，
   分开是为了不互相覆盖 —— 同一个 transform 上，动画会压掉 inline 样式。
   倾角由脚本按滚动速度写成 inline transform；松手时切到带过冲的曲线弹回（模拟弹簧落回），
   .16s 的短过渡把脚本 80ms 一次的台阶抹平。 */
.rail-swing { position: relative; transform-origin: 50% 0; transition: transform .16s ease-out; }
.rail-swing.is-releasing { transition: transform .62s cubic-bezier(.34,1.42,.5,1); }
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
.rail-clip { position: absolute; z-index: 3; left: 50%; width: 52rpx; height: 52rpx; margin-left: -26rpx; border: 2rpx solid rgba(150,115,65,.45); border-radius: 50%; background: radial-gradient(circle at 35% 28%, #f2e2c0 0%, #e5cfa2 55%, #d4ba8a 100%); box-shadow: 0 2rpx 5rpx rgba(30,22,8,.3), inset 0 2rpx 0 rgba(255,255,255,.4); }
/* 孔环夹子的三层（H5 .rack-clip 逐值照搬，之前那张 figma SVG 的「内圈奶油色圆盘 + 大深孔」
   与 H5 不符 —— H5 是「暖铜垫片外圈 + 冷灰钢孔环内圈 + 很小的深色孔洞」，内圈只占 38%）。
   尺寸：H5 按卡片宽 ×0.236 缩放 → 220rpx × 0.236 ≈ 52rpx；内圈 10/26 → 20rpx；孔洞 3.5/26 → 7rpx。
   用 margin 而不是 translate(-50%,-50%) 居中，免得和父层变换打架。 */
.rail-clip::before { content: ""; position: absolute; top: 50%; left: 50%; width: 20rpx; height: 20rpx; margin: -10rpx 0 0 -10rpx; border: 2rpx solid rgba(105,115,127,.65); border-radius: 50%; background: radial-gradient(circle at 35% 28%, #fdfefe 0%, #d7dde3 40%, #aeb7c0 72%, #8e99a3 100%); box-shadow: inset 0 2rpx 2rpx rgba(255,255,255,.85), 0 2rpx 4rpx rgba(40,48,58,.35); }
.rail-clip::after { content: ""; position: absolute; top: 50%; left: 50%; width: 7rpx; height: 7rpx; margin: -3.5rpx 0 0 -3.5rpx; border-radius: 50%; background: #2b3038; }
.rail-frame { position: relative; z-index: 1; padding: 10rpx; border: 3rpx solid #8a6f45; border-radius: 8rpx; background: rgba(255, 255, 255, .26); box-shadow: 0 6rpx 20rpx rgba(60, 45, 20, .14), inset 0 2rpx 0 rgba(255, 255, 255, .4); }
.rail-photo { position: relative; display: flex; align-items: center; justify-content: center; height: 284rpx; border-radius: 4rpx; overflow: hidden; }
.rail-photo image { width: 96%; height: 90%; filter: drop-shadow(0 12rpx 16rpx rgba(0, 0, 0, .28)); }
.recent-placeholder { width: 120rpx; height: 200rpx; border-radius: 12rpx; background: rgba(255, 255, 255, .4); }
.rail-meta { padding: 14rpx 6rpx 0; }
/* 挂袋名字走三级标题 EmGroupTitle 15pt，副信息走注释档 Footnote 12pt */
/* H5 的 .rack-meta strong 只写 `Georgia, serif`，比卡片标题那套更素 */
.rail-name { display: block; overflow: hidden; color: #4a3a22; font-family: Georgia, serif; font-size: var(--wc-font-group-title); font-weight: 700; line-height: 40rpx; white-space: nowrap; text-overflow: ellipsis; }
.rail-info { display: block; overflow: hidden; margin-top: 4rpx; color: #a09274; font-size: var(--wc-font-footnote); line-height: 32rpx; white-space: nowrap; text-overflow: ellipsis; }
/* 选中态：当前正在主展位展示的那一张（H5 .rack-item.is-active） */
.recent-item.is-active { transform: translateY(-7rpx); }
.recent-item.is-active .rail-frame { border-color: #c8891f; box-shadow: 0 11rpx 29rpx rgba(160,110,20,.26), inset 0 2rpx 0 rgba(255,255,255,.5); }
.recent-item.is-active .rail-name { color: #8a5a10; }
.recent-item.is-active .rail-clip { box-shadow: 0 0 0 5rpx rgba(240,154,42,.3), 0 2rpx 5rpx rgba(30,22,8,.3); }
.rack-hint { display: block; padding: 15rpx 36rpx 0; color: #77736d; font-size: var(--wc-font-description); line-height: 1.4; text-align: center; opacity: .8; }
/* 卡片内衬的 6 种复古底色，按渲染顺序循环（同 h5-prototype BAG_COLOR_CLASSES） */
.tone-vermillion { background: linear-gradient(180deg, rgba(255,255,255,.12), rgba(0,0,0,.08)), linear-gradient(160deg, rgba(255,224,196,.14) 0%, transparent 45%), repeating-linear-gradient(37deg, rgba(255,224,196,.08) 0 2rpx, transparent 2rpx 38rpx), repeating-linear-gradient(-52deg, rgba(255,224,196,.06) 0 2rpx, transparent 2rpx 54rpx), repeating-linear-gradient(84deg, rgba(255,224,196,.05) 0 2rpx, transparent 2rpx 66rpx), #a22d2c; }
.tone-kraft { background: linear-gradient(180deg, rgba(255,255,255,.12), rgba(0,0,0,.08)), repeating-linear-gradient(105deg, transparent 0 28rpx, rgba(255,255,255,.07) 28rpx 32rpx), #bd8958; }
.tone-blue { background: linear-gradient(180deg, rgba(255,255,255,.12), rgba(0,0,0,.08)), repeating-linear-gradient(60deg, rgba(255,255,255,.16) 0 3rpx, transparent 3rpx 26rpx), repeating-linear-gradient(-60deg, rgba(255,255,255,.1) 0 3rpx, transparent 3rpx 26rpx), #1e5c90; }
.tone-black { background: linear-gradient(180deg, rgba(255,255,255,.12), rgba(0,0,0,.08)), linear-gradient(145deg, transparent 0 54%, rgba(255,255,255,.12) 54% 56%, transparent 56%), #242323; }
.tone-green { background: linear-gradient(180deg, rgba(255,255,255,.12), rgba(0,0,0,.08)), repeating-radial-gradient(ellipse at 20% 20%, transparent 0 24rpx, rgba(242,221,150,.19) 24rpx 30rpx), #458951; }
.tone-pink { background: linear-gradient(180deg, rgba(255,255,255,.12), rgba(0,0,0,.08)), radial-gradient(circle at 15% 20%, rgba(255,255,255,.28) 0 4rpx, transparent 5rpx), radial-gradient(circle at 45% 60%, rgba(255,255,255,.22) 0 3rpx, transparent 4rpx), radial-gradient(circle at 75% 25%, rgba(255,255,255,.24) 0 4rpx, transparent 5rpx), radial-gradient(circle at 30% 85%, rgba(255,255,255,.2) 0 3rpx, transparent 4rpx), radial-gradient(circle at 85% 70%, rgba(255,255,255,.22) 0 4rpx, transparent 5rpx), radial-gradient(circle at 60% 40%, rgba(255,255,255,.18) 0 3rpx, transparent 4rpx), #f1718b; }
</style>
