<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { api, logout } from '../../services/http';
import { setTabBarHidden } from '../../services/tab-bar';

/* ── 设置半窗（首页内浮层，不再跳页）──
   上滑进入 / 下滑收起（双向都是 transition，状态机见 watch(show)）；
   蒙层是纯色淡黑 rgba(0,0,0,.42)，不用任何图片。

   底栏：半窗贴着屏幕底部、本来就该把它整条盖住，但自定义底栏是框架层、
   页面里的浮层压不住它 —— 蒙一层（masked）仍会露出轮廓和顶部那条渐隐带，
   压在「完成」按钮下面（用户 2026-09-28 截图指出）。所以跟编辑半窗一样
   整条下滑隐藏，关闭时还原。 */

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const visible = ref(false);
const opened = ref(false);

interface AccountStats { collectibleCount: number; shelfCount: number; storageUsedBytes: number; storageQuotaBytes: number }
const stats = ref<AccountStats | null>(null); const used = ref(''); const quota = ref(''); const loadError = ref('');
function bytes(value: number) { if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`; return `${(value / 1024 ** 3).toFixed(2)} GB`; }
async function load() { stats.value = null; loadError.value = ''; try { stats.value = await api<AccountStats>('/account'); used.value = bytes(stats.value.storageUsedBytes); quota.value = bytes(stats.value.storageQuotaBytes); } catch (error) { loadError.value = error instanceof Error ? error.message : '统计加载失败'; } }
function privacy() { uni.showModal({ title: '隐私说明', content: 'BagCollect 使用微信身份建立私人账户。你主动选择的照片会上传到私有对象存储，并用于裁剪、自动抠图和跨设备同步。不会公开展示，也不会获取手机号、昵称或通讯录。', showCancel: false }); }
async function signOut() { try { await logout(); uni.reLaunch({ url: '/pages/showcase/index' }); } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '退出登录失败', icon: 'none' }); } }
function removeAccount() { uni.showModal({ title: '永久注销账号？', content: '所有展示架、收藏信息和云端图片都将被删除，且无法恢复。', confirmText: '永久删除', confirmColor: '#9d3d36', success: async (result) => { if (!result.confirm) return; try { await api('/account', { method: 'DELETE' }); await logout(); uni.showModal({ title: '账号已注销', content: '你的数据删除任务已提交。', showCancel: false, success: () => uni.reLaunch({ url: '/pages/showcase/index' }) }); } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '注销失败', icon: 'none' }); } } }); }
function manageShelves() { uni.navigateTo({ url: '/package-settings/pages/shelves/index' }); }

let closeTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.show, (val) => {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined; }
  if (val) {
    visible.value = true;
    setTabBarHidden(true);
    void load();
    /* 等节点挂上、首帧画出 translateY(100%) 的起点，再过渡到 0 —— 上滑才生效 */
    nextTick(() => setTimeout(() => { opened.value = true; }, 30));
  } else if (visible.value) {
    opened.value = false;
    setTabBarHidden(false);
    closeTimer = setTimeout(() => { visible.value = false; }, 360);
  }
});

function requestClose() { emit('close'); }
</script>

<template>
  <view v-if="visible" class="ss-root">
    <!-- 蒙层：纯色淡黑，不用图片 -->
    <view class="ss-mask" :class="{ 'is-open': opened }" @tap="requestClose" />
    <view class="ss-sheet" :class="{ 'is-open': opened }" @tap.stop>
      <view class="ss-handle" />
      <text class="ss-kick">SETTINGS</text>
      <text class="ss-title">我的陈列柜</text>

      <view v-if="loadError" class="ss-error">{{ loadError }}</view>
      <block v-else-if="stats">
        <view class="ss-row"><text>收藏统计</text><strong>{{ stats.collectibleCount }} 件</strong></view>
        <view class="ss-row" hover-class="is-hover" @tap="manageShelves">
          <text>展示架管理</text><strong class="row-more">{{ stats.shelfCount }} 个 ›</strong>
        </view>
        <view class="ss-row"><text>云端存储</text><strong>{{ used }} / {{ quota }}</strong></view>
        <view class="ss-row" hover-class="is-hover" @tap="privacy">
          <text>隐私与数据使用</text><text class="row-more">›</text>
        </view>
        <view class="ss-row" hover-class="is-hover" @tap="signOut">
          <text>退出当前登录</text><text class="row-more">›</text>
        </view>
        <view class="ss-row" hover-class="is-hover" @tap="removeAccount">
          <text class="danger">注销账号并删除全部数据</text><text class="row-more">›</text>
        </view>
      </block>

      <text class="ss-hint">照片默认保存于你的私人云端空间。展示图会移除定位等 EXIF 信息；原图仅用于重新编辑，不会公开。</text>
      <button class="ss-done" hover-class="is-pressed" @tap="requestClose">完成</button>
    </view>
  </view>
</template>

<style scoped>
/* 根容器：盖住页面视口；自定义底栏是框架层，由 setTabBarHidden 整条下滑让位 */
.ss-root { position: fixed; z-index: 950; top: 0; left: 0; right: 0; bottom: 0; }
/* 蒙层：淡淡的黑色，透明度过渡 */
.ss-mask { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, .42); opacity: 0; transition: opacity .3s ease; }
.ss-mask.is-open { opacity: 1; }

/* 玻璃底座：上滑进入 / 下滑收起，双向 transition */
.ss-sheet { position: absolute; left: 0; right: 0; bottom: 0; padding: 32rpx 40rpx calc(44rpx + env(safe-area-inset-bottom)); border-radius: 60rpx 60rpx 0 0; background: linear-gradient(160deg, #ffffff 0%, #fafbfd 56%, #f2f4f8 100%); box-shadow: inset 0 2rpx 0 #ffffff, inset 0 -2rpx 0 rgba(255,255,255,.34), inset 0 0 0 2rpx rgba(255,255,255,.9), 0 -33rpx 95rpx rgba(52,66,92,.16), 0 -5rpx 22rpx rgba(52,66,92,.07); transform: translateY(105%); transition: transform .34s cubic-bezier(.2, .75, .22, 1); }
.ss-sheet.is-open { transform: translateY(0); }

.ss-handle { width: 76rpx; height: 8rpx; margin: 0 auto 26rpx; border-radius: 4rpx; background: rgba(20, 20, 20, .35); }
.ss-kick { display: block; margin-bottom: 10rpx; color: #77736d; font-size: 20rpx; font-weight: 700; letter-spacing: 3rpx; }
/* 标题：字号对齐 H5 设置页 h3（25px × 1.82 = 45rpx） */
.ss-title { display: block; margin-bottom: 14rpx; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 45rpx; font-weight: 700; line-height: 1.05; letter-spacing: -1rpx; }

/* 设置项：纸感规则线（去卡片底，仅 1px 细线分隔） */
.ss-row { display: flex; justify-content: space-between; align-items: center; gap: 18rpx; padding: 28rpx 2rpx; border-bottom: 2rpx solid rgba(20,20,20,.09); color: #1d1f24; font-size: 26rpx; line-height: 1.7; }
.ss-row:last-of-type { border-bottom: 0; }
.ss-row.is-hover { background: rgba(20,20,20,.04); }
.ss-row text { flex: 0 1 auto; }
.ss-row strong { flex: 0 0 auto; font-size: 24rpx; font-weight: 700; }
.row-more { color: #77736d; font-weight: 400; }
.danger { color: #C50405; }

.ss-hint { display: block; margin: 28rpx 2rpx 0; color: #8b9099; font-size: 21rpx; line-height: 1.65; }
/* 完成按钮：墨黑实色胶囊，54px 高 */
.ss-done { display: flex; align-items: center; justify-content: center; height: 108rpx; margin: 32rpx 0 0; padding: 0; border: 0; border-radius: 54rpx; background: #141414; color: #ffffff; font-size: 30rpx; font-weight: 700; line-height: 1; transition: transform .18s ease; }
.ss-done.is-pressed { transform: scale(.97); }

.ss-error { margin: 6rpx 0 10rpx; padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: 24rpx; text-align: center; }
</style>
