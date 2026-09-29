import type { AuthTokens, Collectible, CollectiblePage, CollectibleSummary, Shelf, ShelfTheme } from '../types';
import type { ApiRequestOptions } from './http';

/* ── 本地 Mock 开关（仅用于无后端时预览 UI）──
   构建时注入 VITE_USE_MOCK=1 才生效，正式构建完全不受影响。
   数据只存在内存里，模拟器里刷新即重置。

   ⚠️ 真实后端尚未实现（由另一名同事后续补齐，接口清单见 services/http.ts 顶部备注）。
   现阶段前端联调/演示请只用 Mock 构建：pnpm build:miniapp:mock；
   不要跑全仓 pnpm build（会先构建后端包而失败）。后端就绪后前端零改动即可切换。

   三套数据：
   · feedItems      —— 发现页「纸袋上新」官方精选（别人的纸袋，带 ownerName）
   · myCollectibles —— 收藏架「我的」分段（自己的纸袋，挂在 shelves 下）
   · wishlist       —— 心愿袋（从发现页加入的纸袋，保存的是 feed 条目的副本） */
export const USE_MOCK = String(import.meta.env.VITE_USE_MOCK ?? '').trim() === '1';

/* 十张袋子均为真实联名/系列款（已逐张识别）：
   bag-01 luckin×Crocs「LUCK IN SUMMER」/ bag-02「ALL IN LUCKIN」白色拼贴 /
   bag-03「ALL IN LUCKIN」彩色满印 / bag-04 CHAGEE×梵高《盛开的杏花》 /
   bag-05 CHAGEE×莫奈《日出·印象》 / bag-06 luckin×MINISO「LUCK IN HAND」/
   bag-07 Peet's「THE FLOWER OF Handcraft」/ bag-08 Peet's「Whispers of Autumn」/
   bag-09 Peet's 经典牛皮纸袋 / bag-10 Peet's 窄长单杯袋 */
const BAG_IMAGES = [
  '/static/figma/bags/bag-01.png',
  '/static/figma/bags/bag-02.png',
  '/static/figma/bags/bag-03.png',
  '/static/figma/bags/bag-04.png',
  '/static/figma/bags/bag-05.png',
  '/static/figma/bags/bag-06.png',
  '/static/figma/bags/bag-07.png',
  '/static/figma/bags/bag-08.png',
  '/static/figma/bags/bag-09.png',
  '/static/figma/bags/bag-10.png'
];

function iso(daysAgo: number) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

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
  { id: 'shelf-mock-003', name: "Peet's Coffee", theme: 'AMBER', sortOrder: 3, itemCount: 0 }
];

const feedItems: MockCollectible[] = [];
const myCollectibles: MockCollectible[] = [];
const wishlist: MockCollectible[] = [];

/* 通用种子：往指定列表塞一条，addedAtMs 保证按写入顺序错开 */
let seedTick = 0;
function seedCollectible(list: MockCollectible[], shelf: Shelf | null, name: string, tags: string[], notes: string, daysAgo: number, imageIndex: number, ownerName?: string) {
  const now = Date.now() - daysAgo * 24 * 60 * 60 * 1000 - seedTick * 60 * 60 * 1000;
  seedTick += 1;
  const image = BAG_IMAGES[imageIndex % BAG_IMAGES.length];
  list.push({
    id: nextId('collectible'),
    name,
    shelfId: shelf?.id ?? '',
    shelfName: shelf?.name ?? '',
    processingStatus: 'READY',
    thumbnailUrl: image,
    displayImageUrl: image,
    addedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    notes,
    tags,
    addedAtMs: now,
    ...(ownerName ? { ownerName } : {})
  });
  if (shelf) shelf.itemCount += 1;
}

/* ── 发现页「纸袋上新」：官方精选 10 条（ownerName = 品牌官方账号）──
   收藏名 = 联名/系列名（袋面文字），不是饮品名 —— 收藏对象是袋子本身 */
