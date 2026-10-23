<script lang="ts">
// Keep the 3D chain continuous across the native custom-component boundary.
export default { options: { virtualHost: true } };
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { CardMotionFrame } from '../services/library-card-motion';
import {
  clampSurfaceAngle, createDeviceSurfaceTracker, normalizeDevicePose,
  claimSurfaceSensor, ownsSurfaceSensor, releaseSurfaceSensor, hasSurfaceSensor,
  SURFACE_IDLE_DELAY, SURFACE_SCROLL_DELAY, SURFACE_TRANSITION,
  type DevicePose, type DevicePoseUnit, type SurfacePose, type LibraryCardSurfaceHandle
} from '../services/library-card-surface';

const props = defineProps<{
  phase: CardMotionFrame['phase'];
  paused: boolean;
}>();

const pose = ref<SurfacePose>({ x: 0, y: 0 });
const idleEnabled = ref(false);
const idleRunning = ref(false);
const frozen = ref(false);
const showGlare = ref(false);
let enabled = false;
let scrolling = false;
const deviceTracker = createDeviceSurfaceTracker();
let latestDevice: DevicePose | null = null;
let deviceTarget: SurfacePose = { x: 0, y: 0 };
let idleDeviceAnchor: SurfacePose = { x: 0, y: 0 };
let pendingPose: SurfacePose | null = null;
let pendingFromDevice = false;
let lastPublish = 0;
let transition = { from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, started: 0 };
let inputTimer: ReturnType<typeof setTimeout> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
let deviceDataTimer: ReturnType<typeof setTimeout> | undefined;
let deviceListening = false;
let deviceRevision = 0;
let sensorToken = 0;
let deviceSampleLogged = false;
let invalidDeviceSampleLogged = false;
let devicePoseLogged = false;
// Retain a detected native unit across pause/resume. Small degree readings must
// not switch back to radians merely because they fit inside radian bounds.
let deviceAngleUnit: DevicePoseUnit = 'radians';

const tiltStyle = computed(() => ({
  transform: `translateZ(0) rotateX(${pose.value.x}deg) rotateY(${pose.value.y}deg)`,
  transitionDuration: frozen.value ? '0ms' : `${SURFACE_TRANSITION}ms`
}));
const idleStyle = computed(() => ({ animationPlayState: idleRunning.value && !frozen.value ? 'running' : 'paused' }));
const glareStyle = computed(() => ({ opacity: showGlare.value ? 0.12 : 0 }));
const glarePositionStyle = computed(() => ({
  transform: `translate3d(${pose.value.y * 1.5}%, ${-pose.value.x * 1.5}%, 0)`,
  transitionDuration: frozen.value ? '0ms' : `${SURFACE_TRANSITION}ms`
}));

function sampledPose(): SurfacePose {
  const t = Math.min(1, Math.max(0, (Date.now() - transition.started) / SURFACE_TRANSITION));
  return {
    x: transition.from.x + (transition.to.x - transition.from.x) * t,
    y: transition.from.y + (transition.to.y - transition.from.y) * t
  };
}

function publishPose(target: SurfacePose) {
  // Idle rotates only around the vertical center axis, by +/- 3 degrees.
  // Reserve its Y envelope while keeping the full X tilt range available.
  const next = {
    x: clampSurfaceAngle(target.x),
    y: clampSurfaceAngle(target.y, idleEnabled.value ? 5 : 8)
  };
  if (Math.abs(next.x - pose.value.x) < 0.01 && Math.abs(next.y - pose.value.y) < 0.01) return false;
  transition = { from: sampledPose(), to: next, started: Date.now() };
  lastPublish = Date.now();
  pose.value = next;
  return true;
}

function flushPose() {
  inputTimer = undefined;
  const next = pendingPose;
  const fromDevice = pendingFromDevice;
  pendingPose = null;
  pendingFromDevice = false;
  if (enabled && !frozen.value && next && publishPose(next) && fromDevice && !devicePoseLogged) {
    devicePoseLogged = true;
    console.info('[LibraryCardSurface] 倾斜已应用', { session: sensorToken, angles: { ...pose.value } });
  }
}

