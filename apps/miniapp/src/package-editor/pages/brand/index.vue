<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { Brand } from '../../../types';
import { dataService } from '../../../services/data';

/* 品牌库：品牌宫格（热门 + 拼音首字母分组）+ 搜索 + 字母索引。
   选择模式（?pick=1）由编辑页进入：点品牌 / 自定义即回传品牌名并返回上一页；
   浏览模式（无参数）仅查看。品牌数据复用官方图鉴的 GET /official-bags/brands。 */
const pickMode = ref(false);
const loading = ref(true);
const loadError = ref('');
const brands = ref<Brand[]>([]);
const keyword = ref('');
const jumpTo = ref('');

onLoad((query) => {
  pickMode.value = query?.pick === '1';
  void load();
});

async function load() {
  loading.value = true;
  try {
    brands.value = await dataService.officialBagBrands();
    loadError.value = '';
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '品牌加载失败';
  } finally { loading.value = false; }
}

/* ── 中文按拼音首字母分桶 ──
   无拼音依赖：探测 Intl.Collator('zh') 是否按拼音排序，可用则用 GB2312 区位边界字
   （阿八擦搭…）划出 A~Z 桶；不可用（部分安卓 WebGL 环境）中文统一落「其他」。 */
let zhCollator: Intl.Collator | null = null;
try {
  const candidate = new Intl.Collator('zh-Hans-CN');
  if (candidate.compare('阿', '八') < 0 && candidate.compare('八', '擦') < 0) zhCollator = candidate;
} catch { zhCollator = null; }
/* 边界字 → 首字母对照（GB2312 一级字库拼音序，无 I/U/V） */
const PINYIN_BOUNDS: Array<[string, string]> = [
  ['阿', 'A'], ['八', 'B'], ['擦', 'C'], ['搭', 'D'], ['蛾', 'E'], ['发', 'F'], ['噶', 'G'],
  ['哈', 'H'], ['击', 'J'], ['喀', 'K'], ['垃', 'L'], ['妈', 'M'], ['拿', 'N'], ['哦', 'O'],
  ['啪', 'P'], ['期', 'Q'], ['然', 'R'], ['撒', 'S'], ['塌', 'T'], ['挖', 'W'], ['昔', 'X'],
  ['压', 'Y'], ['匝', 'Z']
];
function firstLetter(name: string): string {
  const ch = name.trim().charAt(0);
  if (!ch) return '#';
  if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
  if (/[\u4e00-\u9fff]/.test(ch) && zhCollator) {
    for (const [bound, letter] of PINYIN_BOUNDS) {
      if (zhCollator.compare(ch, bound) < 0) return letter;
    }
    return 'Z';
  }
  return '#';
}

const searching = computed(() => keyword.value.trim().length > 0);
const filtered = computed(() => {
  const lower = keyword.value.trim().toLowerCase();
  if (!lower) return brands.value;
  return brands.value.filter((brand) => brand.name.toLowerCase().includes(lower));
});

interface BrandGroup { key: string; label: string; anchor: string; brands: Brand[] }

/* 分组结果：浏览态 = 热（按件数取前 8，可与下方字母组重复）+ A~Z + 其他；搜索态 = 纯字母组 */
const groups = computed<BrandGroup[]>(() => {
  const list = [...filtered.value].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const buckets = new Map<string, Brand[]>();
  for (const brand of list) {
    const key = firstLetter(brand.name);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(brand); else buckets.set(key, [brand]);
  }
  const result: BrandGroup[] = [];
  if (!searching.value) {
    const hot = list.filter((brand) => brand.bagCount > 0).sort((a, b) => b.bagCount - a.bagCount).slice(0, 8);
    if (hot.length) result.push({ key: 'HOT', label: '热', anchor: 'sec-HOT', brands: hot });
  }
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const bucket = buckets.get(letter);
    if (bucket?.length) result.push({ key: letter, label: letter, anchor: `sec-${letter}`, brands: bucket });
  }
  const other = buckets.get('#');
  if (other?.length) result.push({ key: '#', label: '其他', anchor: 'sec-O', brands: other });
  return result;
});