seedCollectible(feedItems, null, '盛开的杏花', ['联名', '艺术系列', '蓝白'], 'CHAGEE × 梵高《盛开的杏花》联名袋，蓝底白杏花铺满整面，封口贴纸完好。', 0, 3, '霸王茶姬');
seedCollectible(feedItems, null, 'LUCK IN SUMMER', ['联名', '夏日', '涂鸦'], 'luckin × Crocs「LUCK IN SUMMER」联名袋，深蓝底印满滑板、椰子和阳光涂鸦。', 0, 0, '瑞幸咖啡');
seedCollectible(feedItems, null, 'THE FLOWER OF Handcraft', ['联名', '花艺', '大理石纹'], 'Peet\'s「THE FLOWER OF Handcraft」花艺大理石纹袋，橙白漩涡纹样，随袋附同系列杯套。', 7, 6, "Peet's Coffee");
seedCollectible(feedItems, null, '日出·印象', ['联名', '艺术系列', '灰蓝'], 'CHAGEE × 莫奈《日出·印象》联名袋，灰蓝海面上一轮橙日，绳子是黑色的。', 10, 4, '霸王茶姬');
seedCollectible(feedItems, null, 'LUCK IN HAND', ['联名', 'MINISO', '紫色'], 'luckin × MINISO「LUCK IN HAND」联名袋，紫色底上 YOYO 南瓜头小人举着咖啡。', 13, 5, '瑞幸咖啡');
seedCollectible(feedItems, null, 'Whispers of Autumn', ['限定', '秋季', '花卉'], 'Peet\'s「Whispers of Autumn」秋日花卉袋，米底金黄秋花满印，秋日限定系列。', 16, 7, "Peet's Coffee");
seedCollectible(feedItems, null, 'ALL IN LUCKIN · 白色拼贴', ['联名', '白色拼贴'], '「ALL IN LUCKIN」白色拼贴款，扁平小人举着爱心，徽章写「幸运在你身边了」。', 20, 1, '瑞幸咖啡');
seedCollectible(feedItems, null, '经典牛皮纸袋', ['经典款', '牛皮纸'], 'Peet\'s 经典款牛皮纸袋，白字「Coffee for Coffee People」。', 24, 8, "Peet's Coffee");
seedCollectible(feedItems, null, 'ALL IN LUCKIN · 彩色满印', ['联名', '彩色满印'], '「ALL IN LUCKIN」彩色满印款，满版人物插画，绿色爱心徽章写「有你幸运来了」。', 27, 2, '瑞幸咖啡');
seedCollectible(feedItems, null, '窄长单杯袋', ['单杯', '牛皮纸'], 'Peet\'s 窄长款单杯袋，竖排 Peet\'s 标志，装一杯冷萃刚刚好。', 30, 9, "Peet's Coffee");

/* ── 收藏架「我的」：3 条自己的收藏（每个展架一条）── */
seedCollectible(myCollectibles, shelves[0], '盛开的杏花', ['联名', '艺术系列'], '在门店排队两小时才抢到的首发联名，杏花那面舍不得折角。', 4, 3);
seedCollectible(myCollectibles, shelves[1], 'LUCK IN HAND', ['联名', 'MINISO'], 'MINISO 联名第二波，紫色这只袋子最完整，YOYO 小人一个都没磨掉。', 7, 5);
seedCollectible(myCollectibles, shelves[2], '经典牛皮纸袋', ['经典款'], '第一次去 Peet\'s 门店留下的袋子，纸感很厚实。', 15, 8);

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

