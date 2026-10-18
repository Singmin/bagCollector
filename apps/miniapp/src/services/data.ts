import type { ImageSide } from '../../../../packages/contracts/src/image-sides';
import type { Brand, Collectible, CollectiblePage, OfficialBag, OfficialBagMatch, OfficialBagPage, OfficialClaimResult, Shelf, ShelfTheme, MatchScan } from '../types';
import { api } from './http';
import { localizeCollectibleImages } from './images';
import { markCollectionDataStale } from './collection-state';
import { applyStrokePreference, ensureStrokePreference } from './stroke-preference';

/* 先确保白边偏好已加载，再应用偏好覆盖 URL；消除启动时「数据先到、偏好后到」的竞态。 */
async function applyPreference<T>(item: T): Promise<T> {
  await ensureStrokePreference();
  return applyStrokePreference(item);
}

async function collectible(id: string) {
  return localizeCollectibleImages(await applyPreference(await api<Collectible>(`/collectibles/${id}`)));
}

async function collectibles(query = '') {
  const page = await api<CollectiblePage>(`/collectibles${query ? `?${query}` : ''}`);
  return { ...page, items: await Promise.all(page.items.map(applyPreference)) };
}

/* 发现页「纸袋上新」官方精选（返回完整条目：背面要展示标签与备注） */
async function feed(query = '') {
  const page = await api<CollectiblePage>(`/feed${query ? `?${query}` : ''}`);
  return { ...page, items: await Promise.all(page.items.map(applyPreference)) };
}

async function changed<T>(request: Promise<T>) {
  const result = await request;
  markCollectionDataStale();
  return result;
}

async function updateCollectible(
  id: string,
  data: Partial<Pick<Collectible, 'name' | 'notes' | 'shelfId' | 'tags' | 'addedAt' | 'quantity' | 'visibility'>>
) {
  const item = await changed(api<Collectible>(`/collectibles/${id}`, { method: 'PUT', data }));
  return localizeCollectibleImages(await applyPreference(item));
}

export const dataService = {
  createMatchScan: (data: { collectibleId: string; requestId: string; source: 'camera' | 'album'; crop?: { x: number; y: number; width: number; height: number; rotation: number } }) =>
    api<{ scanId: string }>('/official-bags/match-scans', { method: 'POST', data }),
  matchScan: (id: string) => api<MatchScan>(`/official-bags/match-scans/${id}`),
  scanFeedback: (id: string, feedback: 'SELECTED' | 'CORRECTED' | 'NONE', bagId?: string) => api(`/official-bags/match-scans/${id}/feedback`, { method: 'POST', data: { feedback, bagId } }),
  shelves: () => api<Shelf[]>('/shelves'),
  collectibles,
  collectible,
  feed,
  /* 逛袋子页：官方袋子列表（支持 search / brandId / cursor / limit）与品牌分类 */
  officialBags: async (query = '') => {
    const page = await api<OfficialBagPage>(`/official-bags${query ? `?${query}` : ''}`);
    return { ...page, items: await Promise.all(page.items.map(applyPreference)) };
  },
  officialBag: async (id: string) => applyPreference(await api<OfficialBag>(`/official-bags/${id}`)),
  officialBagBrands: () => api<Brand[]>('/official-bags/brands'),
  wishlist: async () => Promise.all((await api<Collectible[]>(`/wishlist`)).map(applyPreference)),
  addWishlist: (id: string) => api(`/wishlist/${id}`, { method: 'POST' }).then(() => markCollectionDataStale()),
  removeWishlist: (id: string) => api(`/wishlist/${id}`, { method: 'DELETE' }).then(() => markCollectionDataStale()),
  createCollectible: (data: { name: string; shelfId: string; thumbnailUrl?: string; displayImageUrl?: string; notes?: string; tags?: string[] }) =>
    changed(api<Collectible>('/collectibles', { method: 'POST', data })),
  /* 标记已有（拥有官方袋子）：必须走官方认领接口 —— 它会创建收藏并引用官方图片。
     走 POST /collectibles 只会得到一条没有图片、且永远停在 UPLOADING 的记录（收藏列表不返回它）。
     overrides = 标记半窗里用户改过的名称 / 品牌展架 / 标签 / 备注，不传则用袋子自带内容。 */
  claimOfficialBag: (
    id: string,
    overrides: { name?: string; shelfId?: string; notes?: string; tags?: string[] } = {},
    /* 扫描匹配再次认领已拥有袋子时传 true：叠加数量而不是报 409 */
    increment = false
  ) =>
    changed(api<OfficialClaimResult>(`/official-bags/${id}/claim`, {
      method: 'POST',
      data: { ...overrides, ...(increment ? { increment } : {}) }
    })),
  /* 拍照扫描袋子：拿刚上传的那条收藏去比对官方库，返回 命中 / 候选 / 未命中 三档。
     刻意不标数据陈旧 —— 匹配本身不写任何东西，命中的写操作由随后的 claim 负责。 */
  matchOfficialBag: (collectibleId: string) =>
    api<OfficialBagMatch>('/official-bags/match', { method: 'POST', data: { collectibleId } }),
  updateCollectible,
  removeCollectible: (id: string) => changed(api(`/collectibles/${id}`, { method: 'DELETE' })),
  /* 只裁剪（裁剪页提交）：后端重出展示图/缩略图，不做抠图 */
  crop: (
    id: string,
    data: { x: number; y: number; width: number; height: number; rotation: number; brightness?: number; contrast?: number; saturation?: number; side?: ImageSide; sourceVersion?: number }
  ) => changed(api<{ jobId: string; version: number }>(`/collectibles/${id}/crop`, { method: 'POST', data })),
  /* 只抠图（编辑页「自动抠图」按钮）：参数可全省 —— 后端沿用已保存的裁剪参数，没有则按全幅 */
  matte: (id: string, data: Partial<{ x: number; y: number; width: number; height: number; rotation: number; brightness?: number; contrast?: number; saturation?: number; side?: ImageSide; sourceVersion?: number }> = {}) =>
    changed(api<{ jobId: string; version: number }>(`/collectibles/${id}/matte`, { method: 'POST', data })),
  removeImage: (id: string, side: ImageSide) => changed(api<Collectible>(`/collectibles/${id}/images/${side}`, { method: 'DELETE' })),
  createShelf: (data: { name: string; theme: ShelfTheme }) =>
    changed(api<Shelf>('/shelves', { method: 'POST', data })),
  updateShelf: (id: string, data: { name?: string; theme?: ShelfTheme }) =>
    changed(api<Shelf>(`/shelves/${id}`, { method: 'PUT', data })),
  removeShelf: (id: string) => changed(api(`/shelves/${id}`, { method: 'DELETE' })),
  reorderShelves: (ids: string[]) =>
    changed(api<Shelf[]>('/shelves/reorder', { method: 'POST', data: { ids } }))
};
