<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Collectible, Shelf } from '../../types';
import { dataService } from '../../services/data';
import { setTabBarHidden } from '../../services/tab-bar';

/* ── 标记已有半窗（先核对后入库，全局统一交互）──
   show 置 true 自动预填 feed 信息并拉展架列表；wished = 条目已在心愿袋（顶部互斥提示，确认标记后自动移出）；
   保存成功 emit('saved', 来源条目, 新建的收藏 id) 由父页面同步本地状态。样式复用 styles/edit-form.css */
const props = defineProps<{ show: boolean; item: Collectible | null; wished?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', source: Collectible, createdId: string): void }>();

const saving = ref(false);
const focusField = ref('');
const name = ref(''); const tagList = ref<string[]>([]); const tagDraft = ref(''); const notes = ref('');
const shelves = ref<Shelf[]>([]); const shelfText = ref(''); const shelfId = ref(''); const shelfOpen = ref(false);
let suggestTimer: ReturnType<typeof setTimeout> | undefined;

const markImage = computed(() => props.item?.displayImageUrl ?? props.item?.thumbnailUrl ?? '');
const fromWish = computed(() => !!props.item && !!props.wished);

watch(() => props.show, (visible) => {
  setTabBarHidden(visible);
  if (!visible || !props.item) return;
  void (async () => {
    try { if (!shelves.value.length) shelves.value = await dataService.shelves(); } catch { /* 拉不到就让分类留空 */ }
    name.value = props.item!.name;
    tagList.value = props.item!.tags.slice(0, 30);
    tagDraft.value = '';
    notes.value = props.item!.notes;
    /* 品牌/名称：自动填充官方袋子的原有品牌信息（ownerName，如「瑞幸咖啡」）。
       若它正好与某个展架同名则选中该展架；否则留待用户改或走后端默认展架 */
    const brand = props.item!.ownerName ?? '';
    const match = shelves.value.find((shelf) => shelf.name === brand);
    shelfId.value = match?.id ?? '';
    shelfText.value = brand || shelves.value[0]?.name || '';
    shelfOpen.value = false;
  })();
});

const shelfSuggest = computed(() => {
  const text = shelfText.value.trim().toLowerCase();
  const list = shelves.value.map((shelf) => ({ id: shelf.id, name: shelf.name }));
  if (!text) return list;
  return list.filter((row) => row.name.toLowerCase().includes(text));
});
function onShelfInput(event: Event) {
  shelfText.value = (event as unknown as { detail?: { value?: string } }).detail?.value ?? '';
  shelfOpen.value = true;
}
function pickShelf(row: { id: string; name: string }) {
  shelfId.value = row.id; shelfText.value = row.name; shelfOpen.value = false;
}
function hideSuggestSoon() {
  if (suggestTimer) clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => { shelfOpen.value = false; }, 150);
}
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
async function save() {
  const source = props.item;
  /* 品牌/名称非必填：与展架同名则归入该展架；不同名 / 留空时省略 shelfId，
     后端自动归入默认展架（品牌文字本身不会丢失——名称与标签才是收藏的主信息） */
  const shelf = shelves.value.find((current) => current.id === shelfId.value);
  const nameVal = name.value.trim();
  if (!nameVal) return void uni.showToast({ title: '请填写名称', icon: 'none' });
  if (!source || saving.value) return;
  saving.value = true;
  try {
    commitTags();
    /* 标记已有 = 拥有这只官方袋子，必须走认领接口：它会建好收藏并把官方图片复制到用户名下
       （走 POST /collectibles 只会得到一条没有图、且永远停在 UPLOADING 的记录，收藏架看不到）。
       半窗里改过的名称 / 标签 / 备注作为覆盖值传给后端；品牌与展架同名时才传 shelfId。 */
    const { collectibleId } = await dataService.claimOfficialBag(source.id, {
      name: nameVal,
      ...(shelf ? { shelfId: shelf.id } : {}),
      notes: notes.value.trim(),
      tags: [...tagList.value]
    });
    if (props.wished) {
      try { await dataService.removeWishlist(source.id); } catch { /* 移出失败不阻塞入库 */ }
    }
    emit('saved', source, collectibleId);
    emit('close');
    /* 记录先落库、图片随后由 worker 复制，所以这里是「已在收藏架（稍后现身）」而不是「已入库」 */
    uni.showToast({ title: '已加入收藏架', icon: 'success' });
  } catch (error) {
    /* 同一只袋子只能拥有一次。本地「已标记」状态是内存态，重启后会丢，
       用户可能再标一次 —— 后端这时回 409，提示他去收藏架看，别让人以为又失败。 */
    const conflict = (error as { code?: string }).code === 'CONFLICT'
      || (error instanceof Error && error.message.includes('已经拥有'));
    if (conflict) emit('close');
    uni.showToast({
      title: conflict ? '这只袋子已在收藏架' : (error instanceof Error ? error.message : '收藏失败'),
      icon: 'none'
    });
  } finally { saving.value = false; }
}
function close() { emit('close'); }
</script>

