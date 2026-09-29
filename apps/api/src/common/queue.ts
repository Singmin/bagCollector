export const IMAGE_QUEUE = 'bagcollect-images';

export type ImageJobName = 'normalize' | 'matting' | 'cleanup' | 'official-process' | 'official-claim';

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
