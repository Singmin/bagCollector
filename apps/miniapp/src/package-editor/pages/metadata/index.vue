<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { Collectible, Shelf } from '../../../types';
import { daysAgoText } from '../../../services/format';
import { dataService } from '../../../services/data';

const id = ref(''); const item = ref<Collectible | null>(null);
const name = ref(''); const notes = ref(''); const saving = ref(false); const loadError = ref('');
/* 三联条：编号自动生成（自有收藏总数，只读）；收藏日期默认入库当天，点按弹日期选择可改 */
const collectNo = ref('—');
const collectDateIso = ref('');
const dateValue = computed(() => (collectDateIso.value ? collectDateIso.value.slice(0, 10) : ''));
const todayStr = computed(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
const entryDuration = computed(() => (collectDateIso.value ? daysAgoText(collectDateIso.value) : '—'));
async function onDateChange(event: Event) {
  const value = (event as unknown as { detail?: { value?: string } }).detail?.value;
  if (!value) return;
  const iso = new Date(`${value}T12:00:00`).toISOString();
  try {
    await dataService.updateCollectible(id.value, { addedAt: iso });
    collectDateIso.value = iso;
    if (item.value) item.value.addedAt = iso;
    uni.showToast({ title: '收藏日期已更新', icon: 'none' });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '修改失败', icon: 'none' });
  }
}
/* 标签 chip 编辑（与编辑半窗同款）：列表 + 草稿输入，回车/失焦/保存时收词 */
const tagList = ref<string[]>([]); const tagDraft = ref('');
function onTagInput(event: Event) {
  tagDraft.value = (event as unknown as { detail?: { value?: string } }).detail?.value ?? '';
}
function commitTags() {
  const parts = tagDraft.value.split(/[\s,，、;；]+/)
    .map((tag) => tag.trim().slice(0, 12))
    .filter(Boolean);
  if (parts.length) {
    const next = [...tagList.value];
    for (const tag of parts) if (!next.includes(tag)) next.push(tag);
    tagList.value = next.slice(0, 30);
  }
  tagDraft.value = '';
}
function removeTag(tag: string) {
  tagList.value = tagList.value.filter((current) => current !== tag);
}
/* 聚焦字段：小程序 input/textarea 的 :focus 伪类不可靠，靠 focus/blur 切 is-focus 类 */
const focusField = ref('');
/* 品牌 / 店铺：填写式输入；保存时按名称找同名展架，没有就自动创建（数据模型仍落到 shelfId） */
const shelves = ref<Shelf[]>([]);
const brand = ref('');
/* 手动抠图（2026-09-29 抠图改用户可选）：提交全幅裁剪触发后端抠图任务，
   跳到处理页等待，完成后自动重定向回本页（此时 processingStatus 已 READY，按钮随之隐藏） */
const matting = ref(false);
async function startMatting() {
  if (matting.value) return; matting.value = true;
  try {
    await dataService.crop(id.value, { x: 0, y: 0, width: 1, height: 1, rotation: 0 });
    uni.redirectTo({ url: `/package-editor/pages/processing/index?id=${id.value}&stage=matting` });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '抠图启动失败', icon: 'none' });
    matting.value = false;
  }
}
async function load() {
  try {
    const [nextItem, nextShelves, page] = await Promise.all([
      dataService.collectible(id.value),
      dataService.shelves(),
      dataService.collectibles('limit=1')
    ]);
    if (!nextItem.displayImageUrl) throw new Error('收藏缺少展示图');
    item.value = nextItem; shelves.value = nextShelves; name.value = nextItem.name === '未命名纸袋' ? '' : nextItem.name;
    /* 编号 = 自有收藏总数（含本条，列表按 addedAt desc，本条最新即最大号） */
    collectNo.value = `NO.${String(Math.max(1, page.totalCount)).padStart(3, '0')}`;
    collectDateIso.value = nextItem.addedAt;
    notes.value = nextItem.notes; tagList.value = nextItem.tags.slice(0, 30); tagDraft.value = '';
    brand.value = nextItem.shelfName ?? '';
  } catch (error) { loadError.value = error instanceof Error ? error.message : '收藏信息加载失败'; }
}
async function save() {
  /* 不用 disabled 属性控制按钮（微信内置 wx-button[disabled] 样式会盖掉黑底），
     改为点击时校验并提示；saving 期间直接忽略重复点击 */
  if (saving.value || !item.value) return;
  const normalizedName = name.value.trim(); const normalizedBrand = brand.value.trim();
  if (!normalizedName) return void uni.showToast({ title: '请填写纸袋名称', icon: 'none' });
  if (!normalizedBrand) return void uni.showToast({ title: '请填写品牌 / 店铺', icon: 'none' });
  if (saving.value) return; saving.value = true;
  try {
    /* 没敲回车的半截词一并收走（与编辑半窗同口径） */
    commitTags();
    /* 品牌 / 店铺 → 展架：有同名展架直接用，没有就自动创建（数据模型仍落到 shelfId） */
    let shelf = shelves.value.find((current) => current.name.toLowerCase() === normalizedBrand.toLowerCase());
    if (!shelf) shelf = await dataService.createShelf({ name: normalizedBrand, theme: 'SAGE' });
    if (!shelves.value.some((current) => current.id === shelf!.id)) shelves.value = [...shelves.value, shelf];
    await dataService.updateCollectible(id.value, { name: normalizedName, shelfId: shelf.id, notes: notes.value.trim(), tags: [...tagList.value] });
    uni.showToast({ title: '已加入陈列柜', icon: 'success' }); setTimeout(() => uni.switchTab({ url: '/pages/showcase/index' }), 700);
  } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' }); saving.value = false; }
}
onLoad((query) => {
  if (typeof query?.id !== 'string') return void (loadError.value = '收藏页面参数无效');
  id.value = query.id;
  void load();
});
/* 取消 = 放弃填写返回上一页（不保存任何信息） */
function goBack() { uni.navigateBack({ delta: 1 }); }
</script>

