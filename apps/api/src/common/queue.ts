export const IMAGE_QUEUE = 'bagcollect-images';

export type ImageJobName = 'normalize' | 'crop' | 'matting' | 'cleanup';

export interface NormalizeJobData {
  processingJobId: string;
  collectibleId: string;
  userId: string;
  version: number;
}

/** POST /collectibles/:id/crop 的队列载荷：只裁剪，不抠图 */
export type CropJobData = NormalizeJobData;

/** POST /collectibles/:id/matte 的队列载荷：裁剪 + 万象抠图 */
export type MattingJobData = NormalizeJobData;

export interface CleanupJobData {
  keys: string[];
}
