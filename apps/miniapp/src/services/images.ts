import { runtimeConfig } from '../config';
import type { Collectible } from '../types';

const downloaded = new Map<string, Promise<string>>();

function needsDownload(url?: string) {
  return Boolean(url && runtimeConfig.apiBaseUrl.startsWith('http://') && url.startsWith('http://'));
}

function localFile(url?: string) {
  if (!url || !needsDownload(url)) return Promise.resolve(url);
  let pending = downloaded.get(url);
  if (!pending) {
    pending = new Promise<string>((resolve, reject) => {
      uni.downloadFile({
        url,
        success(result) {
          if (result.statusCode >= 200 && result.statusCode < 300) resolve(result.tempFilePath);
          else reject(new Error(`图片下载失败（${result.statusCode}）`));
        },
        fail(error) {
          reject(new Error(error.errMsg || '图片下载失败'));
        }
      });
    });
    pending.catch(() => downloaded.delete(url));
    downloaded.set(url, pending);
  }
  return pending;
}

export async function localizeCollectibleImages(item: Collectible): Promise<Collectible> {
  const [thumbnailUrl, displayImageUrl, standardImageUrl] = await Promise.all([
    localFile(item.thumbnailUrl),
    localFile(item.displayImageUrl),
    localFile(item.standardImageUrl)
  ]);
  return {
    ...item,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(displayImageUrl ? { displayImageUrl } : {}),
    ...(standardImageUrl ? { standardImageUrl } : {})
  };
}