/* 右侧索引条：仅展示实际存在的分组（含「热」） */
const indexItems = computed(() => groups.value.map((group) => ({ label: group.key === '#' ? '#' : group.label, anchor: group.anchor })));

function jump(anchor: string) {
  jumpTo.value = anchor === jumpTo.value ? `${anchor}~` : anchor;
}
function firstChar(name: string) {
  return name.trim().charAt(0).toUpperCase();
}

/* 选择模式回传：品牌名经全局事件交回编辑页（元数据页 onLoad 注册 / onUnload 注销） */
function choose(brand: Brand) {
  if (!pickMode.value) return;
  uni.$emit('brand-picked', brand.name);
  uni.navigateBack({ delta: 1 });
}
function customBrand() {
  if (!pickMode.value) return;
  uni.showModal({
    title: '自定义品牌',
    editable: true,
    placeholderText: '输入品牌 / 店铺名称',
    success: (result) => {
      const name = result.content?.trim().slice(0, 30);
      if (result.confirm && name) {
        uni.$emit('brand-picked', name);
        uni.navigateBack({ delta: 1 });
      }
    }
  });
}
function onSearchInput(event: Event) {
  keyword.value = (event as unknown as { detail?: { value?: string } }).detail?.value ?? '';
}
</script>

<template>
  <view class="brand-page">
    <nav-bar title="品牌库" back />
    <!-- 搜索 + 自定义 -->
    <view class="brand-toolbar">
      <view class="brand-search">
        <image class="brand-search__icon" src="/static/figma/search.svg" mode="aspectFit" />
        <input
          class="brand-search__input"
          :value="keyword"
          type="text"
          confirm-type="search"
          placeholder="搜索品牌"
          placeholder-class="brand-search__placeholder"
          @input="onSearchInput"
        />
        <text v-if="keyword" class="brand-search__clear" @tap="keyword = ''">×</text>
      </view>
      <view v-if="pickMode" class="brand-custom" hover-class="is-pressed" :hover-stay-time="80" @tap="customBrand">＋ 自定义</view>
    </view>

    <view v-if="loadError" class="brand-state">{{ loadError }}</view>
    <view v-else-if="loading && !brands.length" class="brand-state">加载中…</view>
    <view v-else-if="!groups.length" class="brand-state">
      <text class="brand-state__mark">没有找到</text>
      <text class="brand-state__sub">换个关键词试试</text>
    </view>

    <!-- 品牌宫格：分组滚动区 + 右侧字母索引 -->
    <scroll-view v-else class="brand-scroll" scroll-y enhanced :show-scrollbar="false" :scroll-into-view="jumpTo" scroll-with-animation>
      <view class="brand-body">
        <view v-for="group in groups" :key="group.key" class="brand-group">
          <view :id="group.anchor" class="brand-group__title">{{ group.label }}</view>
          <view class="brand-grid">
            <view
              v-for="brand in group.brands"
              :key="`${group.key}-${brand.id}`"
              class="brand-card"
              hover-class="is-pressed"
              :hover-stay-time="80"
              @tap="choose(brand)"
            >
              <image v-if="brand.displayImageUrl" class="brand-card__logo" :src="brand.displayImageUrl" mode="aspectFit" />
              <view v-else class="brand-card__logo brand-card__logo--fallback">
                <text>{{ firstChar(brand.name) }}</text>
              </view>
              <text class="brand-card__name">{{ brand.name }}</text>
              <text class="brand-card__count">{{ brand.bagCount }} 件</text>
            </view>
          </view>
        </view>
        <view class="brand-body__tail" />
      </view>
    </scroll-view>

    <!-- 字母索引条：轻点跳组（搜索时隐藏） -->
    <view v-if="groups.length && !searching" class="brand-index">
      <view v-for="item in indexItems" :key="item.anchor" class="brand-index__item" @tap="jump(item.anchor)">{{ item.label }}</view>
    </view>
  </view>
