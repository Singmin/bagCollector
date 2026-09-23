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

export interface UploadPolicy {
  assetId: string;
  key: string;
  uploadUrl: string;
  expiresAt: string;
  formData: Record<string, string>;
}
