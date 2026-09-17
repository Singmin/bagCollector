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
  isSystem: boolean;
  sortOrder: number;
  itemCount: number;
}

export interface Collectible {
  id: string;
  name: string;
  notes: string;
  tags: string[];
  shelfId: string;
  shelfName?: string;
  processingStatus: ProcessingStatus;
  processingError?: string;
  thumbnailUrl?: string;
  displayImageUrl?: string;
  standardImageUrl?: string;
  addedAt: string;
  updatedAt: string;
}

export interface CollectiblePage {
  items: Collectible[];
  nextCursor: string | null;
}

export interface UploadPolicy {
  assetId: string;
  key: string;
  uploadUrl: string;
  expiresAt: string;
  formData: Record<string, string>;
}
