/// <reference types="@dcloudio/types" />
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /* 仅本地联调构建（--mode localbuild）注入：固定微信登录 code，见 services/http.ts */
  readonly VITE_WECHAT_MOCK_CODE?: string;
}
