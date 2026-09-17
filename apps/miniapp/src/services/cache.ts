import { runtimeConfig } from '../config';

function key(name: string) {
  return `${runtimeConfig.cachePrefix}:${name}`;
}

export function readCache<T>(name: string): T | undefined {
  return uni.getStorageSync(key(name)) || undefined;
}

export function writeCache<T>(name: string, value: T) {
  uni.setStorageSync(key(name), value);
}

export function removeCache(name: string) {
  uni.removeStorageSync(key(name));
}
