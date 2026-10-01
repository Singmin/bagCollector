import type { Collectible, CollectiblePage, Shelf, ShelfTheme } from '../types';
import { api } from './http';
import { localizeCollectibleImages } from './images';
import { markCollectionDataStale } from './collection-state';

async function collectible(id: string) {
  return localizeCollectibleImages(await api<Collectible>(`/collectibles/${id}`));
}

async function collectibles(query = '') {
  return api<CollectiblePage>(`/collectibles${query ? `?${query}` : ''}`);
}

/* 发现页「纸袋上新」官方精选（返回完整条目：背面要展示标签与备注） */
async function feed(query = '') {
  return api<CollectiblePage>(`/feed${query ? `?${query}` : ''}`);
}

async function changed<T>(request: Promise<T>) {
  const result = await request;
  markCollectionDataStale();
  return result;
}

async function updateCollectible(
  id: string,
  data: Partial<Pick<Collectible, 'name' | 'notes' | 'shelfId' | 'tags' | 'addedAt'>>
) {
  const item = await changed(api<Collectible>(`/collectibles/${id}`, { method: 'PUT', data }));
  return localizeCollectibleImages(item);
}

export const dataService = {
  shelves: () => api<Shelf[]>('/shelves'),
  collectibles,
  collectible,
  feed,
  wishlist: () => api<Collectible[]>(`/wishlist`),
  addWishlist: (id: string) => api(`/wishlist/${id}`, { method: 'POST' }).then(() => markCollectionDataStale()),
  removeWishlist: (id: string) => api(`/wishlist/${id}`, { method: 'DELETE' }).then(() => markCollectionDataStale()),
  createCollectible: (data: { name: string; shelfId: string; thumbnailUrl?: string; displayImageUrl?: string; notes?: string; tags?: string[] }) =>
    changed(api<Collectible>('/collectibles', { method: 'POST', data })),
  updateCollectible,
  removeCollectible: (id: string) => changed(api(`/collectibles/${id}`, { method: 'DELETE' })),
  /* 只裁剪（裁剪页提交）：后端重出展示图/缩略图，不做抠图 */
  crop: (
    id: string,
    data: { x: number; y: number; width: number; height: number; rotation: number; brightness?: number; contrast?: number; saturation?: number }
  ) => changed(api<{ jobId: string }>(`/collectibles/${id}/crop`, { method: 'POST', data })),
  /* 只抠图（编辑页「自动抠图」按钮）：参数可全省 —— 后端沿用已保存的裁剪参数，没有则按全幅 */
  matte: (id: string, data: Partial<{ x: number; y: number; width: number; height: number; rotation: number; brightness?: number; contrast?: number; saturation?: number }> = {}) =>
    changed(api<{ jobId: string }>(`/collectibles/${id}/matte`, { method: 'POST', data })),
  createShelf: (data: { name: string; theme: ShelfTheme }) =>
    changed(api<Shelf>('/shelves', { method: 'POST', data })),
  updateShelf: (id: string, data: { name?: string; theme?: ShelfTheme }) =>
    changed(api<Shelf>(`/shelves/${id}`, { method: 'PUT', data })),
  removeShelf: (id: string) => changed(api(`/shelves/${id}`, { method: 'DELETE' })),
  reorderShelves: (ids: string[]) =>
    changed(api<Shelf[]>('/shelves/reorder', { method: 'POST', data: { ids } }))
};
