import type { ImageCrop, ImageSide, ImageSideDto } from '../../../../packages/contracts/src/image-sides';
import type { Collectible } from '../types';
export type { ImageCrop, ImageSide, ImageSideDto };
export const SIDES: ImageSide[] = ['FRONT', 'BACK'];
export const sideLabel = (side: ImageSide) => side === 'FRONT' ? '正面' : '反面';
export function getSide(item: Collectible | null, side: ImageSide): ImageSideDto | undefined {
  if (!item) return undefined;
  if (item.sides) return item.sides[side];
  return side === 'FRONT' ? { side, sourceVersion: 1, processingVersion: 1, publishedVersion: item.processingStatus === 'READY' ? 1 : null,
    processingStatus: item.processingStatus, displayImageUrl: item.displayImageUrl,
    standardImageUrl: item.standardImageUrl, cutoutImageUrl: item.cutoutImageUrl, crop: item.crop, matted: !!item.cutoutImageUrl } : undefined;
}
export function readEditor<T>(id: string, kind: string): T | undefined {
  return uni.getStorageSync(`bag-editor:${id}:${kind}`) || undefined;
}
export function writeEditor(id: string, kind: string, value: unknown) { uni.setStorageSync(`bag-editor:${id}:${kind}`, value); }
export function clearEditor(id: string, kind: string) { uni.removeStorageSync(`bag-editor:${id}:${kind}`); }
export function clearSideEditor(id: string, side: ImageSide) {
  const crop = readEditor<{ drafts?: Partial<Record<ImageSide, unknown>>; payloads?: Partial<Record<ImageSide, ImageCrop>> }>(id, 'crop');
  if (crop) {
    if (crop.drafts) delete crop.drafts[side];
    if (crop.payloads) delete crop.payloads[side];
    writeEditor(id, 'crop', crop);
  }
  const operations = readEditor<ImageOperation[]>(id, 'operations');
  if (operations) writeEditor(id, 'operations', operations.filter(op => op.side !== side));
}
export interface ImageOperation { side: ImageSide; sourceVersion?: number; crop?: ImageCrop; matte: boolean; jobId?: string; version?: number; error?: string }
