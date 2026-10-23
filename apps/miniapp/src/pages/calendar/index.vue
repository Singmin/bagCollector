<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type { CollectibleSummary } from '../../types';
import { dataService } from '../../services/data';
import { syncTabBar } from '../../services/tab-bar';
import BagTabBar from '../../components/BagTabBar.vue';

/* ── 收藏日历页（底部第三个 tab）──
   视觉对齐「方案B · 日历定稿」设计稿：暖白底 FFFEFA、贴纸风袋图（白描边 + 随机倾斜）、
   黑色今天格、黄色汇总卡（本月收集 + 连续天数 + 照片墙）、顶部「日 历」标题 + 纸袋/店铺分段。 */

const statusBarHeight = ref(20);
// #ifdef MP-WEIXIN
try {
  statusBarHeight.value = uni.getSystemInfoSync().statusBarHeight ?? 20;
} catch {
  /* 取不到就用默认值 */
}
// #endif

const WEEK_DAYS = ['日', '一', '二', '三', '四', '五', '六'];
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
/* 分段视图：纸袋（日历）/ 店铺 */
const viewMode = ref<'bags' | 'shops'>('bags');
/* 店铺视图：官方袋子 → 品牌展示图（品牌管理上传的 logo），按 sourceOfficialBagId 间接取 */
const bagBrandIds = ref<Map<string, string | undefined>>(new Map());
const brandLogos = ref<Map<string, string>>(new Map());
const officialLoading = ref(false);

async function loadOfficialImages() {
  if (officialLoading.value || bagBrandIds.value.size) return;
  officialLoading.value = true;
  try {
    const [brands, bagIds] = await Promise.all([
      dataService.officialBagBrands(),
      (async () => {
        const map = new Map<string, string | undefined>();
        let cursor: string | null = null;
        let guard = 0;
        do {
          const query = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const page = await dataService.officialBags(query);
          for (const bag of page.items) map.set(bag.id, bag.brandId);
          cursor = page.nextCursor;
          guard += 1;
        } while (cursor && guard < 50);
        return map;
      })()
    ]);
    brandLogos.value = new Map(brands.map((brand) => [brand.id, brand.displayImageUrl ?? '']));
    bagBrandIds.value = bagIds;
  } catch {
    /* 静默失败：回退到收藏自带的缩略图 */
  } finally {
    officialLoading.value = false;
  }
}

watch(viewMode, (mode) => {
  failedThumbs.value = {};
  if (mode === 'shops') void loadOfficialImages();
});

interface Cell {
  key: string;
  date: string;
  day: number;
  count: number;
  isToday: boolean;
  inMonth: boolean;
}

const isViewingToday = computed(() => viewYear.value === now.getFullYear() && viewMonth.value === now.getMonth());
const monthLabel = computed(() => `${viewYear.value}年${viewMonth.value + 1}月`);

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

