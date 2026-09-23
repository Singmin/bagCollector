import type { AuthTokens } from '../types';

const TOKEN_KEY = 'bagcollect:v1:tokens';

export function readTokens(): AuthTokens | undefined {
  const tokens = uni.getStorageSync(TOKEN_KEY);
  return tokens || undefined;
}

export function writeTokens(tokens: AuthTokens) {
  uni.setStorageSync(TOKEN_KEY, tokens);
}

export function removeTokens() {
  uni.removeStorageSync(TOKEN_KEY);
}
