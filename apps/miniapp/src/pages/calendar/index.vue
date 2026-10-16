<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type { CollectibleSummary } from '../../types';
import { dataService } from '../../services/data';

/* ── 收藏日历页（从首页日历入口进入）──
   把「标记袋子」映射为收藏记录 addedAt：添加收藏与「标记已有」都会生成带 addedAt 的记录。
   按本地时区归组到日期，月视图（周日为首日）里有收藏的日期直接铺当天袋子缩略图；
   页面底部双卡：左「本月」统计、右「文件夹」今日收藏。数据源 = GET /collectibles，无后端改动。 */

const statusBarHeight = ref(20);
// #ifdef MP-WEIXIN
try {
  statusBarHeight.value = uni.getSystemInfoSync().statusBarHeight ?? 20;
} catch {
  /* 取不到就用默认值 */
}
// #endif

const WEEK_DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const keyOf = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

const loading = ref(true);
const initialized = ref(false);
const loadError = ref('');
/* 收藏按本地日期归组：'YYYY-MM-DD' → 当天收藏列表 */
const grouped = ref<Map<string, CollectibleSummary[]>>(new Map());
/* 某天缩略图加载失败 → 该日期回退为数字格 */
const failedThumbs = ref<Record<string, boolean>>({});

const now = new Date();
const todayKeyStr = keyOf(now.getFullYear(), now.getMonth(), now.getDate());
const viewYear = ref(now.getFullYear());
const viewMonth = ref(now.getMonth()); // 0-11
const selectedDate = ref('');

interface Cell {
  key: string;
  date: string;
  day: number;
  count: number;
  isToday: boolean;
  inMonth: boolean;
}

function fullDateLabel(dateKey: string) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const weekday = WEEK_DAYS[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日，${weekday}`;
}

const isViewingToday = computed(() => viewYear.value === now.getFullYear() && viewMonth.value === now.getMonth());
const monthLabel = computed(() => `${viewYear.value}年${viewMonth.value + 1}月`);

/* 头部标题：选中日 →「M月D日」；查看当前月 →「今天」；其他月 →「YYYY年M月」 */
const headTitle = computed(() => {
  if (selectedDate.value) {
    const [, m, d] = selectedDate.value.split('-').map(Number);
    return `${m}月${d}日`;
  }
  return isViewingToday.value ? '今天' : monthLabel.value;
});

/* 本月统计：当月件数 + 去重店铺数（shelfName） */
const monthStats = computed(() => {
  let count = 0;
  const shelves = new Set<string>();
  const prefix = `${viewYear.value}-${pad2(viewMonth.value + 1)}`;
  for (const [key, list] of grouped.value) {
    if (!key.startsWith(prefix)) continue;
    count += list.length;
    for (const item of list) if (item.shelfName) shelves.add(item.shelfName);
  }
  return { count, shelves: shelves.size };
});

const headSubtitle = computed(() => {
  if (selectedDate.value) return fullDateLabel(selectedDate.value);
  if (isViewingToday.value) return fullDateLabel(todayKeyStr);
  return `${monthStats.value.count} 件收藏`;
});

/* 今日收藏（文件夹卡）；只取有缩略图的前 3 张 */
const todayBags = computed(() => grouped.value.get(todayKeyStr) ?? []);
const folderBags = computed(() => todayBags.value.filter((item) => item.thumbnailUrl).slice(0, 3));

/* 某天的封面缩略图（当天第一件） */
function coverOf(date: string) {
  return grouped.value.get(date)?.[0]?.thumbnailUrl ?? '';
}

/* 月视图网格：周日为首日，前置空位按当月 1 号星期几计算，行数随天数自适应（5/6 行） */
const cells = computed<Cell[]>(() => {
  const leading = new Date(viewYear.value, viewMonth.value, 1).getDay();
  const daysInMonth = new Date(viewYear.value, viewMonth.value + 1, 0).getDate();
  const total = Math.ceil((leading + daysInMonth) / 7) * 7;
  const result: Cell[] = [];
  for (let i = 0; i < total; i++) {
    if (i < leading || i >= leading + daysInMonth) {
      result.push({ key: `blank-${i}`, date: '', day: 0, count: 0, isToday: false, inMonth: false });
      continue;
    }
    const day = i - leading + 1;
    const date = keyOf(viewYear.value, viewMonth.value, day);
    result.push({
      key: date,
      date,
      day,
      count: grouped.value.get(date)?.length ?? 0,
      isToday: date === todayKeyStr,
      inMonth: true
    });
  }
  return result;
});

function groupByDay(items: CollectibleSummary[]) {
  const map = new Map<string, CollectibleSummary[]>();
  for (const item of items) {
    const d = new Date(item.addedAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = keyOf(d.getFullYear(), d.getMonth(), d.getDate());
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

let refreshPromise: Promise<void> | undefined;
function load() {
  if (refreshPromise) return refreshPromise;
  if (!initialized.value) loading.value = true;
  loadError.value = '';
  refreshPromise = (async () => {
    try {
      /* limit=1000 单次基本覆盖个人收藏；仍有 nextCursor 时循环翻页聚合全部 addedAt */
      const all: CollectibleSummary[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const query = `limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await dataService.collectibles(query);
        all.push(...page.items);
        cursor = page.nextCursor;
        guard += 1;
      } while (cursor && guard < 50);
      grouped.value = groupByDay(all);
      initialized.value = true;
    } catch (error) {
      console.error(error);
      loadError.value = error instanceof Error ? error.message : '收藏加载失败';
    } finally {
      loading.value = false;
    }
  })().finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}