/* 连续记录：截至今天（今天尚未记录则从昨天起算）连续有收藏的天数 + 历史最长连续 */
const streak = computed(() => {
  const keys = [...grouped.value.keys()].sort();
  let longest = 0;
  let run = 0;
  let prevTime: number | null = null;
  for (const k of keys) {
    const [y, m, d] = k.split('-').map(Number);
    const t = new Date(y, m - 1, d).getTime();
    if (prevTime != null && t - prevTime === 86400000) run += 1;
    else run = 1;
    if (run > longest) longest = run;
    prevTime = t;
  }
  let current = 0;
  const cursor = new Date();
  if (!grouped.value.has(keyOf(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (grouped.value.has(keyOf(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
});

/* 本月收集的袋子缩略图（照片墙素材，按时间顺序取前 4 张 + 更多计数） */
const monthThumbs = computed(() => {
  const prefix = `${viewYear.value}-${pad2(viewMonth.value + 1)}`;
  const urls: string[] = [];
  for (const [key, list] of grouped.value) {
    if (!key.startsWith(prefix)) continue;
    for (const item of list) if (item.thumbnailUrl) urls.push(item.thumbnailUrl);
  }
  return urls;
});
const wallThumbs = computed(() => monthThumbs.value.slice(0, 4));
const wallMore = computed(() => Math.max(0, monthThumbs.value.length - 4));

/* 某天的封面缩略图（当天第一件）；贴纸风优先用无白边抠图 */
function coverOf(date: string) {
  const item = grouped.value.get(date)?.[0];
  if (!item) return '';
  /* 店铺视图：认领官方袋子时改贴品牌管理的品牌展示图（logo），未配置则回退收藏自带缩略图 */
  if (viewMode.value === 'shops' && item.sourceOfficialBagId) {
    const brandId = bagBrandIds.value.get(item.sourceOfficialBagId);
    const logo = brandId ? brandLogos.value.get(brandId) : '';
    if (logo) return logo;
  }
  return item.thumbnailUrlPlain ?? item.thumbnailUrl ?? '';
}

/* 稳定伪随机倾斜角：同一天角度固定（-10° ~ +10°） */
function rotOf(date: string) {
  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) >>> 0;
  return (h % 21) - 10;
}

/* 月视图网格：周日为首日，前置空位按当月 1 号星期几计算 */
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
  /* 日历是第三个 tab：底栏高亮日历图标 */
  syncTabBar(2, false);
  void load();
});
</script>

<template>
  <view class="cal-page">
    <!-- 顶部：状态栏留白 + 「日 历」标题 + 纸袋/店铺分段 -->
    <view class="cal-head" :style="{ paddingTop: `${statusBarHeight}px` }">
      <view class="nav">
        <text class="nav__title">日 历</text>
        <view class="seg">
          <text :class="['seg__item', viewMode === 'bags' && 'on']" @tap="viewMode = 'bags'">纸袋</text>
          <text :class="['seg__item', viewMode === 'shops' && 'on']" @tap="viewMode = 'shops'">店铺</text>
        </view>
      </view>
    </view>

    <scroll-view class="cal-scroll" scroll-y enhanced :show-scrollbar="false">
      <view class="cal-body">
        <!-- 月份切换 -->
        <view class="month">
          <view class="month__m">
            <text class="arrow" @tap="prevMonth">‹</text>
            <text class="month__label">{{ monthLabel }}</text>
            <text class="arrow" @tap="nextMonth">›</text>
          </view>
          <text class="month__f">全部 ▾</text>
        </view>

        <template>
          <!-- 白色日历卡：星期头 + 日期网格 -->
          <view class="cal-card">
            <view class="dow-row">
              <text v-for="w in WEEK_DAYS" :key="w" class="dow">{{ w }}</text>
            </view>

            <view v-if="loading && !initialized" class="cal-grid">
              <view v-for="i in 35" :key="i" class="cell cell--skeleton" />
            </view>
            <view v-else class="cal-grid">
              <view
                v-for="cell in cells"
                :key="cell.key"
                class="cell"
                :class="{
                  'cell--blank': !cell.inMonth,
                  'cell--today': cell.inMonth && cell.isToday && (cell.count === 0 || !coverOf(cell.date) || failedThumbs[cell.date]),
                  'cell--has': cell.inMonth && cell.count > 0 && !!coverOf(cell.date) && !failedThumbs[cell.date]
                }"
                @tap="tapDay(cell)"
              >
                <template v-if="cell.inMonth">
                  <view
                    v-if="cell.count > 0 && coverOf(cell.date) && !failedThumbs[cell.date]"
                    class="sticker"
                    :style="{ transform: `rotate(${rotOf(cell.date)}deg)` }"
                  >
                    <image
                      class="sticker__img"
                      :src="coverOf(cell.date)"
                      mode="aspectFit"
                      @error="failedThumbs[cell.date] = true"
                    />
                  </view>
                  <text v-else class="cell__num">{{ cell.day }}</text>
                  <view v-if="cell.count > 1 && cell.inMonth" class="cnt">{{ cell.count }}</view>
                </template>
              </view>
            </view>
          </view>

          <view v-if="loadError" class="cal-error">{{ loadError }}</view>

          <!-- 黄色汇总卡：本月收集 + 连续天数 + 照片墙 -->
          <view class="hero">
            <view class="hero__stat">
              <view class="hero__num-row">
                <text class="hero__v">{{ monthStats.count }}</text>
                <text class="hero__v-unit">件</text>
              </view>
              <text class="hero__k">本月收集</text>
            </view>
            <view class="hero__divider" />
            <view class="hero__r">
              <text class="hero__line">连续记录 <text class="b">{{ streak.current }}</text> 天</text>
              <text class="hero__line">最长连续 <text class="b">{{ streak.longest }}</text> 天</text>
            </view>
            <view class="hero__stack">
              <view v-for="(url, i) in wallThumbs" :key="i" class="cellp">
                <image class="cellp__img" :src="url" mode="aspectFill" />
              </view>
              <view v-if="wallMore > 0" class="cellp cellp--more">
                <image v-if="monthThumbs[4]" class="cellp__img" :src="monthThumbs[4]" mode="aspectFill" />
                <text class="cellp__em">+{{ wallMore }}</text>
              </view>
            </view>
          </view>
        </template>
      </view>
    </scroll-view>

    <!-- 自定义底栏：传入页面同色背景，避免与暖白底出现色差断层 -->
    <BagTabBar bg="#FFFEFA" />
  </view>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   收藏日历 —— 方案B 定稿：暖白底 FFFEFA + 贴纸风袋图 + 黑色今天格 + 黄色汇总卡。 */
.cal-page { position: relative; height: 100vh; display: flex; flex-direction: column; overflow: hidden; background-color: #FFFEFA; }
.cal-scroll { flex: 1 1 auto; min-height: 0; }
.cal-body { padding: 8rpx 32rpx 176rpx; }

/* ── 顶部导航 ── */
.cal-head { flex: 0 0 auto; padding: 0 30rpx 6rpx; }
.nav { position: relative; display: flex; align-items: center; height: 96rpx; }
.nav__title { font-size: 40rpx; font-weight: 700; color: #111113; letter-spacing: 3rpx; line-height: 1; }

/* 纸袋 / 店铺 分段控件：整行居中，避开右上角系统胶囊 */
.seg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; gap: 4rpx; padding: 4rpx; background: #f4f4f6; border-radius: 999rpx; }
.seg__item { height: 48rpx; padding: 0 22rpx; border-radius: 999rpx; display: flex; align-items: center; justify-content: center; font-size: 23rpx; font-weight: 500; color: #8a8a90; letter-spacing: .4rpx; }
.seg__item.on { background: #ffffff; color: #111113; font-weight: 600; box-shadow: 0 2rpx 6rpx rgba(0,0,0,.08); }

/* ── 月份条 ── */
.month { display: flex; align-items: center; justify-content: space-between; padding: 6rpx 6rpx 18rpx; }
.month__m { display: flex; align-items: center; gap: 22rpx; }
.month__label { font-size: 30rpx; font-weight: 600; color: #111113; letter-spacing: .5rpx; }
.arrow { color: #c2c2c8; font-size: 30rpx; font-weight: 400; padding: 0 4rpx; }
.month__f { font-size: 23rpx; color: #8a8a90; }

/* ── 白色日历卡 ── */
.cal-card { margin: 0 2rpx; padding: 30rpx 26rpx 34rpx; border-radius: 43rpx; background: #ffffff; box-shadow: 0 0 0 1rpx rgba(0,0,0,.045); }
.dow-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10rpx; padding: 0 8rpx 14rpx; }
.dow { text-align: center; font-size: 20rpx; color: #c2c2c8; font-weight: 600; letter-spacing: .4rpx; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10rpx; }

/* 日期格：透明底，数字居中；今天黑色实心 */
.cell { position: relative; height: 108rpx; display: flex; align-items: center; justify-content: center; }
.cell--blank { background: transparent; }
.cell__num { font-size: 28rpx; color: #111113; font-weight: 600; line-height: 1; }
.cell--today { background: #1a1a1c; border-radius: 17rpx; }
.cell--today .cell__num { color: #ffffff; }

/* 贴纸风袋图：白底圆角小卡 + 白描边 + 阴影 + 随机倾斜，完整展示 */
.sticker { position: relative; width: 78%; height: 82%; background: #ffffff; border-radius: 22rpx; overflow: hidden; box-shadow: 0 4rpx 16rpx rgba(0,0,0,.14), 0 0 0 1.5rpx rgba(0,0,0,.04); }
.sticker__img { width: 100%; height: 100%; }

/* 多图计数角标：白色玻璃，右上角 */
.cnt { position: absolute; z-index: 6; right: -2rpx; top: -2rpx; min-width: 24rpx; height: 24rpx; padding: 0 6rpx; border-radius: 999rpx; background: rgba(255,255,255,.78); color: #3a3a40; font-size: 16rpx; font-weight: 700; line-height: 24rpx; text-align: center; border: 1.6rpx solid rgba(255,255,255,.95); box-shadow: 0 2rpx 5rpx rgba(20,22,30,.14); }

.cell--skeleton { background: #f4f4f6; border-radius: 17rpx; }

.cal-error { margin: 28rpx 8rpx; padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: 24rpx; text-align: center; }

/* ── 黄色汇总卡 ── */
.hero { display: flex; align-items: center; gap: 18rpx; margin: 20rpx 2rpx 0; padding: 26rpx; border-radius: 30rpx; background: #FDE895; }
.hero__stat { display: flex; flex-direction: column; flex: none; }
.hero__num-row { display: flex; align-items: baseline; }
.hero__v { font-size: 47rpx; font-weight: 700; color: #C50405; letter-spacing: -1rpx; line-height: 1.1; }
.hero__v-unit { font-size: 20rpx; font-weight: 500; color: #a8924f; margin-left: 3rpx; }
.hero__k { margin-top: 6rpx; font-size: 20rpx; color: #a8924f; letter-spacing: .6rpx; }
.hero__divider { flex: none; width: 2rpx; height: 64rpx; background: linear-gradient(180deg, rgba(90,70,10,0), rgba(90,70,10,.14), rgba(90,70,10,0)); }
.hero__r { display: flex; flex-direction: column; flex: none; font-size: 20rpx; color: #8c7a42; line-height: 1.9; }
.hero__r .b { font-size: 28rpx; color: #2A4EA4; font-weight: 700; }

/* 右侧照片墙：胶片横排，裁掉上方提手留白 */
.hero__stack { flex: 1 1 auto; min-width: 0; height: 144rpx; display: flex; gap: 7rpx; background: rgba(255,255,255,.62); border-radius: 24rpx; padding: 8rpx; border: 1.6rpx solid rgba(255,255,255,.8); box-sizing: border-box; }
.cellp { position: relative; flex: 1 1 0; min-width: 0; height: 100%; border-radius: 14rpx; overflow: hidden; background: #ffffff; box-shadow: 0 0 0 1rpx rgba(0,0,0,.05); }
.cellp__img { position: absolute; left: 0; top: -29%; width: 100%; height: 132%; }
.cellp--more::after { content: ""; position: absolute; inset: 0; background: rgba(17,17,19,.42); }
.cellp__em { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; font-style: normal; font-size: 22rpx; font-weight: 700; color: #ffffff; }
</style>

<style>
.cal-scroll::-webkit-scrollbar,
.cal-scroll ::-webkit-scrollbar { display: none; width: 0; height: 0; }
</style>
