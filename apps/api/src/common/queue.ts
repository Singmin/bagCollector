export const IMAGE_QUEUE = 'bagcollect-images';

export type ImageJobName = 'normalize' | 'matting' | 'cleanup';

export interface NormalizeJobData {
  processingJobId: string;
  collectibleId: string;
  userId: string;
  version: number;
}

export type MattingJobData = NormalizeJobData;

export interface CleanupJobData {
  keys: string[];
}
