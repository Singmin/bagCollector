import { onScopeDispose, type ComponentPublicInstance } from 'vue';
import type { CollectibleSummary } from '../types';
import type { CardRect } from './library-card-motion';
import { validSurfaceBounds } from './library-card-surface';

export type LibraryLayout = 'shelf' | 'grid' | 'wish';
export interface LibraryDisplayItem {
  item: CollectibleSummary;
  imageUrl: string;
  imageWidth: number;
}
export interface LibraryCardOpen {
  item: CollectibleSummary;
  layout: LibraryLayout;
  imageUrl: string;
  sourceRect: CardRect | null;
}

export function cardNodeId(layout: LibraryLayout, id: string) {
  return `library-card-${layout}-${Array.from(id).map((char) => char.codePointAt(0)!.toString(16)).join('-')}`;
}

interface TouchPoint { clientX?: number; clientY?: number; x?: number; y?: number }
function touches(event: Event) {
  return (event as unknown as { touches?: TouchPoint[] }).touches ?? [];
}

/** Shared gesture guard; positions are measured inside the owning component. */
export function useLibraryCardEvents(
  instance: ComponentPublicInstance | null | undefined,
  layout: () => LibraryLayout,
  emitOpen: (request: LibraryCardOpen) => void,
  emitLongPress: (item: CollectibleSummary) => void
) {
  let blocked = false;
  let suppressedUntil = 0;
  let origin: { x: number; y: number } | null = null;
  let measuring = false;
  let measureToken = 0;
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sourceTimer: ReturnType<typeof setTimeout> | undefined;
  let sourceMeasurement: {
    itemId: string;
    layout: LibraryLayout;
    ready: boolean;
    rect: CardRect | null;
    onReady?: (rect: CardRect | null) => void;
  } | null = null;

  function measureSource(entry: LibraryDisplayItem) {
    clearTimeout(sourceTimer);
    const measurement = {
      itemId: entry.item.id, layout: layout(), ready: false, rect: null as CardRect | null,
      onReady: undefined as ((rect: CardRect | null) => void) | undefined
    };
    sourceMeasurement = measurement;
    const complete = (rect: CardRect | null) => {
      if (!alive || sourceMeasurement !== measurement || measurement.ready) return;
      clearTimeout(sourceTimer);
      measurement.ready = true;
      measurement.rect = rect;
      measurement.onReady?.(rect);
    };
    sourceTimer = setTimeout(() => complete(null), 200);
    try {
      uni.createSelectorQuery().in(instance).select(`#${cardNodeId(measurement.layout, entry.item.id)}`)
        .boundingClientRect().exec(rows => {
          const rect = rows?.[0] as CardRect | null;
          complete(validSurfaceBounds(rect) ? rect : null);
        });
    } catch { complete(null); }
    return measurement;
  }

  function blockGesture() { blocked = true; }
  function touchStart(event: Event, entry?: LibraryDisplayItem) {
    if (measuring) { measuring = false; measureToken += 1; clearTimeout(timer); }
    const points = touches(event);
    blocked = points.length > 1;
    const point = points[0];
    origin = point ? { x: point.clientX ?? point.x ?? 0, y: point.clientY ?? point.y ?? 0 } : null;
    // Start while the finger is down, so the eventual tap need not wait for layout.
    sourceMeasurement = null;
    clearTimeout(sourceTimer);
    if (!blocked && entry) measureSource(entry);
  }
  function touchMove(event: Event) {
    const points = touches(event);
    const point = points[0];
    if (points.length > 1 || (point && origin && Math.hypot(
      (point.clientX ?? point.x ?? 0) - origin.x,
      (point.clientY ?? point.y ?? 0) - origin.y
    ) > 8)) blocked = true;
  }
  function touchEnd() {
    if (blocked) suppressedUntil = Date.now() + 350;
    origin = null;
  }
  function touchCancel() { blockGesture(); touchEnd(); }
  function longPress(item: CollectibleSummary) {
    if (blocked || Date.now() < suppressedUntil) return;
    blockGesture();
    touchEnd();
    emitLongPress(item);
  }
  function open(entry: LibraryDisplayItem) {
    if (!alive || blocked || measuring || Date.now() < suppressedUntil) return;
    measuring = true;
    const token = ++measureToken;
    const sourceLayout = layout();
    const finish = (sourceRect: CardRect | null) => {
      if (!alive || !measuring || token !== measureToken) return;
      measuring = false;
      clearTimeout(timer);
      if (!blocked) emitOpen({ item: entry.item, layout: sourceLayout, imageUrl: entry.imageUrl, sourceRect });
    };
    const measured = sourceMeasurement?.itemId === entry.item.id && sourceMeasurement.layout === sourceLayout
      ? sourceMeasurement : measureSource(entry);
    if (measured.ready) finish(measured.rect);
    else {
      measured.onReady = finish;
      timer = setTimeout(() => finish(null), 200);
    }
  }
  onScopeDispose(() => {
    alive = false; measuring = false; measureToken += 1;
    clearTimeout(timer); clearTimeout(sourceTimer); sourceMeasurement = null;
  });
  return { open, longPress, touchStart, touchMove, touchEnd, touchCancel, blockGesture };
}
