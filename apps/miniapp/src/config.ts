const configuredApi = import.meta.env.VITE_API_BASE_URL?.trim();

if (!configuredApi) throw new Error('VITE_API_BASE_URL is required');

/* 本地联调固定 code（只在 --mode localbuild 注入）：后端 WECHAT_AUTH_MOCK=true 时
   openid = mock_ + sha256(code)，code 每次由 uni.login 随机生成的话，每次启动都会
   新建一个空账号、看不到 mock 数据；固定 code 才能稳定命中同一个用户。
   生产构建读不到该变量，仍走 uni.login() 的真实 code。 */
const wechatMockCode = import.meta.env.VITE_WECHAT_MOCK_CODE?.trim();

export const runtimeConfig = {
  apiBaseUrl: configuredApi,
  wechatMockCode: wechatMockCode || undefined
};
