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
/* 抠图按钮（自动抠图）显隐判据是「有没有抠图结果（cutoutImageUrl）」而不是 processingStatus ——
   裁剪（/crop，只裁剪）之后状态也是 READY，若按状态判断按钮会永久消失（Bug）。
   裁剪按钮始终在「空闲态」展示：包括已抠图之后也能再裁（/crop 会顺带重新抠图，保持透明图与展示图对齐）。 */
const matted = computed(() => !!item.value?.cutoutImageUrl);
const idle = (status: string | undefined) =>
  status === 'AWAITING_CROP' || status === 'READY' || status === 'FAILED';
const canMatte = computed(() => !!item.value && !matted.value && idle(item.value?.processingStatus));
const canCrop = computed(() => !!item.value && idle(item.value?.processingStatus));
const matting = ref(false);
/* 抠图要花钱，先让用户确认一次（避免误触 / 试玩）。抠过也能再裁，所以文案不再说「不能再裁剪」 */
const MATTING_CONFIRM = '每张图片仅自动抠图一次（按次计费）。确认现在抠图？之后仍可在「裁剪旋转」里按新构图重新抠图。';
/* 抠图要花钱，先让用户确认一次（避免误触 / 试玩） */
function startMatting() {
  if (matting.value || !canMatte.value) return;
  uni.showModal({
    title: '自动抠图（仅一次）',
    content: MATTING_CONFIRM,
    confirmText: '开始抠图',
    cancelText: '再想想',
    success: (result) => { if (result.confirm) void submitMatting(); }
  });
}
async function submitMatting() {
  matting.value = true;
  try {
    /* 抠图走独立端点：参数全省，后端沿用已保存的裁剪参数（没裁过则全幅），画面不会被重置 */
    await dataService.matte(id.value);
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
    /* 首次完善信息发生在首次裁剪之前（AWAITING_CROP）：流水线此时只产出标准图，
       展示图要等裁剪提交后才生成 —— 回退用标准图占位，不再直接报错把页面挡死。
       只有连标准图都没有（如资产丢失）才算异常。 */
    if (!nextItem.displayImageUrl && !nextItem.standardImageUrl) throw new Error('收藏缺少展示图');
    if (!nextItem.displayImageUrl) nextItem.displayImageUrl = nextItem.standardImageUrl;
    item.value = nextItem; shelves.value = nextShelves; name.value = nextItem.name === '未命名纸袋' ? '' : nextItem.name;
    /* 编号 = 自有收藏总数（含本条，列表按 addedAt desc，本条最新即最大号） */
    collectNo.value = `NO.${String(Math.max(1, page.totalCount)).padStart(3, '0')}`;
    collectDateIso.value = nextItem.addedAt;
    notes.value = nextItem.notes; tagList.value = nextItem.tags.slice(0, 30); tagDraft.value = '';
    brand.value = nextItem.shelfName ?? '';
  } catch (error) { loadError.value = error instanceof Error ? error.message : '收藏信息加载失败'; }
}
/* 裁剪旋转：跳转裁剪页（提交后由后端 sharp 重新出图，回本页刷新） */
function openCrop() {
  uni.navigateTo({ url: `/package-editor/pages/crop/index?id=${id.value}` });
}
/* 高级调色：与「裁剪旋转」完全复用同一页面（不再有单独的「仅调色」模式）——
   裁剪页已常驻调色滑杆，单独模式只会让两个入口长得像两个页面，且少掉比例/旋转能力 */
function openColor() {
  uni.navigateTo({ url: `/package-editor/pages/crop/index?id=${id.value}` });
}
/* 首次上传完成后状态停在 AWAITING_CROP（等用户裁剪）：此时只有标准图，没有展示图/缩略图，
   而收藏架列表只返回 READY —— 用户不点「裁剪旋转/自动抠图」直接「确定添加」的话，这条收藏会永远看不到。
   这里自动做一次全幅裁剪（x/y/w/h/rotation 全默认，画面不变，免费不占抠图配额），
   产出展示图/缩略图并把状态推进到 READY；轮询等待就绪后再跳收藏架。 */