function setTarget(next: SurfacePose, fromDevice = false) {
  if (!enabled || frozen.value) return;
  pendingPose = next;
  pendingFromDevice = fromDevice;
  if (inputTimer !== undefined) return;
  const delay = Math.max(0, 16 - (Date.now() - lastPublish));
  if (delay === 0) flushPose();
  else inputTimer = setTimeout(flushPose, delay);
}

function pauseIdle() {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  // Active input takes over the full tilt range; return the idle layer to
  // neutral instead of leaving its frozen rotation on top of device input.
  // Closing uses freeze() separately to preserve the current native frame.
  idleRunning.value = false;
  idleEnabled.value = false;
}

function armIdle() {
  pauseIdle();
  if (!enabled || scrolling || frozen.value) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (!enabled || scrolling || frozen.value) return;
    idleEnabled.value = true;
    publishPose(pose.value);
    idleDeviceAnchor = { ...deviceTarget };
    idleRunning.value = true;
  }, SURFACE_IDLE_DELAY);
}

function notifyScroll() {
  if (!enabled || frozen.value) return;
  scrolling = true;
  pauseIdle();
  idleEnabled.value = false;
  setTarget({ x: 0, y: 0 });
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    scrollTimer = undefined;
    if (!enabled) return;
    scrolling = false;
    // Resume from the present grip, instead of snapping to an old direction.
    deviceTracker.reset(latestDevice);
    deviceTarget = { x: 0, y: 0 };
    idleDeviceAnchor = { ...deviceTarget };
    setTarget(deviceTarget);
    armIdle();
  }, SURFACE_SCROLL_DELAY);
}

function onDeviceChange(value: unknown) {
  if (!enabled || !deviceListening || !ownsSurfaceSensor(sensorToken)) return;
  let normalized = normalizeDevicePose(value, deviceAngleUnit);
  if (!normalized && deviceAngleUnit === 'radians') {
    normalized = normalizeDevicePose(value, 'degrees');
    if (normalized) {
      deviceAngleUnit = 'degrees';
      // Earlier ambiguous readings must not remain the reference orientation.
      deviceTracker.reset();
      latestDevice = null;
      deviceTarget = { x: 0, y: 0 };
      idleDeviceAnchor = { ...deviceTarget };
      console.info(`[LibraryCardSurface] 方向角输入为角度制，已转换为弧度 | session=${sensorToken}`);
    }
  }
  if (!normalized) {
    if (!invalidDeviceSampleLogged) {
      invalidDeviceSampleLogged = true;
      const raw = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      const fields = (['alpha', 'beta', 'gamma'] as const)
        .map(axis => `${axis}=${String(raw?.[axis])}(${typeof raw?.[axis]})`).join(' | ');
      console.warn(`[LibraryCardSurface] 数据被过滤：方向角无效或超出范围 | session=${sensorToken} | unit=${deviceAngleUnit} | ${fields}`, { raw: value });
    }
    return;
  }
  if (!deviceSampleLogged) {
    deviceSampleLogged = true;
    clearTimeout(deviceDataTimer);
    deviceDataTimer = undefined;
    console.info(`[LibraryCardSurface] 收到方向数据 | session=${sensorToken} | inputUnit=${deviceAngleUnit} | alpha=${normalized.alpha} | beta=${normalized.beta} | gamma=${normalized.gamma}`, {
      session: sensorToken, raw: value, radians: { ...normalized },
      scrolling, frozen: frozen.value
    });
  }
  latestDevice = normalized;
  const next = deviceTracker.update(latestDevice);
  if (!next) return;
  deviceTarget = next;
  if (scrolling || frozen.value) return;
  // Rendering a filtered target is not necessarily deliberate movement.
  // Small sensor fluctuations must neither restart the idle timer nor steer
  // the card during its native sway. Slow real motion accumulates from this
  // fixed anchor, so it still resumes direction following.
  const movement = Math.max(Math.abs(next.x - idleDeviceAnchor.x), Math.abs(next.y - idleDeviceAnchor.y));
  if (movement >= 0.8) {
    idleDeviceAnchor = { ...next };
    armIdle();
    setTarget(next, true);
  } else if (!idleRunning.value) {
    setTarget(next, true);
  }
}