function goBack() {
  uni.navigateBack({ delta: 1 });
}

function prevMonth() {
  viewMonth.value -= 1;
  if (viewMonth.value < 0) { viewMonth.value = 11; viewYear.value -= 1; }
}

function nextMonth() {
  viewMonth.value += 1;
  if (viewMonth.value > 11) { viewMonth.value = 0; viewYear.value += 1; }
}

function tapDay(cell: Cell) {
  if (!cell.inMonth) return;
  selectedDate.value = selectedDate.value === cell.date ? '' : cell.date;
}

onShow(() => {
  void load();
});
</script>

<template>
  <view class="cal-page">
    <!-- 顶部：状态栏留白 + 返回 + 居中标题/副标题 -->
    <view class="cal-head" :style="{ paddingTop: `${statusBarHeight}px` }">
      <view class="cal-nav">
        <view class="cal-back" hover-class="is-pressed" :hover-stay-time="80" @tap="goBack">
          <image class="cal-back__icon" src="/static/figma/back.svg" mode="aspectFit" />
        </view>
        <view class="cal-nav__title">
          <text class="cal-title">{{ headTitle }}</text>
          <text class="cal-subtitle">{{ headSubtitle }}</text>
        </view>
        <view class="cal-nav__spacer" />
      </view>
    </view>

    <scroll-view class="cal-scroll" scroll-y enhanced :show-scrollbar="false">
      <view class="cal-body">
        <!-- 月份切换 -->
        <view class="cal-switch">
          <view class="cal-switch__btn" hover-class="is-pressed" :hover-stay-time="80" @tap="prevMonth">
            <image class="cal-switch__icon" src="/static/figma/arrow-left.svg" mode="aspectFit" />
          </view>
          <text class="cal-switch__label">{{ monthLabel }}</text>
          <view class="cal-switch__btn" hover-class="is-pressed" :hover-stay-time="80" @tap="nextMonth">
            <image class="cal-switch__icon" src="/static/figma/arrow-right.svg" mode="aspectFit" />
          </view>
        </view>

        <!-- 白色日历卡：星期头 + 日期网格 -->
        <view class="cal-card">
          <view class="cal-week">
            <text v-for="w in WEEK_DAYS" :key="w" class="cal-week__item">{{ w }}</text>
          </view>

          <view v-if="loading && !initialized" class="cal-grid">
            <view v-for="i in 35" :key="i" class="cal-cell cal-cell--skeleton" />
          </view>
          <view v-else class="cal-grid">
            <view
              v-for="cell in cells"
              :key="cell.key"
              class="cal-cell"
              :class="{
                'is-blank': !cell.inMonth,
                'is-today': cell.isToday,
                'has-thumb': cell.count > 0 && !!coverOf(cell.date) && !failedThumbs[cell.date]
              }"
              @tap="tapDay(cell)"
            >
              <template v-if="cell.inMonth">
                <image
                  v-if="cell.count > 0 && coverOf(cell.date) && !failedThumbs[cell.date]"
                  class="cal-cell__thumb"
                  :src="coverOf(cell.date)"
                  mode="aspectFill"
                  @error="failedThumbs[cell.date] = true"
                />
                <text v-else class="cal-cell__num">{{ cell.day }}</text>
                <view v-if="cell.count > 1" class="cal-cell__badge">×{{ cell.count }}</view>
              </template>
            </view>
          </view>
        </view>

        <view v-if="loadError" class="cal-error">{{ loadError }}</view>

        <!-- 底部双卡：本月统计 + 今日文件夹 -->
        <view class="cal-bottom">
          <view class="stat-card">
            <text class="stat-card__eyebrow">本月</text>
            <view class="stat-card__num-row">
              <text class="stat-card__num">{{ monthStats.count }}</text>
              <text class="stat-card__unit">件</text>
            </view>
            <text class="stat-card__sub">{{ monthStats.shelves }} 家店铺</text>
          </view>

          <view class="folder-card">
            <text class="folder-card__eyebrow">今日</text>
            <view class="folder">
              <image
                v-for="(bag, index) in folderBags"
                :key="bag.id"
                class="folder__item"
                :class="`folder__item--${index}`"
                :src="bag.thumbnailUrl"
                mode="aspectFill"
              />
              <text v-if="!folderBags.length" class="folder__empty">今天还没有收藏</text>
              <view class="folder__front"><view class="folder__tab" /></view>
            </view>
          </view>
        </view>
      </view>
    </scroll-view>
  </view>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   收藏日历 —— 暖纸质感 + 白色大圆角卡 + 缩略图标签日期格 + 底部双卡。
   参考图：周日为首日、非当月留空、有收藏的日期直铺袋子缩略图、
   今日白底焦糖描边环、右下文件夹装今日袋子。 */
