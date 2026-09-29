import type { AuthTokens, Collectible, CollectiblePage, CollectibleSummary, Shelf, ShelfTheme } from '../types';
import type { ApiRequestOptions } from './http';

/* ── 本地 Mock 开关（仅用于无后端时预览 UI）──
   构建时注入 VITE_USE_MOCK=1 才生效，正式构建完全不受影响。
   数据只存在内存里，模拟器里刷新即重置。 */
export const USE_MOCK = String(import.meta.env.VITE_USE_MOCK ?? '').trim() === '1';

/* 模拟藏品用真实袋子抠图（用户提供，static/figma/bags/）：
   bag-01/02/03 = luckin 三款、bag-04/05 = CHAGEE 两款、bag-06 = luckin×MINISO */
const BAG_IMAGES = [
  '/static/figma/bags/bag-01.png',
  '/static/figma/bags/bag-02.png',
  '/static/figma/bags/bag-03.png',
  '/static/figma/bags/bag-04.png',
  '/static/figma/bags/bag-05.png',
  '/static/figma/bags/bag-06.png'
];

interface MockCollectible extends Collectible {
  addedAtMs: number;
}

let shelfSeq = 0;
let collectibleSeq = 0;

function nextId(prefix: string) {
  return `${prefix}-mock-${String(prefix === 'shelf' ? ++shelfSeq : ++collectibleSeq).padStart(3, '0')}`;
}

const shelves: Shelf[] = [
  { id: 'shelf-mock-001', name: '霸王茶姬', theme: 'SAGE', sortOrder: 1, itemCount: 0 },
  { id: 'shelf-mock-002', name: '瑞幸咖啡', theme: 'ROSE', sortOrder: 2, itemCount: 0 },
  { id: 'shelf-mock-003', name: '喜茶', theme: 'AMBER', sortOrder: 3, itemCount: 0 },
  { id: 'shelf-mock-004', name: '无印良品', theme: 'GRAPHITE', sortOrder: 4, itemCount: 0 }
];

const collectibles: MockCollectible[] = [];
let collectibleAddedAt = 0;

function seedCollectible(shelfIndex: number, name: string, tags: string[], notes: string, daysAgo: number, imageIndex: number) {
  const shelf = shelves[shelfIndex % shelves.length];
  const now = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  const image = BAG_IMAGES[imageIndex % BAG_IMAGES.length];
  collectibles.push({
    id: nextId('collectible'),
    name,
    shelfId: shelf.id,
    shelfName: shelf.name,
    processingStatus: 'READY',
    thumbnailUrl: image,
    displayImageUrl: image,
    addedAt: new Date(now - collectibleAddedAt).toISOString(),
    updatedAt: new Date(now - collectibleAddedAt).toISOString(),
    notes,
    tags,
    addedAtMs: now - collectibleAddedAt
  });
  collectibleAddedAt += 60 * 60 * 1000;
  shelf.itemCount += 1;
}

/* 图片按品牌对号：bag-04/05 = CHAGEE（霸王茶姬）、bag-01/02/03/06 = luckin（瑞幸），
   喜茶/无印良品暂无对应实拍，从池子里就近取用 */
seedCollectible(0, '伯牙绝弦', ['奶茶', '国风', '常喝'], '大杯少糖去冰，袋子上是山水烫金纹。', 1, 3);
seedCollectible(0, '醒时春山', ['奶茶', '春季限定'], '杯套是浅绿色的，袋子封口贴纸完好。', 3, 4);
seedCollectible(1, '生椰拿铁', ['咖啡', '常喝'], '袋子小，只装了一杯的量。', 2, 0);
seedCollectible(1, '橙C美式', ['咖啡', '果咖'], '', 5, 1);
seedCollectible(2, '多肉葡萄', ['果茶', '夏日'], '袋子提手是圆绳，颜色很夏天。', 4, 2);
seedCollectible(2, '烤黑糖波波', ['奶茶'], '底部有糖浆渍，拍完照就洗干净了。', 8, 5);
seedCollectible(3, '香薰机包装', ['家居', '礼盒'], '袋子厚实，内衬是米白色的。', 12, 3);
seedCollectible(3, '文具周边袋', ['文具'], '印着经典 logo，纸感偏硬挺。', 20, 0);
seedCollectible(0, '万里木兰', ['奶茶', '轻乳茶'], '第二次回购，袋子比上一版换成了哑光。', 30, 4);
seedCollectible(2, '芝芝莓莓', ['果茶'], '袋子有轻微折痕，整体完整。', 45, 2);