function stopDevice(reason = '暂停或页面退出') {
  deviceRevision += 1;
  clearTimeout(deviceDataTimer);
  deviceDataTimer = undefined;
  if (!deviceListening) return;
  console.info('[LibraryCardSurface] 停止方向监听', { session: sensorToken, reason, receivedValidData: deviceSampleLogged });
  deviceListening = false;
  // Only remove our listener; no global listener removal.
  try { uni.offDeviceMotionChange(onDeviceChange); } catch { /* unsupported */ }
  if (releaseSurfaceSensor(sensorToken)) {
    try { uni.stopDeviceMotionListening({}); } catch { /* unsupported */ }
  }
  sensorToken = 0;
}

function logDeviceFailure(label: string, error: unknown) {
  const fields = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const message = fields?.errMsg ?? fields?.message ?? (typeof error === 'string' ? error : '未返回错误信息');
  const code = fields?.errCode ?? fields?.errno ?? fields?.code ?? '未返回';
  // Print primitive text so real-device consoles show the native error
  // without requiring expansion of a lazily inspected object.
  console.warn(`[LibraryCardSurface] ${label} | session=${sensorToken} | errMsg=${String(message)} | errCode=${String(code)}`, error);
}

function startDevice() {
  deviceTracker.reset();
  latestDevice = null;
  deviceTarget = { x: 0, y: 0 };
  idleDeviceAnchor = { ...deviceTarget };
  deviceSampleLogged = false;
  invalidDeviceSampleLogged = false;
  devicePoseLogged = false;
  const supported = {
    start: typeof uni.startDeviceMotionListening === 'function',
    onChange: typeof uni.onDeviceMotionChange === 'function',
    stop: typeof uni.stopDeviceMotionListening === 'function',
    offChange: typeof uni.offDeviceMotionChange === 'function'
  };
  console.info('[LibraryCardSurface] 准备启动方向监听', { phase: props.phase, paused: props.paused, supported });
  if (!Object.values(supported).every(Boolean)) {
    console.warn('[LibraryCardSurface] 方向监听接口不可用', supported);
    return;
  }
  const revision = ++deviceRevision;
  sensorToken = claimSurfaceSensor();
  try {
    deviceListening = true;
    uni.onDeviceMotionChange(onDeviceChange);
    console.info('[LibraryCardSurface] 开始调用 startDeviceMotionListening', { session: sensorToken, interval: 'ui' });
    deviceDataTimer = setTimeout(() => {
      deviceDataTimer = undefined;
      if (revision !== deviceRevision || !deviceListening || deviceSampleLogged) return;
      console.warn('[LibraryCardSurface] 等待有效方向数据超时（2秒）', {
        session: sensorToken, receivedInvalidData: invalidDeviceSampleLogged,
        scrolling, frozen: frozen.value
      });
    }, 2000);
    uni.startDeviceMotionListening({
      interval: 'ui',
      success: (result) => {
        if (revision === deviceRevision && deviceListening) {
          console.info('[LibraryCardSurface] 调用成功 startDeviceMotionListening', { session: sensorToken, result });
        }
        // A start can finish after the card was closed/paused.
        if (revision !== deviceRevision && !hasSurfaceSensor()) {
          try { uni.stopDeviceMotionListening({}); } catch { /* unsupported */ }
        }
      },
      fail: (error) => {
        if (revision !== deviceRevision) return;
        logDeviceFailure('调用失败 startDeviceMotionListening', error);
        stopDevice('启动失败');
        deviceTarget = { x: 0, y: 0 };
        if (!scrolling) setTarget(deviceTarget);
      }
    });
  } catch (error) {
    if (revision !== deviceRevision) return;
    logDeviceFailure('方向监听初始化异常', error);
    stopDevice('初始化异常');
  }
}

function clearTimers() {
  clearTimeout(inputTimer);
  clearTimeout(idleTimer);
  clearTimeout(scrollTimer);
  inputTimer = idleTimer = scrollTimer = undefined;
  pendingPose = null;
  pendingFromDevice = false;
}

function suspend() {
  enabled = false;
  stopDevice();
  clearTimers();
  scrolling = false;
  idleRunning.value = idleEnabled.value = false;
  showGlare.value = false;
  frozen.value = false;
  transition = { from: sampledPose(), to: { x: 0, y: 0 }, started: Date.now() };
  pose.value = { x: 0, y: 0 };
}

