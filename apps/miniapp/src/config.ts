const configuredApi = import.meta.env.VITE_API_BASE_URL?.trim();

export const runtimeConfig = {
  apiBaseUrl: configuredApi || (import.meta.env.DEV ? 'http://127.0.0.1:3001/api' : 'https://api.example.com/api'),
  cachePrefix: 'bagcollect:v1'
};
