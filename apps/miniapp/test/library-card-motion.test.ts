import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLibraryCardMotion, type CardMotionFrame } from '../src/services/library-card-motion.js';

const source = { left: 20, top: 140, width: 80, height: 120 };
const destination = { left: 30, top: 60, width: 320, height: 520 };

function setup() {
  let frame: CardMotionFrame;
  const closed = vi.fn();
  const render = vi.fn((next: CardMotionFrame) => { frame = next; });
  const motion = createLibraryCardMotion(render, closed);
  const open = (id: string) => {
    const token = motion.prepare(id);
    expect(token).not.toBeNull();
    motion.open(token!, source, destination);
  };
  return { motion, closed, render, open, get frame() { return frame!; } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('library card motion', () => {
  it('starts at the selected card bounds and finishes a full first flip', () => {
    const s = setup();
    s.open('a');
    expect(s.frame).toMatchObject({ phase: 'opening', x: -130, y: -120, scaleX: 0.25, scaleY: 120 / 520, angle: 0 });
    vi.advanceTimersByTime(500);
    expect(s.frame.animation).toMatchObject({ duration: 1000, from: { angle: 0 }, to: { angle: 360 } });
    // Prepare and start only: no frame-by-frame bridge updates during playback.
    expect(s.render).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    expect(s.frame).toMatchObject({ phase: 'open', x: 0, y: 0, scaleX: 1, scaleY: 1, angle: 360, opacity: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retreats without another flip, then only pops the same card; another card still flips', () => {
    const s = setup();
    s.open('a');
    vi.advanceTimersByTime(1000);
    s.motion.close();
    vi.advanceTimersByTime(160);
    expect(s.frame.angle).toBe(360);
    expect(s.frame.animation?.to.x).toBeLessThan(0);
    vi.advanceTimersByTime(140);
    expect(s.closed).toHaveBeenCalledTimes(1);
    s.open('a');
    vi.advanceTimersByTime(450);
    expect(s.frame).toMatchObject({ phase: 'open', angle: 0 });
    s.motion.close(true);
    s.open('b');
    vi.advanceTimersByTime(450);
    expect(s.frame.phase).toBe('opening');
    vi.advanceTimersByTime(550);
    expect(s.frame.angle).toBe(360);
  });

  it('closing mid-flip freezes the current pose and leaves the first flip available', () => {
    const s = setup();
    s.open('a');
    vi.advanceTimersByTime(320);
    s.motion.close();
    const interruptedAngle = s.frame.angle;
    expect(s.frame.phase).toBe('closing');
    expect(interruptedAngle).toBeGreaterThan(0);
    expect(interruptedAngle).toBeLessThan(90);
    expect(s.frame.animation?.to.angle).toBe(interruptedAngle);
    vi.advanceTimersByTime(160);
    expect(s.frame.angle).toBe(interruptedAngle);
    vi.advanceTimersByTime(1000);
    expect(s.frame.phase).toBe('idle');
    expect(s.closed).toHaveBeenCalledTimes(1);
    s.open('a');
    vi.advanceTimersByTime(1000);
    expect(s.frame.angle).toBe(360);
  });

  it('ignores stale measurements and duplicate opens, including after hide and reopen', () => {
    const s = setup();
    const oldToken = s.motion.prepare('a')!;
    expect(s.motion.prepare('b')).toBeNull();
    s.motion.close(true);
    const currentToken = s.motion.prepare('b')!;
    s.motion.open(oldToken, source, destination);
    expect(s.frame.phase).toBe('measuring');
    s.motion.open(currentToken, source, destination);
    s.motion.open(currentToken, null, null);
    expect(s.frame.scaleX).toBe(0.25);
    vi.advanceTimersByTime(1000);
    expect(s.frame.phase).toBe('open');
  });

  it('falls back to a centered entry for missing or invalid measurements', () => {
    const s = setup();
    s.motion.open(s.motion.prepare('a')!, { ...source, width: 0 }, destination);
    expect(s.frame).toMatchObject({ x: 0, y: 0, scaleX: 0.92, scaleY: 0.92, opacity: 0 });
    vi.advanceTimersByTime(1000);
    expect(s.frame).toMatchObject({ phase: 'open', angle: 360, opacity: 1 });
    s.motion.close(true);
    s.motion.open(s.motion.prepare('b')!, source, { ...destination, top: NaN });
    expect(s.frame.x).toBe(0);
  });

  it('hiding cancels timers but retains completed flips; destroying starts a new page session', () => {
    const s = setup();
    s.open('a');
    vi.advanceTimersByTime(1000);
    s.motion.close(true);
    expect(vi.getTimerCount()).toBe(0);
    s.open('a');
    vi.advanceTimersByTime(450);
    expect(s.frame.angle).toBe(0);
    s.motion.destroy();
    s.open('a');
    vi.advanceTimersByTime(1000);
    expect(s.frame.angle).toBe(360);
  });
});