function freeze() {
  if (frozen.value) return;
  const current = sampledPose();
  enabled = false;
  stopDevice('收回卡片');
  clearTimers();
  scrolling = false;
  idleRunning.value = false;
  // Keep the native idle layer at its current frame throughout the retreat.
  frozen.value = true;
  pose.value = current;
}

function activate() {
  suspend();
  enabled = true;
  showGlare.value = true;
  // 陀螺仪功能已注释：不再监听设备方向，卡片不再随手机倾斜旋转。
  // startDevice();
  armIdle();
}

watch(() => [props.phase, props.paused] as const, ([phase, paused]) => {
  if (phase === 'closing') return freeze();
  if (phase === 'open' && !paused) activate();
  else suspend();
}, { immediate: true, flush: 'sync' });
onBeforeUnmount(suspend);
defineExpose<LibraryCardSurfaceHandle>({ notifyScroll, freeze, suspend });
</script>

<template>
  <view class="card-surface">
    <view class="card-surface__tilt" :style="tiltStyle">
      <view class="card-surface__idle" :class="{ 'has-idle': idleEnabled }" :style="idleStyle">
        <slot />
        <view class="card-surface__glare" :style="glareStyle">
          <view class="card-surface__glare-position" :style="glarePositionStyle">
            <view class="card-surface__glare-drift" :class="{ 'has-idle': idleEnabled }" :style="idleStyle" />
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.card-surface, .card-surface__tilt, .card-surface__idle { position: absolute; top: 0; right: 0; bottom: 0; left: 0; transform-origin: center; transform-style: preserve-3d; }
.card-surface { perspective: 600px; }
.card-surface__tilt { will-change: transform; transition-property: transform; transition-timing-function: linear; }
.card-surface__idle { transform: rotateY(0deg); transform-origin: 50% 50%; will-change: transform; transition: transform .15s ease-out; }
.card-surface__idle.has-idle { animation: surface-idle-sway 6s ease-in-out infinite; }
/* Keep shine clear of native header/footer controls even when a miniapp
   renderer does not pass hits through a transformed decorative layer. */
/* Feather the glare's top/bottom cutoffs so the shine fades out before the
   clipped edges instead of leaving dark bands where the layer is absent. */
.card-surface__glare { position: absolute; z-index: 30; top: 100rpx; right: 0; bottom: 160rpx; left: 0; border-radius: 55rpx; overflow: hidden; pointer-events: none; transition: opacity .18s linear; -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 140rpx, #000 calc(100% - 200rpx), transparent 100%); mask-image: linear-gradient(180deg, transparent 0, #000 140rpx, #000 calc(100% - 200rpx), transparent 100%); }
.card-surface__glare-position, .card-surface__glare-drift { pointer-events: none; }
.card-surface__glare-position { position: absolute; top: -50%; right: -50%; bottom: -50%; left: -50%; will-change: transform; transition-property: transform; transition-timing-function: linear; }
.card-surface__glare-drift { position: absolute; top: 0; right: 0; bottom: 0; left: 0; transform: translate3d(0,0,0); transition: transform .15s ease-out; background: radial-gradient(ellipse at center, #fff 0%, rgba(255,246,224,.65) 22%, rgba(255,255,255,0) 46%); }
.card-surface__glare-drift.has-idle { animation: surface-idle-glint 6s ease-in-out infinite; }
@keyframes surface-idle-sway {
  0%, 50%, 100% {
    transform: rotateY(0deg);
    animation-timing-function: cubic-bezier(.33,.5,.67,1);
  }
  25% {
    transform: rotateY(-3deg);
    animation-timing-function: cubic-bezier(.33,0,.67,.5);
  }
  75% {
    transform: rotateY(3deg);
    animation-timing-function: cubic-bezier(.33,0,.67,.5);
  }
}
@keyframes surface-idle-glint {
  0%, 50%, 100% { transform: translate3d(0,0,0); animation-timing-function: cubic-bezier(.33,.5,.67,1); }
  25% { transform: translate3d(-6%,0,0); animation-timing-function: cubic-bezier(.33,0,.67,.5); }
  75% { transform: translate3d(6%,0,0); animation-timing-function: cubic-bezier(.33,0,.67,.5); }
}
</style>
