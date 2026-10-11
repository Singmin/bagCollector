export const TOKEN_KEY = 'bagcollect:admin-token';

/** 管理后台的统一请求封装：自动带上 token 前缀 /api/admin，返回已解析的 JSON。 */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  // 只有真的带 JSON body 时才声明 Content-Type：DELETE 这类没有 body 的请求
  // 若带上 application/json，Fastify 会按「空 JSON body」直接返回 400。
  const hasJsonBody =
    options.body !== undefined && options.body !== null && !(options.body instanceof FormData);
  const response = await fetch(`/api/admin${path}`, {
    ...options,
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || body?.message || '请求失败');
  return body as T;
}