<template>
  <view class="page metadata-page"><nav-bar title="完善信息" back />
    <view v-if="loadError" class="error">{{ loadError }}</view>
    <view v-else-if="item" class="preview"><image :src="item.displayImageUrl" mode="aspectFit" /></view>
    <!-- 抠图按钮（方案 C）：图区与表单之间的整行描边胶囊，未抠图（AWAITING_CROP）时展示，抠过隐藏 -->
    <button v-if="!loadError && item && item.processingStatus === 'AWAITING_CROP'" class="matting-button" :disabled="matting" @tap="startMatting">
      <image class="matting-button__icon" src="/static/figma/cutout-black.svg" mode="aspectFit" />
      <text>{{ matting ? '提交中…' : '自动抠图' }}</text>
    </button>
    <!-- 表单结构与样式复用编辑半窗的「下划线·纸感」版式（styles/edit-form.css） -->
    <view v-if="!loadError && item" class="form-card">
      <!-- 编号/入库时长只读条：编号自动生成不可改；收藏日期单独占一行可点修改 -->
      <view class="ef-readout">
        <view class="ef-readout__cell ef-readout__cell--no"><text class="ef-readout__v">{{ collectNo }}</text><text class="ef-readout__k">编号</text></view>
        <view class="ef-readout__cell ef-readout__cell--last"><text class="ef-readout__v">{{ entryDuration }}</text><text class="ef-readout__k">入库时长</text></view>
      </view>
      <view class="ef-row">
        <text class="ef-key">收藏日期</text>
        <picker class="ef-val" mode="date" :value="dateValue" :end="todayStr" @change="onDateChange">
          <view class="ef-input ef-date-row">{{ dateValue }}<text class="ef-date-hint">点按修改</text></view>
        </picker>
      </view>
      <view class="ef-row">
        <text class="ef-key">名称</text>
        <view class="ef-val"><input class="ef-input" :class="{ 'is-focus': focusField === 'name' }" v-model="name" placeholder="给它起个名字" maxlength="24" placeholder-class="ef-placeholder" @focus="focusField = 'name'" @blur="focusField = ''" /></view>
      </view>
      <view class="ef-row">
        <text class="ef-key">品牌 / 店铺</text>
        <view class="ef-val"><input class="ef-input" :class="{ 'is-focus': focusField === 'brand' }" v-model="brand" placeholder="例如：霸王茶姬 / Peet's Coffee" maxlength="30" placeholder-class="ef-placeholder" @focus="focusField = 'brand'" @blur="focusField = ''" /></view>
      </view>
      <view class="ef-row ef-row--tags">
        <text class="ef-key">标签</text>
        <view class="ef-val">
          <!-- 标签 chip 盒：与编辑半窗 / 标记半窗同款（ef-tagbox/ef-chip 来自 edit-form.css） -->
          <view class="ef-tagbox" :class="{ 'is-focus': focusField === 'tags' }">
            <view v-for="tag in tagList" :key="tag" class="ef-chip">
              <text class="ef-chip__name"># {{ tag }}</text>
              <text class="ef-chip__x" @tap.stop="removeTag(tag)">×</text>
            </view>
            <input
              class="ef-tagbox__input"
              :class="{ 'is-focus': focusField === 'tags' }"
              :value="tagDraft"
              placeholder="添加标签"
              placeholder-class="ef-placeholder"
              @input="onTagInput"
              @confirm="commitTags"
              @focus="focusField = 'tags'"
              @blur="focusField = ''; commitTags()"
            />
          </view>
        </view>
      </view>
      <view class="ef-row ef-row--note">
        <text class="ef-key">备注</text>
        <view class="ef-val"><textarea class="ef-area" :class="{ 'is-focus': focusField === 'notes' }" v-model="notes" placeholder="这件收藏来自哪里？" maxlength="2000" placeholder-class="ef-placeholder" @focus="focusField = 'notes'" @blur="focusField = ''" /></view>
      </view>
    </view>
    <!-- 底部常驻按钮条：复用编辑半窗的 detail-actions（取消描边钮 + 黑胶囊），固定在视口底部 -->
    <view class="bottom-bar">
      <view class="detail-actions">
        <button class="detail-edit" @tap="goBack">取消</button>
        <button class="detail-save" :class="{ 'is-busy': saving }" @tap="save">{{ saving ? '保存中…' : '确定添加' }}</button>
      </view>
    </view>
  </view>
