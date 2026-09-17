import type { Collectible, CollectiblePage, Shelf, ShelfTheme } from '../types';
import { api } from './http';
import { localizeCollectibleImages } from './images';

async function collectible(id: string) {
  return localizeCollectibleImages(await api<Collectible>(`/collectibles/${id}`));
}

async function collectibles(query = '') {
  const page = await api<CollectiblePage>(`/collectibles${query ? `?${query}` : ''}`);
  return { ...page, items: await Promise.all(page.items.map(localizeCollectibleImages)) };
}

export const dataService = {
  shelves: () => api<Shelf[]>('/shelves'),
  collectibles,
  collectible,
  createCollectible: (data: { name?: string; shelfId?: string } = {}) => api<Collectible>('/collectibles', { method: 'POST', data }),
  updateCollectible: (id: string, data: Partial<Pick<Collectible, 'name' | 'notes' | 'shelfId' | 'tags'>>) =>
    api<Collectible>(`/collectibles/${id}`, { method: 'PUT', data }).then(localizeCollectibleImages),
  removeCollectible: (id: string) => api(`/collectibles/${id}`, { method: 'DELETE' }),
  crop: (id: string, data: { x: number; y: number; width: number; height: number; rotation: 0 | 90 | 180 | 270 }) =>
    api<{ jobId: string }>(`/collectibles/${id}/crop`, { method: 'POST', data }),
  retry: (id: string) => api<{ jobId: string }>(`/collectibles/${id}/retry`, { method: 'POST' }),
  keepCrop: (id: string) => api<Collectible>(`/collectibles/${id}/keep-crop`, { method: 'POST' }).then(localizeCollectibleImages),
  createShelf: (data: { name: string; theme: ShelfTheme }) => api<Shelf>('/shelves', { method: 'POST', data }),
  updateShelf: (id: string, data: { name?: string; theme?: ShelfTheme }) => api<Shelf>(`/shelves/${id}`, { method: 'PUT', data }),
  removeShelf: (id: string) => api(`/shelves/${id}`, { method: 'DELETE' }),
  reorderShelves: (ids: string[]) => api<Shelf[]>('/shelves/reorder', { method: 'POST', data: { ids } })
};
