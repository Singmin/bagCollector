/* 与后端 Prisma 枚举一一对应：CROPPING = 裁剪任务进行中，MATTING = 抠图任务进行中 */
export type ProcessingStatus = 'UPLOADING' | 'NORMALIZING' | 'AWAITING_CROP' | 'CROPPING' | 'MATTING' | 'READY' | 'FAILED';
export type ShelfTheme = 'SAGE' | 'AMBER' | 'SKY' | 'ROSE' | 'GRAPHITE';

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface Shelf {
  id: string;
  name: string;
  theme: ShelfTheme;
  sortOrder: number;
  itemCount: number;
}

export interface CollectibleSummary {
  id: string;
  name: string;
  shelfId: string;
  shelfName: string;
  processingStatus: ProcessingStatus;
  thumbnailUrl?: string;
  addedAt: string;
  updatedAt: string;
  /** 发现页 feed 条目的主人昵称（官方精选时为品牌名）；自己的收藏没有该字段 */
  ownerName?: string;
}

export interface Collectible extends CollectibleSummary {
  notes: string;
  tags: string[];
  processingError?: string;
  displayImageUrl?: string;
  standardImageUrl?: string;
  /** 抠图结果（透明 PNG）：有值表示已经抠过图，编辑页据此隐藏「自动抠图」按钮 */
  cutoutImageUrl?: string;
  /** 已保存的裁剪参数（裁剪页提交后回传；抠图时原样带上，避免把画面重置成全幅） */
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    brightness?: number;
    contrast?: number;
    saturation?: number;
  };
}

export interface CollectiblePage {
  items: CollectibleSummary[];
  nextCursor: string | null;
  totalCount: number;
}

/** 拥有官方袋子（发现页「标记已有」）的结果：记录已建好，图片仍在后台复制。 */
export interface OfficialClaimResult {
  collectibleId: string;
  processingStatus: ProcessingStatus;
}

export interface UploadPolicy {
  assetId: string;
  key: string;
  uploadUrl: string;
  expiresAt: string;
  formData: Record<string, string>;
}