.cal-page { position: relative; height: 100vh; display: flex; flex-direction: column; overflow: hidden; background-color: #f5f1e9; }
.cal-scroll { flex: 1 1 auto; min-height: 0; }
.cal-body { padding: 8rpx 32rpx 60rpx; }

/* ── 顶部 ── */
.cal-head { flex: 0 0 auto; padding: 0 30rpx 6rpx; }
.cal-nav { display: flex; align-items: center; height: 96rpx; }
.cal-back { display: flex; align-items: center; justify-content: center; flex: 0 0 56rpx; width: 56rpx; height: 56rpx; margin-left: -14rpx; border-radius: 50%; transition: background .18s ease; }
.cal-back__icon { width: 22rpx; height: 38rpx; }
.cal-back.is-pressed { background: rgba(20,20,20,.06); }
.cal-nav__title { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; align-items: center; }
.cal-nav__spacer { flex: 0 0 42rpx; }
.cal-title { color: #2e2820; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 46rpx; font-weight: 800; letter-spacing: 1rpx; line-height: 1.1; }
.cal-subtitle { margin-top: 8rpx; color: #a69a88; font-size: 24rpx; letter-spacing: 1rpx; line-height: 1.2; }

/* ── 月份切换 ── */
.cal-switch { display: flex; align-items: center; justify-content: center; gap: 30rpx; padding: 20rpx 0 26rpx; }
.cal-switch__btn { display: flex; align-items: center; justify-content: center; width: 56rpx; height: 56rpx; border-radius: 50%; background: rgba(255,255,255,.7); transition: transform .18s ease; }
.cal-switch__btn.is-pressed { transform: scale(.9); }
.cal-switch__icon { width: 28rpx; height: 28rpx; }
.cal-switch__label { min-width: 220rpx; color: #4a4036; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 34rpx; font-weight: 700; letter-spacing: 2rpx; text-align: center; }

/* ── 白色日历卡 ── */
.cal-card { padding: 30rpx 26rpx 32rpx; border-radius: 40rpx; background: #ffffff; box-shadow: 0 16rpx 44rpx rgba(120,96,60,.12), inset 0 2rpx 0 rgba(255,255,255,.9); }
.cal-week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10rpx; padding: 0 4rpx 16rpx; }
.cal-week__item { color: #b0a795; font-size: 22rpx; line-height: 1; text-align: center; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 12rpx 10rpx; }

/* 日期方块：浅米色圆角，非当月留空 */
.cal-cell { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 88rpx; border-radius: 18rpx; background: #efeae0; overflow: hidden; }
.cal-cell__num { color: #5c5145; font-size: 26rpx; font-weight: 600; line-height: 1; }
.cal-cell.is-blank { background: transparent; }
/* 有收藏：白底铺缩略图（aspectFill 填满圆角格） */
.cal-cell__thumb { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
.cal-cell.has-thumb { background: #ffffff; }
/* 今日（无收藏）：焦糖实心 + 白字 */
.cal-cell.is-today { background: linear-gradient(160deg, #e0a95a, #d1904a); }
.cal-cell.is-today .cal-cell__num { color: #ffffff; }
/* 今日且有收藏：白底 + 焦糖描边环 */
.cal-cell.is-today.has-thumb { background: #ffffff; box-shadow: inset 0 0 0 4rpx #d99c4f; }
/* ×N 角标：当天多件 */
.cal-cell__badge { position: absolute; z-index: 3; top: 4rpx; right: 4rpx; min-width: 30rpx; height: 30rpx; padding: 0 8rpx; border-radius: 999rpx; background: #e0864a; color: #ffffff; font-size: 18rpx; font-weight: 700; line-height: 30rpx; text-align: center; box-shadow: 0 2rpx 6rpx rgba(180,110,50,.4); }
/* 骨架占位 */
.cal-cell--skeleton { background: rgba(239,234,224,.6); }

.cal-error { margin: 28rpx 8rpx; padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: 24rpx; text-align: center; }

/* ── 底部双卡 ── */
.cal-bottom { display: flex; gap: 20rpx; margin-top: 24rpx; }
.stat-card, .folder-card { flex: 1 1 0; min-width: 0; border-radius: 30rpx; background: #fffdf8; box-shadow: 0 12rpx 34rpx rgba(120,96,60,.1), inset 0 2rpx 0 rgba(255,255,255,.9); }
/* 左卡：本月统计 */
.stat-card { padding: 26rpx 26rpx 28rpx; }
.stat-card__eyebrow { display: block; color: #b0a795; font-size: 22rpx; letter-spacing: 2rpx; }
.stat-card__num-row { display: flex; align-items: baseline; gap: 8rpx; margin-top: 4rpx; }
.stat-card__num { color: #2e2820; font-family: Georgia, "Iowan Old Style", "Songti SC", serif; font-size: 64rpx; font-weight: 800; line-height: 1; }
.stat-card__unit { color: #5c5145; font-size: 24rpx; font-weight: 600; }
.stat-card__sub { display: block; margin-top: 12rpx; color: #8d877c; font-size: 22rpx; }
/* 右卡：文件夹 */
.folder-card { display: flex; flex-direction: column; padding: 26rpx 22rpx 22rpx; }
.folder-card__eyebrow { display: block; color: #b0a795; font-size: 22rpx; letter-spacing: 2rpx; }
.folder { position: relative; flex: 1 1 auto; margin-top: 16rpx; min-height: 148rpx; }
.folder__item { position: absolute; bottom: 44rpx; width: 88rpx; height: 118rpx; border-radius: 10rpx; box-shadow: 0 6rpx 14rpx rgba(70,52,30,.2); }
.folder__item--0 { left: 14rpx; transform: rotate(-7deg); z-index: 1; }
.folder__item--1 { left: 84rpx; transform: rotate(4deg); z-index: 2; }
.folder__item--2 { left: 150rpx; transform: rotate(-3deg); z-index: 3; }
.folder__front { position: absolute; z-index: 4; left: 0; right: 0; bottom: 0; height: 48rpx; border-radius: 8rpx 8rpx 14rpx 14rpx; background: linear-gradient(180deg, #eddeb9, #d9c091); box-shadow: 0 6rpx 14rpx rgba(70,52,30,.14); }
.folder__tab { position: absolute; top: -14rpx; left: 10rpx; width: 120rpx; height: 16rpx; border-radius: 8rpx 8rpx 0 0; background: #d9c091; }
.folder__empty { position: absolute; z-index: 0; left: 0; right: 0; bottom: 58rpx; color: #b0a795; font-size: 22rpx; text-align: center; }
</style>

<style>
.cal-scroll::-webkit-scrollbar,
.cal-scroll ::-webkit-scrollbar { display: none; width: 0; height: 0; }
</style>