const CROP_WAIT_TIMEOUT_MS = 30_000;
const CROP_WAIT_POLL_MS = 1_000;
async function waitForCropReady(id: string) {
  const deadline = Date.now() + CROP_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await dataService.collectible(id);
    if (current.processingStatus === 'READY') return;
    if (current.processingStatus === 'FAILED') throw new Error(current.processingError || '图片处理失败');
    await new Promise((resolve) => setTimeout(resolve, CROP_WAIT_POLL_MS));
  }
  throw new Error('图片处理超时，请稍后在收藏架下拉刷新');
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
    if (item.value.processingStatus === 'AWAITING_CROP') {
      await dataService.crop(id.value, { x: 0, y: 0, width: 1, height: 1, rotation: 0 });
      await waitForCropReady(id.value);
    }
    uni.showToast({ title: '已加入陈列柜', icon: 'success' }); setTimeout(() => uni.switchTab({ url: '/pages/library/index' }), 700);
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
    <!-- 三个独立入口（不再混在一起）：裁剪旋转 / 高级调色 / 自动抠图 —— 文案统一四字，等宽一行更齐。
         前两者始终展示（含已抠图之后，已抠图再裁/调色会按当前构图重新生成抠图）；
         自动抠图常驻展示：已抠过时置为「已抠图」完成态并禁用（不再隐藏，避免三按钮宽度跳动） -->
    <view v-if="!loadError" class="entry-row">
      <button v-if="canCrop" class="entry-button" @tap="openCrop">
        <image class="entry-button__icon" src="/static/figma/crop-black.svg" mode="aspectFit" />
        <text class="entry-button__label">裁剪旋转</text>
      </button>
      <button v-if="canCrop" class="entry-button" @tap="openColor">
        <image class="entry-button__icon" src="/static/figma/color-black.svg" mode="aspectFit" />
        <text class="entry-button__label">高级调色</text>
      </button>
      <button v-if="canCrop" class="entry-button" :class="{ 'is-done': matted }" :disabled="matted || matting" @tap="startMatting">
        <image class="entry-button__icon" src="/static/figma/cutout-black.svg" mode="aspectFit" />
        <text class="entry-button__label">{{ matted ? '已抠图' : matting ? '提交中…' : '自动抠图' }}</text>
      </button>
    </view>
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
.preview { position: relative; margin: 0 30rpx; height: 480rpx; display: flex; align-items: center; justify-content: center; }.preview image { width: 100%; height: 440rpx; filter: drop-shadow(0 7rpx 18rpx rgba(0, 0, 0, .18)); }
/* 三个入口并排一行：等宽描边胶囊（原整行纵向堆叠 → 一行三等分，每个约 220rpx），图标 + 文字横排居中。
   底部 32rpx 是按钮行与下方表单之间的呼吸位（原仅 6rpx + 表单自带 6rpx，太挤） */
.entry-row { display: flex; gap: 14rpx; margin: 26rpx 30rpx 32rpx; }
.entry-button { flex: 1 1 0; min-width: 0; height: 88rpx; margin: 0; padding: 0 8rpx; display: flex; align-items: center; justify-content: center; gap: 10rpx; border: 2rpx solid rgba(20, 20, 20, .16); border-radius: 44rpx; background: transparent; color: #141414; font-size: var(--wc-font-footnote); font-weight: 650; }
/* 三个图标同一套线性规格：24 viewBox / fill:none / stroke #141414 / stroke-width 2 / 圆角端点 ——
   样式、视觉大小与笔画粗细因此完全一致（实心 path 的笔画粗细由图形本身决定，无法保证一致，故改用描边）；
   统一 32rpx 呈现 */
.entry-button__icon { flex: 0 0 auto; width: 32rpx; height: 32rpx; }
/* 文字过长时省略，避免四字标签在窄屏把等分胶囊撑破 */
.entry-button__label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-button[disabled] { opacity: .5; }
/* 已抠图 → 完成态：灰字 + 淡边框 + 图标压暗，且不可点。
   必须写在 [disabled] 之后覆盖它的 opacity —— 否则整个胶囊会被刷淡成「不可用」观感 */
.entry-button.is-done, .entry-button.is-done[disabled] { border-color: rgba(20,20,20,.10); color: #b3afa8; background: transparent; opacity: 1; }
.entry-button.is-done .entry-button__icon { opacity: .45; }
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
