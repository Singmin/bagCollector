<script lang="ts">
// Keep the 3D chain continuous across the native custom-component boundary.
export default { options: { virtualHost: true } };
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { CardMotionFrame, CardRect } from '../services/library-card-motion';
import {
  clampSurfaceAngle, createDeviceSurfaceTracker, pointerSurfacePose, validDevicePose,
  claimSurfaceSensor, ownsSurfaceSensor, releaseSurfaceSensor, hasSurfaceSensor,
  SURFACE_IDLE_DELAY, SURFACE_SCROLL_DELAY, SURFACE_TRANSITION,
  type DevicePose, type SurfacePose, type LibraryCardSurfaceHandle
} from '../services/library-card-surface';

const props = defineProps<{
  phase: CardMotionFrame['phase'];
  paused: boolean;
  bounds: CardRect | null;
}>();

interface TouchPoint { clientX?: number; clientY?: number; x?: number; y?: number }
interface SurfaceTouchEvent {
  touches?: TouchPoint[];
  target?: { dataset?: { surfaceControl?: boolean | string } };
}

const pose = ref<SurfacePose>({ x: 0, y: 0 });
const idleEnabled = ref(false);
const idleRunning = ref(false);
const frozen = ref(false);
const showGlare = ref(false);
let enabled = false;
let touching = false;
let verticalGesture = false;
let multiGesture = false;
let scrolling = false;
let gestureBlocked = false;
let blockedUntil = 0;
let touchOrigin: { x: number; y: number } | null = null;
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
  if (!enabled || touching || scrolling || frozen.value) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (!enabled || touching || scrolling || frozen.value) return;
    idleEnabled.value = true;
    publishPose(pose.value);
    idleDeviceAnchor = { ...deviceTarget };
    idleRunning.value = true;
  }, SURFACE_IDLE_DELAY);
}

function blockGesture() {
  gestureBlocked = true;
  blockedUntil = Date.now() + 500;
}

function touchPoint(event: Event) {
  const touch = (event as unknown as SurfaceTouchEvent).touches?.[0];
  if (!touch) return null;
  const point = { x: touch.clientX ?? touch.x ?? NaN, y: touch.clientY ?? touch.y ?? NaN };
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

function notifyScroll() {
  if (!enabled || frozen.value) return;
  scrolling = true;
  blockGesture();
  pauseIdle();
  idleEnabled.value = false;
  setTarget({ x: 0, y: 0 });
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    scrollTimer = undefined;
    if (!enabled || (touching && verticalGesture)) return;
    scrolling = false;
    // Resume from the present grip, instead of snapping to an old direction.
    deviceTracker.reset(latestDevice);
    deviceTarget = { x: 0, y: 0 };
    idleDeviceAnchor = { ...deviceTarget };
    setTarget(deviceTarget);
    armIdle();
  }, SURFACE_SCROLL_DELAY);
}

function onTouchStart(event: Event) {
  const e = event as unknown as SurfaceTouchEvent;
  if (!enabled || frozen.value) return;
  // Let native controls generate their own tap; excluding them from tilt
  // must not require catchtouchstart/catchtouchend on their parent view.
  if (e.target?.dataset?.surfaceControl === true || e.target?.dataset?.surfaceControl === 'true') return;
  pauseIdle();
  touchOrigin = touchPoint(event);
  verticalGesture = false;
  multiGesture = false;
  gestureBlocked = false;
  blockedUntil = 0;
  touching = true;
  if (e.touches?.length !== 1) {
    multiGesture = true;
    blockGesture();
    setTarget({ x: 0, y: 0 });
    return;
  }
  if (scrolling || !touchOrigin) return;
  const next = pointerSurfacePose(touchOrigin, props.bounds);
  if (next) setTarget(next);
}

