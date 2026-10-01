import { runtimeConfig } from '../config';
import type { AuthTokens } from '../types';
import { readTokens, removeTokens, writeTokens } from './auth-storage';
import { USE_MOCK, mockRequest } from './mock-data';
let loginPromise: Promise<void> | undefined;
let refreshPromise: Promise<void> | undefined;

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: string | AnyObject | ArrayBuffer;
  header?: AnyObject;
}

function requestRaw<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    uni.request({
      ...options,
      url: `${runtimeConfig.apiBaseUrl}${path}`,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data as T);
        else {
          const body = response.data as { error?: { message?: string; code?: string } };
          const error = new Error(body?.error?.message || `请求失败（${response.statusCode}）`) as Error & {
            statusCode?: number;
            code?: string;
          };
          error.statusCode = response.statusCode;
          error.code = body?.error?.code;
          reject(error);
        }
      },
      fail(error) {
        reject(new Error(`${error.errMsg || '网络请求失败'}：${runtimeConfig.apiBaseUrl}`));
      }
    });
  });
}

async function wechatCode() {
  const result = await uni.login({ provider: 'weixin' });
  if (!result.code) throw new Error('微信登录 code 为空');
  return result.code;
}

function systemName() {
  const info = uni.getSystemInfoSync();
  return `${info.platform || 'unknown'} ${info.model || ''}`.trim();
}

export async function login() {
  /* Mock 模式：不发真实登录请求，写入假 token 让依赖 token 的代码路径正常走 */
  if (USE_MOCK) {
    const now = Date.now();
    writeTokens({
      accessToken: `mock-access-${now}`,
      accessTokenExpiresIn: 3600,
      refreshToken: `mock-refresh-${now}`,
      refreshTokenExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString()
    });
    return;
  }
  loginPromise ??= (async () => {
    const tokens = await requestRaw<AuthTokens>('/auth/wechat/login', {
      method: 'POST',
      data: { code: await wechatCode(), deviceName: systemName() }
    });
    writeTokens(tokens);
  })().finally(() => { loginPromise = undefined; });
  return loginPromise;
}

async function refresh() {
  refreshPromise ??= (async () => {
    const current = readTokens();
    if (!current?.refreshToken) return login();
    try {
      const tokens = await requestRaw<AuthTokens>('/auth/refresh', {
        method: 'POST', data: { refreshToken: current.refreshToken }
      });
      writeTokens(tokens);
    } catch {
      removeTokens();
      await login();
    }
  })().finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}

export async function ensureLogin() {
  if (!readTokens()?.accessToken) await login();
}

export async function authorizedHeaders() {
  await ensureLogin();
  const tokens = readTokens()!;
  return { Authorization: `Bearer ${tokens.accessToken}` };
}

/* ══════════════════════════════════════════════════════════════════
   ⚠️ 后端尚未实现（2026-09-29）：所有接口由 mock-data.ts 内存模拟。
   前端联调/演示一律用 Mock 构建：pnpm build:miniapp:mock
   （VITE_USE_MOCK=1 时 api() 直接走 mockRequest，不触网）。
   不要跑全仓 pnpm build —— 会先构建 apps/api、apps/worker 等后端包而失败。

   后端同事需实现的接口清单（路径与响应结构以 contracts 包 + mock-data.ts 为准）：
   · POST   /auth/wechat/login        微信 code 登录
   · POST   /auth/refresh             刷新 token
   · POST   /auth/logout              登出
   · GET    /account                  账户概览（藏品数/展架数/存储用量）
   · GET    /shelves                  展架列表
   · POST   /shelves                  新建展架
   · PUT    /shelves/:id              改展架
   · DELETE /shelves/:id              删展架
   · PUT    /shelves/reorder          展架排序
   · GET    /feed                     官方精选纸袋上新（发现页）
   · GET    /collectibles             我的收藏列表
   · POST   /collectibles             新建收藏
   · GET    /collectibles/:id         收藏详情
   · PUT    /collectibles/:id         更新收藏
   · DELETE /collectibles/:id         删除收藏
   · PUT    /collectibles/:id/crop    只裁剪：重出展示图/缩略图，不抠图
   · POST   /collectibles/:id/matte   只抠图：沿用已保存裁剪参数（可缺省按全幅），走万象、计配额
   · GET    /wishlist                 心愿袋列表
   · POST   /wishlist/:id             加入心愿袋
   · DELETE /wishlist/:id             移出心愿袋
   · POST   /uploads/policy           取上传凭证
   · POST   /uploads/complete         完成上传
   后端就绪后：前端代码零改动，去掉 mock 构建开关即切真实接口。
   ══════════════════════════════════════════════════════════════════ */
export async function api<T>(path: string, options: ApiRequestOptions = {}, didRetry = false): Promise<T> {
  /* Mock 模式：全部请求走内存假数据，不触网 */
  if (USE_MOCK) return mockRequest<T>(path, options);
  await ensureLogin();
  const tokens = readTokens()!;
  try {
    return await requestRaw<T>(path, {
      ...options,
      header: {
        ...(options.data !== undefined ? { 'content-type': 'application/json' } : {}),
        Authorization: `Bearer ${tokens.accessToken}`,
        ...(options.header || {})
      }
    });
  } catch (error) {
    if (!didRetry && (error as { statusCode?: number }).statusCode === 401) {
      await refresh();
      return api<T>(path, options, true);
    }
    throw error;
  }
}

export async function logout() {
  if (USE_MOCK) { removeTokens(); return; }
  const tokens = readTokens();
  if (tokens?.refreshToken) {
    await requestRaw('/auth/logout', { method: 'POST', data: { refreshToken: tokens.refreshToken } });
  }
  removeTokens();
}
