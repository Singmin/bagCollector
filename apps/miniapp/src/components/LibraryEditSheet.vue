<script lang="ts">
export default { options: { virtualHost: true } };
</script>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import type { Collectible, Shelf } from '../types';
import { dataService } from '../services/data';
import { daysAgoText, formattedDate } from '../services/format';
const props = defineProps<{ item: Collectible; artwork: string; number: string; shelves: Shelf[]; knownTagCounts: Array<[string, number]> }>();
const emit = defineEmits<{ saved: [item: Collectible]; shelfCreated: [shelf: Shelf]; cancel: []; preview: [] }>();
const shelves = computed(() => props.shelves);
const knownTagCounts = computed(() => new Map(props.knownTagCounts));
const detailItem = computed(() => props.item);
const detailData = detailItem;
const detailArtwork = computed(() => props.artwork);
const detailNo = computed(() => props.number);
let alive = true;
let focusTimer: ReturnType<typeof setTimeout> | undefined;

type SuggestSegments = Array<{ t: string; hit: boolean }>;
interface SuggestState {
  hint: string;
  keyword: string;
  exact: boolean;
  rows: Array<{ text: string; count: number; segs: SuggestSegments }>;
}

function highlightSegments(source: string, key: string): SuggestSegments {
  const at = source.toLowerCase().indexOf(key.toLowerCase());
  if (at < 0) return [{ t: source, hit: false }];
  return [
    { t: source.slice(0, at), hit: false },
    { t: source.slice(at, at + key.length), hit: true },
    { t: source.slice(at + key.length), hit: false }
  ].filter((segment) => segment.t);
}

const shelfSuggestVisible = ref(false);
const tagSuggestVisible = ref(false);
let suggestHideTimer: ReturnType<typeof setTimeout> | undefined;


function hideSuggestsSoon() {
  if (suggestHideTimer) clearTimeout(suggestHideTimer);
  suggestHideTimer = setTimeout(() => {
    shelfSuggestVisible.value = false;
    tagSuggestVisible.value = false;
  }, 150);
}

const shelfSuggest = computed<SuggestState | null>(() => {
  const keyword = editShelf.value.trim();
  if (!keyword) return null;
  const lower = keyword.toLowerCase();
  const rows = [...shelves.value]
    .sort((a, b) => b.itemCount - a.itemCount || a.name.localeCompare(b.name, 'zh'))
    .filter((shelf) => shelf.name.toLowerCase().includes(lower) && shelf.name !== keyword)
    .slice(0, 5)
    .map((shelf) => ({ text: shelf.name, count: shelf.itemCount, segs: highlightSegments(shelf.name, keyword) }));
  const exact = shelves.value.some((shelf) => shelf.name.toLowerCase() === lower);
  if (!rows.length && exact) return null;
  return { hint: rows.length ? '已有品牌' : '没有匹配的已有品牌', keyword, exact, rows };
});

const tagSuggest = computed<SuggestState | null>(() => {
  const keyword = editTagDraft.value.trim();
  if (!keyword) return null;
  const lower = keyword.toLowerCase();
  const rows = [...knownTagCounts.value.entries()]
    .filter(([tag]) => tag.toLowerCase().includes(lower) && !editTags.value.includes(tag))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, 6)
    .map(([tag, count]) => ({ text: tag, count, segs: highlightSegments(tag, keyword) }));
  const exact = [...knownTagCounts.value.keys()].some((tag) => tag.toLowerCase() === lower);
  if (!rows.length && exact) return null;
  return { hint: rows.length ? '已有标签' : '没有匹配的已有标签', keyword, exact, rows };
});

function commitShelfPick(value: string) {
  editShelf.value = value.trim();
  shelfSuggestVisible.value = false;
}

function pickTag(tag: string) {
  const value = tag.trim().slice(0, 12);
  if (value && !editTags.value.includes(value)) {
    editTags.value = [...editTags.value, value].slice(0, 30);
  }
  editTagDraft.value = '';
}
const saving = ref(false);
const editName = ref('');
const editShelf = ref('');
const editTags = ref<string[]>([]);
const editTagDraft = ref('');
const editNote = ref('');

const editQuantity = ref(1);
const QTY_MAX = 99;
function changeQuantity(delta: number) {
  editQuantity.value = Math.min(QTY_MAX, Math.max(1, editQuantity.value + delta));
}