function summary(item: MockCollectible): CollectibleSummary {
  const { addedAtMs: _addedAtMs, notes: _notes, tags: _tags, displayImageUrl: _display, standardImageUrl: _standard, ...rest } = item;
  return rest;
}

function sortDesc(list: MockCollectible[]) {
  return [...list].sort((a, b) => b.addedAtMs - a.addedAtMs);
}

function publicCollectible(item: MockCollectible): Collectible {
  const { addedAtMs: _addedAtMs, ...rest } = item;
  return rest;
}

/* 小程序运行时没有 URLSearchParams，手写一个最小查询串解析 */
function parseQuery(query: string) {
  const text = query.startsWith('?') ? query.slice(1) : query;
  const params = new Map<string, string>();
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    if (at < 0) params.set(decodeURIComponent(pair), '');
    else params.set(decodeURIComponent(pair.slice(0, at)), decodeURIComponent(pair.slice(at + 1)));
  }
  return {
    limit: Math.min(100, Number(params.get('limit') ?? 30) || 30),
    search: (params.get('search') ?? '').trim().toLowerCase(),
    cursor: params.get('cursor')
  };
}

function matchSearch(item: MockCollectible, search: string) {
  if (!search) return true;
  return item.name.toLowerCase().includes(search)
    || item.shelfName.toLowerCase().includes(search)
    || item.tags.some((tag) => tag.toLowerCase().includes(search));
}

function jsonResponse<T>(data: T): Promise<any> {
  return Promise.resolve(data);
}

function touchShelvesSortOrder() {
  shelves.forEach((shelf, index) => { shelf.sortOrder = index + 1; });
}