</template>

<style scoped>
/* 页面固定视口纵向布局：导航 + 工具条固定，分组滚动区吃剩余高度 */
.brand-page { height: 100vh; display: flex; flex-direction: column; background: #f2f3f7; }
.brand-toolbar { display: flex; align-items: center; gap: 16rpx; margin: 16rpx 30rpx 20rpx; }
/* 搜索框：白底胶囊（与官方图鉴搜索同语汇） */
.brand-search { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 14rpx; height: 80rpx; padding: 0 28rpx; border-radius: 40rpx; background: #ffffff; }
.brand-search__icon { flex: 0 0 auto; width: 30rpx; height: 30rpx; opacity: .55; }
.brand-search__input { flex: 1 1 auto; min-width: 0; height: 80rpx; color: #141414; font-size: var(--wc-font-description); }
.brand-search__clear { flex: 0 0 auto; width: 36rpx; height: 36rpx; border-radius: 50%; background: rgba(20, 20, 20, .08); color: #77736d; font-size: 24rpx; line-height: 36rpx; text-align: center; }
/* 自定义按钮：白底描边胶囊 + 品牌红字（仅选择模式展示） */
.brand-custom { flex: 0 0 auto; padding: 0 28rpx; height: 80rpx; display: flex; align-items: center; border: 2rpx solid rgba(20, 20, 20, .14); border-radius: 40rpx; background: #ffffff; color: #C50405; font-size: var(--wc-font-footnote); font-weight: 700; white-space: nowrap; }
.brand-custom.is-pressed { background: rgba(197, 4, 5, .06); }
/* 分组滚动区：右侧让出索引条宽度 */
.brand-scroll { flex: 1 1 auto; min-height: 0; }
.brand-body { padding: 0 90rpx 0 30rpx; }
.brand-group__title { margin: 26rpx 0 16rpx; color: #77736d; font-size: var(--wc-font-footnote); font-weight: 700; letter-spacing: .8rpx; }
/* 三列宫格：白卡 + 圆角，logo 圆形居中 */
.brand-grid { display: flex; flex-wrap: wrap; gap: 16rpx; }
.brand-card { box-sizing: border-box; width: calc((100% - 32rpx) / 3); padding: 26rpx 12rpx 22rpx; display: flex; flex-direction: column; align-items: center; border-radius: 22rpx; background: #ffffff; }
.brand-card.is-pressed { background: rgba(20, 20, 20, .05); }
.brand-card__logo { width: 96rpx; height: 96rpx; border-radius: 50%; background: #f2f3f7; }
.brand-card__logo--fallback { display: flex; align-items: center; justify-content: center; color: #b3afa8; font-size: 40rpx; font-weight: 700; }
.brand-card__name { max-width: 100%; margin-top: 14rpx; color: #141414; font-size: var(--wc-font-footnote); font-weight: 600; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brand-card__count { margin-top: 6rpx; color: #b3afa8; font-size: 20rpx; line-height: 1.2; }
.brand-body__tail { height: calc(env(safe-area-inset-bottom) + 40rpx); }
/* 索引条：吸右垂直居中，仅列实际存在的分组 */
.brand-index { position: fixed; z-index: 10; right: 8rpx; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; align-items: center; }
.brand-index__item { padding: 5rpx 12rpx; color: #77736d; font-size: 21rpx; font-weight: 700; line-height: 1.2; }
.brand-index__item:active { color: #C50405; }
/* 状态占位（加载 / 出错 / 无结果） */
.brand-state { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12rpx; padding: 0 30rpx; color: #77736d; font-size: var(--wc-font-footnote); }
.brand-state__mark { color: #141414; font-size: var(--wc-font-description); font-weight: 700; }
.brand-state__sub { color: #b3afa8; }
</style>

<style>
/* placeholder-class 命中原生控件内部节点，不带 data-v，必须全局 */
.brand-search__placeholder { color: #b3afa8; }
</style>