const editDate = ref('');
const editDateValue = computed(() => (editDate.value ? editDate.value.slice(0, 10) : ''));
const todayStr = computed(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
function onEditDateChange(event: Event) {
  const value = (event as unknown as { detail?: { value?: string } }).detail?.value;
  if (value) editDate.value = new Date(`${value}T12:00:00`).toISOString();
}

const editVisibility = ref<'PRIVATE' | 'PUBLIC'>('PUBLIC');

const focusedField = ref('');
const editNameFocused = ref(false);
function inputValue(event: Event) {
  return (event as unknown as { detail?: { value?: string } }).detail?.value ?? '';
}

function onEditNameInput(event: Event) { editName.value = inputValue(event); }
function onEditShelfInput(event: Event) {
  editShelf.value = inputValue(event);
  shelfSuggestVisible.value = Boolean(editShelf.value.trim());
}
function onEditNoteInput(event: Event) { editNote.value = inputValue(event); }


function onTagInput(event: Event) {
  editTagDraft.value = inputValue(event);
  tagSuggestVisible.value = Boolean(editTagDraft.value.trim());
}

function commitTags() {
  const parts = editTagDraft.value.split(/[\s,，、;；]+/)
    .map((tag) => tag.trim().slice(0, 12))
    .filter(Boolean);
  if (parts.length) {
    const next = [...editTags.value];
    for (const tag of parts) if (!next.includes(tag)) next.push(tag);
    editTags.value = next.slice(0, 30);
  }
  editTagDraft.value = '';
}

function removeTag(tag: string) {
  editTags.value = editTags.value.filter((current) => current !== tag);
}
async function saveEdit() {
  const item = detailItem.value;
  if (!alive || !item || saving.value) return;

  commitTags();
  const name = editName.value.trim();
  if (!name) return void uni.showToast({ title: '请填写收藏名称', icon: 'none' });

  const shelfName = editShelf.value.trim() || item.shelfName;
  const tags = [...editTags.value];
  const notes = editNote.value.trim();
  saving.value = true;
  try {
    let shelf = shelves.value.find((current) => current.name === shelfName);
    if (!shelf) {

      shelf = await dataService.createShelf({ name: shelfName, theme: 'SAGE' });
      emit('shelfCreated', shelf);
    }
    const updated = await dataService.updateCollectible(item.id, { name, notes, tags, shelfId: shelf.id, quantity: editQuantity.value, addedAt: editDate.value, visibility: editVisibility.value });
    if (alive) emit('saved', updated);


    uni.showToast({ title: `“${name}”已更新`, icon: 'none' });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : '保存失败', icon: 'none' });
  } finally {
    saving.value = false;
  }
}
function cancelEdit() { emit('cancel'); }
function previewDetailArtwork() { emit('preview'); }
function blockScroll() {}
function editImages() {
  if (props.item.imageEditable === false) return;
  uni.navigateTo({ url: `/package-editor/pages/metadata/index?id=${props.item.id}&edit=1` });
}
onMounted(() => {
  editName.value = props.item.name; editShelf.value = props.item.shelfName;
  editTags.value = [...props.item.tags]; editNote.value = props.item.notes;
  editQuantity.value = props.item.quantity ?? 1; editDate.value = props.item.addedAt;
  editVisibility.value = props.item.visibility ?? 'PUBLIC';
  focusTimer = setTimeout(() => { if (alive) editNameFocused.value = true; }, 150);
});
onScopeDispose(() => { alive = false; clearTimeout(focusTimer); clearTimeout(suggestHideTimer); });
</script>