<template>
  <view v-if="show" class="edit-layer">
    <view class="detail-backdrop" @tap="close" @touchmove.stop.prevent />
    <view class="edit-sheet">
      <view class="sheet-handle" />
      <scroll-view class="edit-scroll" scroll-y enhanced :show-scrollbar="false">
        <view v-if="fromWish" class="mark-hint">
          <text class="mark-hint__icon">♥</text>
          <text class="mark-hint__text">已在你的心愿袋中，确认标记后将自动移出</text>
        </view>
        <view class="detail-artwork detail-artwork--editing">
          <image v-if="markImage" :src="markImage" mode="aspectFit" />
          <view v-else class="detail-artwork__placeholder" />
        </view>
        <view class="ef-row">
          <text class="ef-key">名称</text>
          <view class="ef-val"><input class="ef-input" :class="{ 'is-focus': focusField === 'name' }" v-model="name" placeholder="给它起个名字" maxlength="24" placeholder-class="ef-placeholder" @focus="focusField = 'name'" @blur="focusField = ''" /></view>
        </view>
        <view class="ef-row">
          <text class="ef-key">品牌/名称</text>
          <view class="ef-val">
            <input class="ef-input" :class="{ 'is-focus': focusField === 'shelf' }" :value="shelfText" placeholder="已按原信息填好，可修改" placeholder-class="ef-placeholder" @focus="focusField = 'shelf'; shelfOpen = true" @blur="focusField = ''; hideSuggestSoon()" @input="onShelfInput" />
            <view v-if="shelfOpen && shelfSuggest.length" class="ef-suggest">
              <text class="ef-suggest__hint">选择展架分类</text>
              <view v-for="row in shelfSuggest" :key="row.id" class="ef-suggest__item" hover-class="is-hover" :hover-stay-time="80" @tap="pickShelf(row)">
                <text class="ef-suggest__label">{{ row.name }}</text>
              </view>
            </view>
          </view>
        </view>
        <view class="ef-row ef-row--tags">
          <text class="ef-key">标签</text>
          <view class="ef-val">
            <view class="ef-tagbox" :class="{ 'is-focus': focusField === 'tags' }">
              <view v-for="tag in tagList" :key="tag" class="ef-chip">
                <text class="ef-chip__name"># {{ tag }}</text>
                <text class="ef-chip__x" @tap.stop="removeTag(tag)">×</text>
              </view>
              <input class="ef-tagbox__input" :class="{ 'is-focus': focusField === 'tags' }" :value="tagDraft" placeholder="添加标签" placeholder-class="ef-placeholder" @input="onTagInput" @confirm="commitTags" @focus="focusField = 'tags'" @blur="focusField = ''; commitTags()" />
            </view>
          </view>
        </view>
        <view class="ef-row ef-row--note">
          <text class="ef-key">备注</text>
          <view class="ef-val"><textarea class="ef-area" :class="{ 'is-focus': focusField === 'notes' }" v-model="notes" placeholder="这只袋子是怎么到你手上的？" maxlength="500" placeholder-class="ef-placeholder" @focus="focusField = 'notes'" @blur="focusField = ''; hideSuggestSoon()" /></view>
        </view>
      </scroll-view>
      <view class="detail-actions">
        <button class="detail-edit" @tap="close">取消</button>
        <button class="detail-save" :disabled="saving" @tap="save">{{ saving ? '收藏中…' : '确认标记已有' }}</button>
      </view>
    </view>
  </view>
</template>

<style scoped>
/* 互斥提示：引用式轻提示 —— 无底色无边框，居中一行，红心引导 */
.mark-hint { display: flex; align-items: center; justify-content: center; gap: 10rpx; margin-bottom: 26rpx; }
.mark-hint__icon { flex: 0 0 auto; color: #c50405; font-size: 22rpx; line-height: 1; }
.mark-hint__text { color: rgba(197, 4, 5, .85); font-size: var(--wc-font-footnote); line-height: 1.5; }
/* 顶部图区：与编辑半窗 detail-artwork--editing 同值（源样式在 library scoped 内，组件里重定义） */
.detail-artwork { display: flex; align-items: center; justify-content: center; height: 233rpx; margin: 0 0 25rpx; padding: 18rpx; box-sizing: border-box; overflow: hidden; border-radius: 36rpx; }
.detail-artwork image { width: 100%; height: 196rpx; filter: drop-shadow(0 7rpx 18rpx rgba(0, 0, 0, .18)); }
.detail-artwork__placeholder { width: 234rpx; height: 196rpx; border-radius: 28rpx; background: rgba(20, 20, 20, .045); }
</style>

<style>
@import '../../styles/edit-form.css';
</style>