</template>

<style scoped>
/* 页面接 nav-bar 组件：导航栏必须全宽顶到屏幕最上沿（含状态栏区），
   因此清零 .page 的四周内边距，改由各内容块自带边距（预埋 200rpx 底部避让按钮条） */
.metadata-page { padding: 0 0 200rpx; background: #f2f3f7; }
/* 三联条：与编辑半窗 .ef-readout 同值（该类在 library scoped 样式里，本页同值重定义）；
   收藏日期格整格可点（picker），加浅红提示「点按修改」 */
.ef-readout { display: flex; align-items: flex-start; margin: 0 0 25rpx; padding: 4rpx 0 0; }
.ef-readout__cell { flex: 1 1 0; min-width: 0; text-align: center; border-left: 2rpx solid rgba(20,20,20,.085); }
.ef-readout__cell--no { border-left: 0; }
.ef-readout__cell--date { text-decoration: underline dotted rgba(197,4,5,.55); text-underline-offset: 6rpx; }
.ef-readout__v { display: block; margin: 0 0 9rpx; color: #3a3630; font-size: var(--wc-font-description); font-weight: 600; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ef-readout__k { display: block; color: #a8a49d; font-size: var(--wc-font-footnote); font-weight: 700; line-height: 1.2; letter-spacing: .8rpx; white-space: nowrap; }/* 图区：与编辑半窗 .detail-artwork 同款 —— 无底色、透明居中 aspectFit + 柔影（2026-09-29 去棕底/虚线框）；
   .page 内边距已清零，这里自带 30rpx 左右边距 */
.preview { position: relative; margin: 0 30rpx; height: 306rpx; display: flex; align-items: center; justify-content: center; }.preview image { width: 100%; height: 269rpx; filter: drop-shadow(0 7rpx 18rpx rgba(0, 0, 0, .18)); }
/* 抠图按钮（方案 C）：图区与表单之间的整行描边胶囊，黑图标 + 黑字 */
.matting-button { width: calc(100% - 60rpx); margin: 26rpx 30rpx 6rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; gap: 12rpx; border: 2rpx solid rgba(20, 20, 20, .16); border-radius: 44rpx; background: transparent; color: #141414; font-size: var(--wc-font-description); font-weight: 650; }
.matting-button__icon { width: 34rpx; height: 34rpx; }
.matting-button[disabled] { opacity: .5; }
/* 表单区：复用编辑半窗版式 —— 字段直接坐在页面底色上（无白卡包裹），
   行结构/下划线/chip 全部来自 styles/edit-form.css，与半窗逐像素同款 */
.form-card { margin: 0 40rpx; padding: 6rpx 10rpx 30rpx; }
/* 收藏日期行：下划线样式与 ef-input 一致，右侧浅色「点按修改」提示 */
.ef-date-row { display: flex; align-items: center; justify-content: space-between; }
.ef-date-hint { flex: 0 0 auto; color: #b3afa8; font-size: var(--wc-font-footnote); }
.error { padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: var(--wc-font-footnote); }
/* 底部按钮条：无背景（透明坐在页面底色上），固定视口底部（含安全区留白）；
   按钮组复用 edit-form.css 的 detail-actions（半窗场景 margin 此处清零） */
.bottom-bar { position: fixed; z-index: 20; left: 0; right: 0; bottom: 0; padding: 16rpx 30rpx calc(env(safe-area-inset-bottom) + 16rpx); }
.bottom-bar .detail-actions { margin: 0; }
/* 主按钮恒定黑底白字：微信内置 wx-button[disabled] 样式权重高于单 class，
   会把它刷成白色 —— 这里用「类名表达忙态」而非 disabled，并补一条高权重兜底规则 */
.bottom-bar .detail-save, .bottom-bar .detail-save[disabled], .bottom-bar .detail-save[disabled]:not([type]) { background: #141414; color: #ffffff; }
.bottom-bar .detail-save.is-busy { opacity: .6; }
.metadata-page { padding-bottom: 200rpx; }
</style>

<style>
@import '../../../styles/edit-form.css';
</style>
