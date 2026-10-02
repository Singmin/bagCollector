<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api, logout } from '../../../services/http';

interface AccountStats { collectibleCount: number; shelfCount: number; storageUsedBytes: number; storageQuotaBytes: number }
const stats = ref<AccountStats | null>(null); const used = ref(''); const quota = ref(''); const loadError = ref('');
function bytes(value: number) { if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`; return `${(value / 1024 ** 3).toFixed(2)} GB`; }
async function load() { stats.value = null; loadError.value = ''; try { stats.value = await api<AccountStats>('/account'); used.value = bytes(stats.value.storageUsedBytes); quota.value = bytes(stats.value.storageQuotaBytes); } catch (error) { loadError.value = error instanceof Error ? error.message : '统计加载失败'; } }
function privacy() { uni.showModal({ title: '隐私说明', content: 'BagCollect 使用微信身份建立私人账户。你主动选择的照片会上传到私有对象存储，并用于裁剪、自动抠图和跨设备同步。不会公开展示，也不会获取手机号、昵称或通讯录。', showCancel: false }); }
async function signOut() { try { await logout(); uni.reLaunch({ url: '/pages/showcase/index' }); } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '退出登录失败', icon: 'none' }); } }
function removeAccount() { uni.showModal({ title: '永久注销账号？', content: '所有展示架、收藏信息和云端图片都将被删除，且无法恢复。', confirmText: '永久删除', confirmColor: '#9d3d36', success: async (result) => { if (!result.confirm) return; try { await api('/account', { method: 'DELETE' }); await logout(); uni.showModal({ title: '账号已注销', content: '你的数据删除任务已提交。', showCancel: false, success: () => uni.reLaunch({ url: '/pages/showcase/index' }) }); } catch (error) { uni.showToast({ title: error instanceof Error ? error.message : '注销失败', icon: 'none' }); } } }); }
function manageShelves() { uni.navigateTo({ url: '/package-settings/pages/shelves/index' }); }
/* 半窗收起：先播放下滑动画（收进屏幕底部），动画结束再返回上一页 */
const closing = ref(false);
function goBack() {
  if (closing.value) return;
  closing.value = true;
  setTimeout(() => uni.navigateBack(), 340);
}
onShow(() => void load());
</script>

<template>
  <!-- 设置页 · 方案 A+B：冷调玻璃底座（与添加页/详情卡同一材质）+ 纸感规则线。
       页面上半截露出模糊的场景图，玻璃半窗从底部起（对齐原型 .sheet）。
       半窗形式：点半窗外任意空白（上半截）= 收起（返回上一页）；
       自定义导航去掉原生返回按钮。 -->
  <view class="settings-screen" @tap="goBack">
    <view class="scene-bg" />

    <view class="sheet" :class="{ 'is-closing': closing }" @tap.stop>
      <view class="handle" />
      <text class="kick">SETTINGS</text>
      <text class="sheet-title">我的陈列柜</text>

      <view v-if="loadError" class="load-error">{{ loadError }}</view>
      <block v-else-if="stats">
        <view class="r"><text>收藏统计</text><strong>{{ stats.collectibleCount }} 件</strong></view>
        <view class="r" hover-class="is-hover" @tap="manageShelves">
          <text>展示架管理</text><strong class="row-more">{{ stats.shelfCount }} 个 ›</strong>
        </view>
        <view class="r"><text>云端存储</text><strong>{{ used }} / {{ quota }}</strong></view>
        <view class="r" hover-class="is-hover" @tap="privacy">
          <text>隐私与数据使用</text><text class="row-more">›</text>
        </view>
        <view class="r" hover-class="is-hover" @tap="signOut">
          <text>退出当前登录</text><text class="row-more">›</text>
        </view>
        <view class="r" hover-class="is-hover" @tap="removeAccount">
          <text class="danger">注销账号并删除全部数据</text><text class="row-more">›</text>
        </view>
      </block>

      <text class="hint">照片默认保存于你的私人云端空间。展示图会移除定位等 EXIF 信息；原图仅用于重新编辑，不会公开。</text>
      <button class="done" hover-class="is-pressed" @tap="goBack">完成</button>
    </view>
  </view>
</template>

<style scoped>
.settings-screen { position: relative; min-height: 100vh; display: flex; flex-direction: column; overflow: hidden; background: #f2f3f7; }
/* 上半截场景：冷调渐变光斑（原为模糊放大的袋子演示图，素材已移除） */
.scene-bg { position: absolute; top: 0; left: 0; right: 0; height: 42vh; background: linear-gradient(165deg, #dfe6f2 0%, #e9eef6 40%, #f2f3f7 100%); }
.scene-bg::after { content: ''; position: absolute; inset: 0; background: radial-gradient(60% 45% at 72% 18%, rgba(255,255,255,.85) 0%, rgba(255,255,255,0) 70%), radial-gradient(50% 40% at 18% 55%, rgba(198,209,230,.55) 0%, rgba(198,209,230,0) 72%); }

/* ── 玻璃底座（方案 A）：冷调白渐变 + 冷投影 + 内圈白棱，与详情卡同材质 ── */
.sheet { position: relative; z-index: 1; margin-top: auto; padding: 32rpx 40rpx calc(44rpx + env(safe-area-inset-bottom)); border-radius: 60rpx 60rpx 0 0; background: linear-gradient(160deg, #ffffff 0%, #fafbfd 56%, #f2f4f8 100%); box-shadow: inset 0 2rpx 0 #ffffff, inset 0 -2rpx 0 rgba(255,255,255,.34), inset 0 0 0 2rpx rgba(255,255,255,.9), 0 -33rpx 95rpx rgba(52,66,92,.16), 0 -5rpx 22rpx rgba(52,66,92,.07); }
/* 收起态：换用向下滑出的动画（animation 优先级高于入场动画的 fill 冻结帧，
   也不能用 transition —— 动画造成的样式变化不会触发 transition，之前就是这么失效的） */
.sheet.is-closing { animation: sheet-down .34s cubic-bezier(.55, 0, .85, .36) forwards; }
@keyframes sheet-down { from { transform: translateY(0); } to { transform: translateY(105%); } }
.handle { width: 76rpx; height: 8rpx; margin: 0 auto 26rpx; border-radius: 4rpx; background: rgba(20,20,20,.35); }
.kick { display: block; margin-bottom: 10rpx; color: #77736d; font-size: 20rpx; font-weight: 700; letter-spacing: 3rpx; }
/* 标题：字号对齐 H5 设置页 h3（25px × 1.82 = 45rpx）；与下方内容间距收紧 */
.sheet-title { display: block; margin-bottom: 14rpx; color: #141414; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 45rpx; font-weight: 700; line-height: 1.05; letter-spacing: -1rpx; }

/* ── 设置项（方案 B）：去卡片底、无圆角，仅 1px 细线分隔。
       首行上方不加线（避免和标题撞）、末行不加（避免和提示文字挤），只留中间几条。 ── */
.r { display: flex; justify-content: space-between; align-items: center; gap: 18rpx; padding: 28rpx 2rpx; border-bottom: 2rpx solid rgba(20,20,20,.09); color: #1d1f24; font-size: 26rpx; line-height: 1.7; }
.r:last-of-type { border-bottom: 0; }
.r.is-hover { background: rgba(20,20,20,.04); }
.r text { flex: 0 1 auto; }
.r strong { flex: 0 0 auto; font-size: 24rpx; font-weight: 700; }
.row-more { color: #77736d; font-weight: 400; }
.danger { color: #C50405; }

.hint { display: block; margin: 28rpx 2rpx 0; color: #8b9099; font-size: 21rpx; line-height: 1.65; }
/* 完成按钮（H5 .done：墨黑实色；2026-09-26 用户要求加高 46 → 54px） */
.done { display: flex; align-items: center; justify-content: center; height: 108rpx; margin: 32rpx 0 0; padding: 0; border: 0; border-radius: 54rpx; background: #141414; color: #ffffff; font-size: 30rpx; font-weight: 700; line-height: 1; transition: transform .18s ease; }
.done.is-pressed { transform: scale(.97); }

.load-error { margin: 6rpx 0 10rpx; padding: 24rpx; border-radius: 20rpx; background: #fae2de; color: #943d37; font-size: 24rpx; text-align: center; }
</style>
