export type ProcessingStatus = 'UPLOADING' | 'NORMALIZING' | 'AWAITING_CROP' | 'MATTING' | 'READY' | 'FAILED';
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
