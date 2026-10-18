import { api } from './http';

/* 白边偏好：存服务端（User.whiteStrokeEnabled），换设备一致。
   这里做「内存缓存 + 偏好版本号」：展示层按偏好选 URL，切换后版本号 +1，
   让各处图片缓存 key 失效、重新按新偏好取图。 */

let enabled: boolean | null = null;
let revision = 0;
let loadPromise: Promise<boolean> | null = null;

/** 当前是否展示白边（默认 false，未加载/加载失败时保持无白边，与后端默认一致）。 */
export function whiteStrokeEnabled(): boolean {
  return enabled ?? false;
}

/** 确保偏好已加载（幂等，带记忆）：数据层在应用偏好前先 await 它，
   避免「页面数据先到、偏好后到」导致首屏仍按默认有白边展示的竞态。 */
export function ensureStrokePreference(): Promise<boolean> {
  if (enabled !== null) return Promise.resolve(enabled);
  loadPromise ??= loadStrokePreference().finally(() => { loadPromise = null; });
  return loadPromise;
}

/** 偏好版本号：切换白边偏好时 +1，纳入图片缓存 key 以强制失效。 */
export function strokeRevision(): number {
  return revision;
}

/** 从 /account 拉取最新偏好（启动时 / 设置页打开时调用）。 */
export async function loadStrokePreference(): Promise<boolean> {
  try {
    const account = await api<{ whiteStrokeEnabled?: boolean }>('/account');
    if (typeof account.whiteStrokeEnabled === 'boolean') {
      enabled = account.whiteStrokeEnabled;
    }
  } catch {
    /* 保持默认（有白边） */
  }
  return whiteStrokeEnabled();
}

/** 更新服务端偏好并刷新内存态；成功后偏好版本号 +1。 */
export async function saveStrokePreference(value: boolean): Promise<boolean> {
  const result = await api<{ whiteStrokeEnabled: boolean }>('/account', {
    method: 'PUT',
    data: { whiteStrokeEnabled: value }
  });
  enabled = result.whiteStrokeEnabled;
  revision += 1;
  return enabled;
}

/** 关闭白边时优先返回 plain 版，否则回退主字段。 */
export function pickUrl(main?: string, plain?: string): string | undefined {
  if (!whiteStrokeEnabled() && plain) return plain;
  return main;
}

/** 按当前偏好，把条目里的图片 URL 就地规范化：关闭白边时用 plain 覆盖主字段，
   让下游所有展示逻辑（读 thumbnailUrl / displayImageUrl）无需改动即可正确选图。 */
export function applyStrokePreference<T>(item: T): T {
  if (whiteStrokeEnabled()) return item;
  const src = item as {
    thumbnailUrl?: string; thumbnailUrlPlain?: string;
    displayImageUrl?: string; displayImageUrlPlain?: string;
    backThumbnailUrl?: string; backThumbnailUrlPlain?: string;
    sides?: Record<string, unknown>;
  };
  const next: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  if (src.thumbnailUrlPlain) next.thumbnailUrl = src.thumbnailUrlPlain;
  if (src.displayImageUrlPlain) next.displayImageUrl = src.displayImageUrlPlain;
  if (src.backThumbnailUrlPlain) next.backThumbnailUrl = src.backThumbnailUrlPlain;
  if (src.sides) {
    const sides: Record<string, unknown> = {};
    for (const [side, dto] of Object.entries(src.sides)) {
      if (!dto || typeof dto !== 'object') { sides[side] = dto; continue; }
      const s = dto as { thumbnailUrl?: string; thumbnailUrlPlain?: string; displayImageUrl?: string; displayImageUrlPlain?: string };
      sides[side] = {
        ...s,
        ...(s.thumbnailUrlPlain ? { thumbnailUrl: s.thumbnailUrlPlain } : {}),
        ...(s.displayImageUrlPlain ? { displayImageUrl: s.displayImageUrlPlain } : {})
      };
    }
    next.sides = sides;
  }
  return next as T;
}