/* 按请求路径与方法分发到内存数据，接口形状与真实后端保持一致 */
export function mockRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const [rawPath, rawQuery = ''] = path.split('?');
  const body = (options.data ?? {}) as Record<string, unknown>;

  if (rawPath === '/auth/wechat/login' || rawPath === '/auth/refresh') {
    const now = Date.now();
    return jsonResponse<AuthTokens>({
      accessToken: `mock-access-${now}`,
      accessTokenExpiresIn: 3600,
      refreshToken: `mock-refresh-${now}`,
      refreshTokenExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString()
    });
  }
  if (rawPath === '/auth/logout' || rawPath === '/account' && method === 'DELETE') return jsonResponse({});

  if (rawPath === '/account') {
    return jsonResponse({
      collectibleCount: collectibles.length,
      shelfCount: shelves.length,
      storageUsedBytes: collectibles.length * 1024 * 512,
      storageQuotaBytes: 5 * 1024 * 1024 * 1024
    });
  }

  if (rawPath === '/shelves/reorder' && method === 'POST') {
    const ids = (body.ids as string[]) ?? [];
    ids.forEach((id, index) => {
      const shelf = shelves.find((current) => current.id === id);
      if (shelf) shelf.sortOrder = index + 1;
    });
    shelves.sort((a, b) => a.sortOrder - b.sortOrder);
    return jsonResponse<Shelf[]>([...shelves]);
  }

  if (rawPath === '/shelves') {
    if (method === 'POST') {
      const name = String(body.name ?? '').trim() || '新展示架';
      const shelf: Shelf = { id: nextId('shelf'), name, theme: (body.theme as ShelfTheme) ?? 'SAGE', sortOrder: shelves.length + 1, itemCount: 0 };
      shelves.push(shelf);
      return jsonResponse<Shelf>(shelf);
    }
    return jsonResponse<Shelf[]>([...shelves].sort((a, b) => a.sortOrder - b.sortOrder));
  }

  const shelfMatch = rawPath.match(/^\/shelves\/([^/]+)$/);
  if (shelfMatch) {
    const shelf = shelves.find((current) => current.id === shelfMatch[1]);
    if (!shelf) return Promise.reject(new Error('展示架不存在'));
    if (method === 'PUT') {
      if (body.name !== undefined) shelf.name = String(body.name);
      if (body.theme !== undefined) shelf.theme = body.theme as ShelfTheme;
      return jsonResponse<Shelf>(shelf);
    }
    if (method === 'DELETE') {
      const index = shelves.indexOf(shelf);
      shelves.splice(index, 1);
      collectibles.filter((item) => item.shelfId === shelf.id).forEach((item) => { item.shelfId = ''; item.shelfName = ''; });
      touchShelvesSortOrder();
      return jsonResponse({});
    }
  }

  if (rawPath === '/collectibles') {
    if (method === 'POST') {
      const shelf = shelves.find((current) => current.id === body.shelfId) ?? shelves[0];
      const now = Date.now();
      const item: MockCollectible = {
        id: nextId('collectible'),
        name: String(body.name ?? '未命名藏品'),
        shelfId: shelf?.id ?? '',
        shelfName: shelf?.name ?? '',
        processingStatus: 'READY',
        addedAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        notes: '',
        tags: [],
        addedAtMs: now
      };
      collectibles.push(item);
      if (shelf) shelf.itemCount += 1;
      return jsonResponse<Collectible>(publicCollectible(item));
    }
    const { limit, search, cursor } = parseQuery(rawQuery);
    const filtered = sortDesc(collectibles.filter((item) => item.shelfId && matchSearch(item, search)));
    const start = cursor ? Math.max(0, Number(cursor) || 0) : 0;
    const pageItems = filtered.slice(start, start + limit).map(summary);
    const next = start + limit < filtered.length ? String(start + limit) : null;
    return jsonResponse<CollectiblePage>({ items: pageItems, nextCursor: next, totalCount: filtered.length });
  }

  const cropMatch = rawPath.match(/^\/collectibles\/([^/]+)\/crop$/);
  if (cropMatch && method === 'POST') return jsonResponse({ jobId: 'mock-job-001' });

  const collectibleMatch = rawPath.match(/^\/collectibles\/([^/]+)$/);
  if (collectibleMatch) {
    const item = collectibles.find((current) => current.id === collectibleMatch[1]);
    if (!item) return Promise.reject(new Error('收藏不存在'));
    if (method === 'PUT') {
      if (body.name !== undefined) item.name = String(body.name);
      if (body.notes !== undefined) item.notes = String(body.notes);
      if (body.tags !== undefined) item.tags = (body.tags as string[]).slice(0, 30);
      if (body.shelfId !== undefined) {
        const shelf = shelves.find((current) => current.id === body.shelfId);
        const previous = shelves.find((current) => current.id === item.shelfId);
        if (previous && previous.id !== shelf?.id) previous.itemCount = Math.max(0, previous.itemCount - 1);
        if (shelf && previous?.id !== shelf.id) shelf.itemCount += 1;
        item.shelfId = shelf?.id ?? '';
        item.shelfName = shelf?.name ?? '';
      }
      item.updatedAt = new Date().toISOString();
      return jsonResponse<Collectible>(publicCollectible(item));
    }
    if (method === 'DELETE') {
      const shelf = shelves.find((current) => current.id === item.shelfId);
      if (shelf) shelf.itemCount = Math.max(0, shelf.itemCount - 1);
      collectibles.splice(collectibles.indexOf(item), 1);
      return jsonResponse({});
    }
    return jsonResponse<Collectible>(publicCollectible(item));
  }

  if (rawPath === '/uploads/policy') {
    return jsonResponse({
      assetId: 'mock-asset-001',
      key: 'mock/key.png',
      uploadUrl: '',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      formData: {}
    });
  }
  if (rawPath === '/uploads/complete') return jsonResponse({});

  return Promise.reject(new Error(`Mock 未覆盖的接口：${method} ${rawPath}`));
}
