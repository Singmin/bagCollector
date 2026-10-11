export interface CardRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CardMotionFrame {
  phase: 'idle' | 'measuring' | 'opening' | 'open' | 'closing';
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  opacity: number;
  animation?: {
    token: number;
    duration: number;
    from: CardMotionPose;
    to: CardMotionPose;
  };
}

type CardMotionPose = Pick<CardMotionFrame, 'x' | 'y' | 'scaleX' | 'scaleY' | 'angle' | 'opacity'>;

const restFrame = (): CardMotionFrame => ({
  phase: 'idle', x: 0, y: 0, scaleX: 1, scaleY: 1, angle: 0, opacity: 0
});

function validRect(rect: CardRect | null): rect is CardRect {
  return !!rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

/** Page-owned controller: no browser APIs, storage, or per-list-item timers. */
export function createLibraryCardMotion(
  onFrame: (frame: CardMotionFrame) => void,
  onClosed: () => void
) {
  const flipped = new Set<string>();
  let frame = restFrame();
  let origin = restFrame();
  let itemId = '';
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: { from: CardMotionPose; to: CardMotionFrame; started: number; duration: number } | undefined;

  function pose(value: CardMotionPose): CardMotionPose {
    return { x: value.x, y: value.y, scaleX: value.scaleX, scaleY: value.scaleY, angle: value.angle, opacity: value.opacity };
  }

  // Only sample when interrupted. Ordinary playback runs entirely in WXSS,
  // without sending transform updates through the miniapp bridge every frame.
  function currentFrame(): CardMotionFrame {
    if (!active) return frame;
    const { from, to, started, duration } = active;
    const t = Math.min(1, Math.max(0, (Date.now() - started) / duration));
    const u = t - 1;
    const position = to.phase === 'opening' ? 1 + 1.65 * u ** 3 + 0.65 * u ** 2 : t ** 2;
    const rotation = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
    return {
      phase: to.phase,
      x: lerp(from.x, to.x, position), y: lerp(from.y, to.y, position),
      scaleX: lerp(from.scaleX, to.scaleX, position), scaleY: lerp(from.scaleY, to.scaleY, position),
      angle: lerp(from.angle, to.angle, rotation),
      opacity: lerp(from.opacity, to.opacity, to.phase === 'opening' ? Math.min(1, t * 3) : Math.min(1, t / 0.8))
    };
  }

  function publish(next: CardMotionFrame) {
    frame = next;
    onFrame({ ...next });
  }

  function cancel() {
    revision += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    active = undefined;
  }

  function reset() {
    cancel();
    itemId = '';
    publish(restFrame());
    onClosed();
  }

  function animate(target: CardMotionFrame, duration: number, complete: () => void) {
    const from = pose(currentFrame());
    cancel();
    const token = revision;
    active = { from, to: target, started: Date.now(), duration };
    publish({ ...from, phase: target.phase, animation: { token, from, to: pose(target), duration } });
    // A render callback can cancel the animation (e.g. page hide).
    if (token !== revision) return;
    timer = setTimeout(() => {
      if (token !== revision) return;
      timer = undefined;
      active = undefined;
      frame = target;
      complete();
    }, duration);
  }

  return {
    prepare(id: string): number | null {
      if (frame.phase !== 'idle') return null;
      cancel();
      itemId = id;
      publish({ ...restFrame(), phase: 'measuring' });
      return revision;
    },
    open(token: number, source: CardRect | null, destination: CardRect | null) {
      if (token !== revision || frame.phase !== 'measuring') return;
      const measured = validRect(source) && validRect(destination);
      origin = measured ? {
        ...restFrame(),
        x: source.left + source.width / 2 - destination.left - destination.width / 2,
        y: source.top + source.height / 2 - destination.top - destination.height / 2,
        scaleX: source.width / destination.width,
        scaleY: source.height / destination.height, opacity: 1
      } : { ...restFrame(), scaleX: 0.92, scaleY: 0.92 };
      const first = !flipped.has(itemId);
      const openingId = itemId;
      frame = { ...origin, phase: 'opening' };
      animate({ ...restFrame(), phase: 'opening', opacity: 1, angle: first ? 360 : 0 }, first ? 1000 : 450, () => {
        if (first) flipped.add(openingId);
        publish({ ...frame, phase: 'open' });
      });
    },
    close(immediate = false) {
      if (frame.phase === 'idle') return;
      if (immediate || frame.phase === 'measuring') return reset();
      if (frame.phase === 'closing') return;
      // Hold the current rotation even when closing mid-flip; never spin again.
      animate({ ...origin, phase: 'closing', angle: currentFrame().angle, opacity: 0 }, 300, reset);
    },
    finishClosing(token: number) {
      if (token === revision && frame.phase === 'closing') reset();
    },
    destroy() {
      reset();
      flipped.clear();
    }
  };
}