<template>
<view class="edit-layer">
      <view class="detail-backdrop" @tap="cancelEdit" @touchmove.stop.prevent="blockScroll" />
      <view class="edit-sheet">
        <view class="sheet-handle" />
        <scroll-view class="edit-scroll" scroll-y enhanced :show-scrollbar="false">
          <button v-if="detailData?.imageEditable !== false" class="detail-edit" @tap="editImages">编辑图片</button>

          <view class="detail-artwork detail-artwork--editing" @tap="previewDetailArtwork">
            <image v-if="detailArtwork" :src="detailArtwork" mode="aspectFit" />
            <view v-else class="detail-artwork__placeholder" />
          </view>
          <view>

            <view class="ef-readout">
              <view class="ef-readout__cell ef-readout__cell--no">
                <text class="ef-readout__v">{{ detailNo || '—' }}</text>
                <text class="ef-readout__k">编号</text>
              </view>
              <view class="ef-readout__cell ef-readout__cell--mid">
                <text class="ef-readout__v">{{ formattedDate(editDate, '-') }}</text>
                <text class="ef-readout__k">收藏日期</text>
              </view>
              <view class="ef-readout__cell ef-readout__cell--last">
                <text class="ef-readout__v">{{ daysAgoText(editDate) }}</text>
                <text class="ef-readout__k">入库时长</text>
              </view>
            </view>


            <view class="ef-row">
              <text class="ef-key">收藏日期</text>
              <picker class="ef-val" mode="date" :value="editDateValue" :end="todayStr" @change="onEditDateChange">
                <view class="ef-input ef-date-row">{{ editDateValue }}<text class="ef-date-hint">点按修改</text></view>
              </picker>
            </view>


            <view class="ef-row">
              <text class="ef-key">名称</text>
              <view class="ef-val">
                <input
                  class="ef-input"
                  :class="{ 'is-focus': focusedField === 'name' }"
                  :value="editName"
                  :focus="editNameFocused"
                  type="text"
                  maxlength="24"
                  placeholder="给它起个名字"
                  placeholder-class="ef-placeholder"
                  @input="onEditNameInput"
                  @focus="focusedField = 'name'"
                  @blur="focusedField = ''"
                />
              </view>
            </view>

            <view class="ef-row">
              <text class="ef-key">品牌 / 店铺</text>
              <view class="ef-val">
                <input
                  class="ef-input"
                  :class="{ 'is-focus': focusedField === 'shelf' }"
                  :value="editShelf"
                  type="text"
                  maxlength="20"
                  placeholder="选一个或直接输入"
                  placeholder-class="ef-placeholder"
                  @input="onEditShelfInput"
                  @focus="focusedField = 'shelf'; shelfSuggestVisible = Boolean(editShelf.trim())"
                  @blur="focusedField = ''; hideSuggestsSoon()"
                />

                <view v-if="shelfSuggestVisible && shelfSuggest" class="ef-suggest">
                  <text class="ef-suggest__hint">{{ shelfSuggest.hint }}</text>
                  <view
                    v-for="row in shelfSuggest.rows"
                    :key="row.text"
                    class="ef-suggest__item"
                    hover-class="is-hover"
                    :hover-stay-time="80"
                    @tap="commitShelfPick(row.text)"
                  >
                    <text class="ef-suggest__label"><text v-for="(seg, i) in row.segs" :key="i" :class="{ 'is-hit': seg.hit }">{{ seg.t }}</text></text>
                    <text class="ef-suggest__count">已有 {{ row.count }} 件</text>
                  </view>
                  <view v-if="!shelfSuggest.exact" class="ef-suggest__item ef-suggest__new" hover-class="is-hover" :hover-stay-time="80" @tap="commitShelfPick(shelfSuggest.keyword)">
                    <text class="ef-suggest__label">＋ 新建品牌「<text class="is-hit">{{ shelfSuggest.keyword }}</text>」</text>
                  </view>
                </view>
              </view>
            </view>


            <view class="ef-row">
              <text class="ef-key">数量</text>
              <view class="ef-val ef-qty">
                <view class="ef-qty__btn" :class="{ 'is-disabled': editQuantity <= 1 }" hover-class="is-hover" :hover-stay-time="80" @tap="changeQuantity(-1)">−</view>
                <text class="ef-qty__value">{{ editQuantity }}</text>
                <view class="ef-qty__btn" :class="{ 'is-disabled': editQuantity >= 99 }" hover-class="is-hover" :hover-stay-time="80" @tap="changeQuantity(1)">＋</view>
              </view>
            </view>

            <view class="ef-row ef-row--tags">
              <text class="ef-key">标签</text>
              <view class="ef-val">
                <view class="ef-tagbox" :class="{ 'is-focus': focusedField === 'tag' }">
                  <view v-for="tag in editTags" :key="tag" class="ef-chip">
                    <text class="ef-chip__name"># {{ tag }}</text>
                    <text class="ef-chip__x" @tap.stop="removeTag(tag)">×</text>
                  </view>
                  <input
                    class="ef-tagbox__input"
                    :value="editTagDraft"
                    type="text"
                    confirm-type="done"
                    maxlength="12"
                    :placeholder="editTags.length ? '' : '加标签，空格或回车分隔'"
                    placeholder-class="ef-placeholder"
                    @input="onTagInput"
                    @confirm="commitTags"
                    @focus="focusedField = 'tag'; tagSuggestVisible = Boolean(editTagDraft.trim())"
                    @blur="focusedField = ''; hideSuggestsSoon()"
                  />
                </view>

                <view v-if="tagSuggestVisible && tagSuggest" class="ef-suggest">
                  <text class="ef-suggest__hint">{{ tagSuggest.hint }}</text>
                  <view
                    v-for="row in tagSuggest.rows"
                    :key="row.text"
                    class="ef-suggest__item"
                    hover-class="is-hover"
                    :hover-stay-time="80"
                    @tap="pickTag(row.text)"
                  >
                    <text class="ef-suggest__label"># <text v-for="(seg, i) in row.segs" :key="i" :class="{ 'is-hit': seg.hit }">{{ seg.t }}</text></text>
                    <text class="ef-suggest__count">已有 {{ row.count }} 件</text>
                  </view>
                  <view v-if="!tagSuggest.exact" class="ef-suggest__item ef-suggest__new" hover-class="is-hover" :hover-stay-time="80" @tap="pickTag(tagSuggest.keyword)">
                    <text class="ef-suggest__label">＋ 新建标签「<text class="is-hit">{{ tagSuggest.keyword }}</text>」</text>
                  </view>
                </view>
              </view>
            </view>

            <view class="ef-row ef-row--note">
              <text class="ef-key">备注</text>
              <view class="ef-val">
                <textarea
                  class="ef-area"
                  :class="{ 'is-focus': focusedField === 'note' }"
                  :value="editNote"
                  maxlength="2000"
                  :show-confirm-bar="false"
                  placeholder="留一句话，可留空"
                  placeholder-class="ef-placeholder"
                  @input="onEditNoteInput"
                  @focus="focusedField = 'note'"
                  @blur="focusedField = ''"
                />
              </view>
            </view>


            <view class="ef-row">
              <text class="ef-key">谁能看到</text>
              <view class="ef-val ef-vis">
                <view class="ef-vis__opt" :class="{ 'is-active': editVisibility === 'PRIVATE' }" hover-class="is-hover" :hover-stay-time="80" @tap="editVisibility = 'PRIVATE'">私密收藏</view>
                <view class="ef-vis__opt" :class="{ 'is-active': editVisibility === 'PUBLIC' }" hover-class="is-hover" :hover-stay-time="80" @tap="editVisibility = 'PUBLIC'">公开展示</view>
              </view>
            </view>
          </view>
        </scroll-view>


        <view class="detail-actions">
          <button class="detail-edit" @tap="cancelEdit()">取消</button>
          <button class="detail-save" :disabled="saving" @tap="saveEdit()">保存</button>
        </view>
      </view>
    </view>
