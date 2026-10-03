import { runtimeConfig } from '../config';
import type { Collectible, CollectibleSummary } from '../types';

const downloaded = new Map<string, Promise<string>>();
const thumbnails = new Map<string, Promise<string>>();
const thumbnailQueue: Array<() => void> = [];
/* 微信小程序 uni.downloadFile 的并发上限是 10，队列上限取齐平台额度。
   2026-10-03 前是 4：真机实测每张缩略图 200~800ms（API 代理转发一跳），
   11 张图排队要 9s 才出全；提到 10 后同一批图约三路并行跑完。 */
const MAX_THUMBNAIL_DOWNLOADS = 10;
let activeThumbnailDownloads = 0;

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

function runNextThumbnail() {
  while (activeThumbnailDownloads < MAX_THUMBNAIL_DOWNLOADS && thumbnailQueue.length) {
    const next = thumbnailQueue.shift();
    next?.();
  }
}

function queuedLocalFile(url: string) {
  return new Promise<string>((resolve, reject) => {
    thumbnailQueue.push(() => {
      activeThumbnailDownloads += 1;
      localFile(url).then((value) => {
        if (value) resolve(value);
        else reject(new Error('缩略图地址为空'));
      }, reject).finally(() => {
        activeThumbnailDownloads -= 1;
        runNextThumbnail();
      });
    });
    runNextThumbnail();
  });
}

export function resolveCollectibleThumbnail(item: CollectibleSummary): Promise<string | undefined> {
  if (!item.thumbnailUrl) return Promise.resolve(undefined);
  if (!needsDownload(item.thumbnailUrl)) return Promise.resolve(item.thumbnailUrl);
  const key = `${item.id}:${item.updatedAt}`;
  let pending = thumbnails.get(key);
  if (!pending) {
    pending = queuedLocalFile(item.thumbnailUrl);
    pending.catch(() => thumbnails.delete(key));
    thumbnails.set(key, pending);
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
