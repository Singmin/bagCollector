import type { CardRect } from './library-card-motion';

export interface SurfacePose { x: number; y: number }
export interface DevicePose { alpha: number; beta: number; gamma: number }
export interface LibraryCardSurfaceHandle {
  allowTap(): boolean;
  notifyScroll(): void;
  freeze(): void;
  suspend(): void;
}

export const SURFACE_LIMIT = 8;
export const SURFACE_IDLE_DELAY = 1200;
export const SURFACE_SCROLL_DELAY = 200;
export const SURFACE_TRANSITION = 100;

// A delayed start callback from an old card must not stop a newer card's sensor.
let sensorSequence = 0;
let activeSensor = 0;
export function claimSurfaceSensor() { activeSensor = ++sensorSequence; return activeSensor; }
export function ownsSurfaceSensor(token: number) { return token !== 0 && token === activeSensor; }
export function releaseSurfaceSensor(token: number) {
  if (!ownsSurfaceSensor(token)) return false;
  activeSensor = 0;
  return true;
}
export function hasSurfaceSensor() { return activeSensor !== 0; }

export function clampSurfaceAngle(value: number, limit = SURFACE_LIMIT) {
  return Math.max(-limit, Math.min(limit, value));
}

export function validSurfaceBounds(bounds: CardRect | null): bounds is CardRect {
  return !!bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width > 0 && bounds.height > 0;
}

export function pointerSurfacePose(point: { x: number; y: number }, bounds: CardRect | null): SurfacePose | null {
  if (!validSurfaceBounds(bounds) || ![point.x, point.y].every(Number.isFinite)) return null;
  return {
    x: clampSurfaceAngle(-(2 * (point.y - bounds.top) / bounds.height - 1) * SURFACE_LIMIT),
    y: clampSurfaceAngle((2 * (point.x - bounds.left) / bounds.width - 1) * SURFACE_LIMIT)
  };
}

export function validDevicePose(value: unknown): value is DevicePose {
  if (typeof value !== 'object' || value === null) return false;
  const { alpha, beta, gamma } = value as DevicePose;
  // WeChat reports radians. Reject malformed or incorrectly scaled readings.
  return [alpha, beta, gamma].every(Number.isFinite)
    && Math.abs(alpha) <= 2 * Math.PI + 0.01
    && Math.abs(beta) <= Math.PI + 0.01 && Math.abs(gamma) <= Math.PI / 2 + 0.01;
}

interface DeviceQuaternion { x: number; y: number; z: number; w: number }

function deviceQuaternion({ alpha, beta, gamma }: DevicePose): DeviceQuaternion {
  // Intrinsic Z-X-Y rotation. Keeping all three axes avoids Euler jumps near
  // upright grips, where alpha and gamma can change together without motion.
  const ca = Math.cos(alpha / 2), sa = Math.sin(alpha / 2);
  const cb = Math.cos(beta / 2), sb = Math.sin(beta / 2);
  const cg = Math.cos(gamma / 2), sg = Math.sin(gamma / 2);
  return {
    x: ca * sb * cg - sa * cb * sg,
    y: ca * cb * sg + sa * sb * cg,
    z: sa * cb * cg + ca * sb * sg,
    w: ca * cb * cg - sa * sb * sg
  };
}

function relativeQuaternion(value: DeviceQuaternion, baseline: DeviceQuaternion): DeviceQuaternion {
  // inverse(baseline) * value expresses movement in the initial phone frame.
  const q = {
    x: baseline.w * value.x - baseline.x * value.w - baseline.y * value.z + baseline.z * value.y,
    y: baseline.w * value.y + baseline.x * value.z - baseline.y * value.w - baseline.z * value.x,
    z: baseline.w * value.z - baseline.x * value.y + baseline.y * value.x - baseline.z * value.w,
    w: baseline.w * value.w + baseline.x * value.x + baseline.y * value.y + baseline.z * value.z
  };
  // q and -q describe the same pose; choose the shorter rotation.
  return q.w < 0 ? { x: -q.x, y: -q.y, z: -q.z, w: -q.w } : q;
}

function quaternionDistance(a: DeviceQuaternion, b: DeviceQuaternion) {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
}

function quaternionSurfacePose(value: DeviceQuaternion, baseline: DeviceQuaternion): SurfacePose {
  const q = relativeQuaternion(value, baseline);
  const length = Math.hypot(q.x, q.y, q.z);
  if (length < 1e-8) return { x: 0, y: 0 };
  // Rotation vector in degrees, with the requested 0.5 input gain.
  const gain = Math.atan2(length, q.w) / length * 180 / Math.PI;
  return {
    x: clampSurfaceAngle(q.x * gain),
    // Sideways tilting an upright phone rolls around its screen normal (Z).
    // Map that roll to the card's horizontal tilt as well as a Y-axis turn.
    y: clampSurfaceAngle((q.y - q.z) * gain)
  };
}

/** Sensor processing stays local; only meaningful, smoothed targets render. */
export function createDeviceSurfaceTracker() {
  let baseline: DeviceQuaternion | null = null;
  let previous: DeviceQuaternion | null = null;
  let spike: DeviceQuaternion | null = null;
  let settlingUntil = 0;
  let lastSampleAt = 0;
  let filtered: SurfacePose = { x: 0, y: 0 };
  let published: SurfacePose = { x: 0, y: 0 };

  function reset(value: DevicePose | null = null, now = Date.now()) {
    baseline = previous = value && validDevicePose(value) ? deviceQuaternion(value) : null;
    spike = null;
    settlingUntil = baseline ? now + 250 : 0;
    lastSampleAt = now;
    filtered = { x: 0, y: 0 };
    published = { x: 0, y: 0 };
  }

  function update(value: DevicePose, now = Date.now()): SurfacePose | null {
    if (!validDevicePose(value)) return null;
    const current = deviceQuaternion(value);
    if (!baseline || !previous) {
      reset(value, now);
      return null;
    }
    // A quiet sensor can leave a gap between callbacks. Keep the calibrated
    // grip: recalibrating here would swallow the first movement after resting.
    // Lifecycle and scroll resumption explicitly reset the baseline instead.
    if (now < settlingUntil) {
      // Let the sensor warm up before fixing the current grip as its origin.
      baseline = previous = current;
      lastSampleAt = now;
      return null;
    }
    if (quaternionDistance(current, previous) > 35) {
      // Ignore an isolated discontinuity; accept a large real movement only
      // once a second reading confirms the new physical orientation.
      if (!spike || quaternionDistance(current, spike) > 8) {
        spike = current;
        return null;
      }
    }
    spike = null;
    const elapsed = Math.min(200, Math.max(0, now - lastSampleAt));
    const weight = 1 - Math.exp(-elapsed / 160);
    previous = current;
    lastSampleAt = now;
    const target = quaternionSurfacePose(current, baseline);
    filtered = {
      x: filtered.x + (target.x - filtered.x) * weight,
      y: filtered.y + (target.y - filtered.y) * weight
    };
    if (Math.max(Math.abs(filtered.x - published.x), Math.abs(filtered.y - published.y)) < 0.3) return null;
    published = { ...filtered };
    return { ...published };
  }

  return { reset, update };
}
