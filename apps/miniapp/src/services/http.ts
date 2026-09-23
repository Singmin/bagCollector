import { runtimeConfig } from '../config';
import type { AuthTokens } from '../types';
import { readTokens, removeTokens, writeTokens } from './auth-storage';
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

export async function api<T>(path: string, options: ApiRequestOptions = {}, didRetry = false): Promise<T> {
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
  const tokens = readTokens();
  if (tokens?.refreshToken) {
    await requestRaw('/auth/logout', { method: 'POST', data: { refreshToken: tokens.refreshToken } });
  }
  removeTokens();
}
