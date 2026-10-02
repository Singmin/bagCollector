export const IMAGE_QUEUE = 'bagcollect-images';

/* 任务名并集：crop / matting 为用户收藏链路（端点拆分后各自入队），
   official-process / official-claim 为官方袋子链路 */
export type ImageJobName = 'normalize' | 'crop' | 'matting' | 'cleanup' | 'official-process' | 'official-claim';

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

export interface OfficialProcessJobData {
  officialBagId: string;
  version: number;
  matting: boolean;
}

export interface OfficialClaimJobData {
  officialBagId: string;
  userId: string;
  collectibleId: string;
}