</template>

<style scoped>
.detail-artwork { display: flex; align-items: center; justify-content: center; height: 306rpx; margin: 0 0 33rpx; padding: 18rpx; box-sizing: border-box; overflow: hidden; border-radius: 36rpx; }
.detail-artwork image { width: 100%; height: 269rpx; filter: drop-shadow(0 7rpx 18rpx rgba(0,0,0,.18)); }
.detail-artwork__placeholder { width: 234rpx; height: 269rpx; border-radius: 28rpx; background: rgba(20,20,20,.045); }
.detail-artwork--editing { height: 233rpx; margin: 0 0 25rpx; }
.detail-artwork--editing image, .detail-artwork--editing .detail-artwork__placeholder { height: 196rpx; }
.ef-readout { display: flex; align-items: flex-start; margin: 0 0 25rpx; padding: 4rpx 0 0; }
.ef-readout__cell { flex: 1 1 0; min-width: 0; text-align: center; border-left: 2rpx solid rgba(20,20,20,.085); }
.ef-readout__cell--no { border-left: 0; }
.ef-readout__v { display: block; margin: 0 0 9rpx; color: #3a3630; font-size: var(--wc-font-description); font-weight: 600; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ef-readout__k { display: block; color: #a8a49d; font-size: var(--wc-font-footnote); font-weight: 700; line-height: 1.2; letter-spacing: .8rpx; white-space: nowrap; }
</style>

<style>
@import '../styles/edit-form.css';
</style>