function jsonResponse<T>(data: T) {
  return Promise.resolve(data as T);
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
      collectibleCount: myCollectibles.length,
      shelfCount: shelves.length,
      storageUsedBytes: myCollectibles.length * 1024 * 512,
      storageQuotaBytes: 5 * 1024 * 1024 * 1024
    });
  }

  /* ── 发现页「纸袋上新」：官方精选 feed（返回完整条目，背面要展示标签与备注）── */
  if (rawPath === '/feed') {
    const { limit, search, cursor } = parseQuery(rawQuery);
    const filtered = sortDesc(feedItems.filter((item) => matchSearch(item, search)));
    const start = cursor ? Math.max(0, Number(cursor) || 0) : 0;
    const pageItems = filtered.slice(start, start + limit).map(publicCollectible);
    const next = start + limit < filtered.length ? String(start + limit) : null;
    return jsonResponse<CollectiblePage>({ items: pageItems as unknown as CollectibleSummary[], nextCursor: next, totalCount: filtered.length });
  }

  /* ── 心愿袋 ── */
  if (rawPath === '/wishlist' && method === 'GET') {
    return jsonResponse<Collectible[]>(sortDesc(wishlist).map(publicCollectible));
  }
  const wishMatch = rawPath.match(/^\/wishlist\/([^/]+)$/);
  if (wishMatch) {
    const source = feedItems.find((item) => item.id === wishMatch[1]);
    if (!source) return Promise.reject(new Error('纸袋不存在或已下架'));
    if (method === 'POST') {
      if (!wishlist.some((item) => item.id === source.id)) wishlist.push({ ...source });
      return jsonResponse({});
    }
    if (method === 'DELETE') {
      const index = wishlist.findIndex((item) => item.id === source.id);
      if (index >= 0) wishlist.splice(index, 1);
      return jsonResponse({});
    }
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
      myCollectibles.filter((item) => item.shelfId === shelf.id).forEach((item) => { item.shelfId = ''; item.shelfName = ''; });
      touchShelvesSortOrder();
      return jsonResponse({});
    }
  }

  if (rawPath === '/collectibles') {
    if (method === 'POST') {
      /* 标记已有：从发现页带入袋子的图与默认文案；上传流程：只带名称与展架 */
      const shelf = shelves.find((current) => current.id === body.shelfId) ?? shelves[0];
      const now = Date.now();
      const item: MockCollectible = {
        id: nextId('collectible'),
        name: String(body.name ?? '未命名纸袋'),
        shelfId: shelf?.id ?? '',
        shelfName: shelf?.name ?? '',
        /* 新建即「待抠图」：抠图已改为编辑页用户手动触发（真实后端同样流转），crop 后置 READY */
        processingStatus: 'AWAITING_CROP',
        thumbnailUrl: body.thumbnailUrl ? String(body.thumbnailUrl) : undefined,
        displayImageUrl: body.displayImageUrl ? String(body.displayImageUrl) : undefined,
        addedAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        notes: body.notes ? String(body.notes) : '',
        tags: Array.isArray(body.tags) ? (body.tags as string[]).slice(0, 30) : [],
        addedAtMs: now
      };
      myCollectibles.push(item);
      if (shelf) shelf.itemCount += 1;
      return jsonResponse<Collectible>(publicCollectible(item));
    }
    const { limit, search, cursor } = parseQuery(rawQuery);
    const filtered = sortDesc(myCollectibles.filter((item) => item.shelfId && matchSearch(item, search)));
    const start = cursor ? Math.max(0, Number(cursor) || 0) : 0;
    const pageItems = filtered.slice(start, start + limit).map(summary);
    const next = start + limit < filtered.length ? String(start + limit) : null;
    return jsonResponse<CollectiblePage>({ items: pageItems, nextCursor: next, totalCount: filtered.length });
  }

  const cropMatch = rawPath.match(/^\/collectibles\/([^/]+)\/crop$/);
  /* Mock 抠图：提交即视为完成（真实后端走 MATTING 再 READY），处理页轮询到 READY 后回编辑页 */
  if (cropMatch && method === 'POST') {
    const target = myCollectibles.find((current) => current.id === cropMatch[1]);
    if (target) target.processingStatus = 'READY';
    return jsonResponse({ jobId: 'mock-job-001' });
  }

  const collectibleMatch = rawPath.match(/^\/collectibles\/([^/]+)$/);
  if (collectibleMatch) {
    const mine = myCollectibles.find((current) => current.id === collectibleMatch[1]);
    if (method === 'PUT' || method === 'DELETE') {
      /* 写操作仅限自有收藏：feed/心愿条目不可改（心愿条目与 feed 同 id，防误改） */
      const item = mine;
      if (!item) return Promise.reject(new Error('收藏不存在'));
      if (method === 'PUT') {
        if (body.name !== undefined) item.name = String(body.name);
        if (body.notes !== undefined) item.notes = String(body.notes);
        if (body.tags !== undefined) item.tags = (body.tags as string[]).slice(0, 30);
        if (body.addedAt !== undefined) {
          /* 收藏日期可改：同步 addedAtMs 保持列表排序正确 */
          const t = new Date(String(body.addedAt));
          if (!Number.isNaN(t.getTime())) { item.addedAt = t.toISOString(); item.addedAtMs = t.getTime(); }
        }
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
      const shelf = shelves.find((current) => current.id === item.shelfId);
      if (shelf) shelf.itemCount = Math.max(0, shelf.itemCount - 1);
      myCollectibles.splice(myCollectibles.indexOf(item), 1);
      return jsonResponse({});
    }
    /* GET 允许命中 feed 条目：心愿袋里的纸袋与 feed 同 id，详情卡要点开看 */
    const item = mine ?? feedItems.find((current) => current.id === collectibleMatch[1]);
    if (!item) return Promise.reject(new Error('收藏不存在'));
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