function onTouchMove(event: Event) {
  const e = event as unknown as SurfaceTouchEvent;
  if (!enabled || frozen.value || !touching) return;
  if (multiGesture || e.touches?.length !== 1) {
    multiGesture = true;
    blockGesture();
    setTarget({ x: 0, y: 0 });
    return;
  }
  const point = touchPoint(event);
  if (!point || !touchOrigin) return;
  const dx = point.x - touchOrigin.x;
  const dy = point.y - touchOrigin.y;
  if (Math.hypot(dx, dy) > 8) {
    blockGesture();
    if (Math.abs(dy) > Math.abs(dx)) verticalGesture = true;
  }
  if (verticalGesture) return notifyScroll();
  if (scrolling) return;
  const next = pointerSurfacePose(point, props.bounds);
  if (next) setTarget(next);
}

function onTouchEnd(event: Event) {
  const e = event as unknown as SurfaceTouchEvent;
  if (!enabled || frozen.value || !touching) return;
  if (e.touches?.length) {
    blockGesture();
    return;
  }
  touching = false;
  touchOrigin = null;
  if (gestureBlocked) blockedUntil = Date.now() + 500;
  if (verticalGesture || scrolling) notifyScroll();
  else {
    setTarget(deviceTarget);
    armIdle();
  }
}

function onTouchCancel() {
  if (!enabled || frozen.value) return;
  blockGesture();
  touching = false;
  touchOrigin = null;
  verticalGesture = false;
  notifyScroll();
}

function onDeviceChange(value: unknown) {
  if (!enabled || !deviceListening || !ownsSurfaceSensor(sensorToken)) return;
  if (!validDevicePose(value)) {
    if (!invalidDeviceSampleLogged) {
      invalidDeviceSampleLogged = true;
      console.warn('[LibraryCardSurface] 数据被过滤：方向角无效或超出弧度范围', { session: sensorToken, raw: value });
    }
    return;
  }
  if (!deviceSampleLogged) {
    deviceSampleLogged = true;
    clearTimeout(deviceDataTimer);
    deviceDataTimer = undefined;
    console.info('[LibraryCardSurface] 收到方向数据', {
      session: sensorToken, raw: { alpha: value.alpha, beta: value.beta, gamma: value.gamma },
      touching, scrolling, frozen: frozen.value
    });
  }
  latestDevice = { alpha: value.alpha, beta: value.beta, gamma: value.gamma };
  const next = deviceTracker.update(latestDevice);
  if (!next) return;
  deviceTarget = next;
  if (touching || scrolling || frozen.value) return;
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
        touching, scrolling, frozen: frozen.value
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
        if (!touching && !scrolling) setTarget(deviceTarget);
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
  touching = scrolling = verticalGesture = multiGesture = false;
  touchOrigin = null;
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
  touching = scrolling = false;
  idleRunning.value = false;
  // Keep the native idle layer at its current frame throughout the retreat.
  frozen.value = true;
  pose.value = current;
}

function activate() {
  suspend();
  enabled = true;
  gestureBlocked = false;
  blockedUntil = 0;
  showGlare.value = true;
  startDevice();
  armIdle();
}

watch(() => [props.phase, props.paused] as const, ([phase, paused]) => {
  if (phase === 'closing') return freeze();
  if (phase === 'open' && !paused) activate();
  else suspend();
}, { immediate: true, flush: 'sync' });
onBeforeUnmount(suspend);
defineExpose<LibraryCardSurfaceHandle>({
  allowTap: () => !gestureBlocked && Date.now() >= blockedUntil,
  notifyScroll, freeze, suspend
});
</script>

<template>
  <view class="card-surface" @touchstart="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd" @touchcancel="onTouchCancel">
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
.card-surface__glare { position: absolute; z-index: 30; top: 100rpx; right: 0; bottom: 160rpx; left: 0; border-radius: 55rpx; overflow: hidden; pointer-events: none; transition: opacity .18s linear; }
.card-surface__glare-position, .card-surface__glare-drift { pointer-events: none; }
.card-surface__glare-position { position: absolute; top: -50%; right: -50%; bottom: -50%; left: -50%; will-change: transform; transition-property: transform; transition-timing-function: linear; }
.card-surface__glare-drift { position: absolute; top: 0; right: 0; bottom: 0; left: 0; transform: translate3d(0,0,0); transition: transform .15s ease-out; background: radial-gradient(ellipse at center, #fff 0%, rgba(255,246,224,.65) 25%, rgba(255,255,255,0) 60%); }
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
