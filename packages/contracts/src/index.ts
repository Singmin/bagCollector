import { z } from 'zod';

export const shelfThemes = ['SAGE', 'AMBER', 'SKY', 'ROSE', 'GRAPHITE'] as const;
export const processingStatuses = [
  'UPLOADING',
  'NORMALIZING',
  'AWAITING_CROP',
  'MATTING',
  'READY',
  'FAILED'
] as const;
export const officialBagStatuses = ['DRAFT', 'PUBLISHED', 'OFFLINE'] as const;
export const officialProcessStatuses = ['PENDING', 'PROCESSING', 'READY', 'FAILED'] as const;

export type ShelfTheme = (typeof shelfThemes)[number];
export type ProcessingStatus = (typeof processingStatuses)[number];
export type OfficialBagStatus = (typeof officialBagStatuses)[number];
export type OfficialProcessStatus = (typeof officialProcessStatuses)[number];

export const cropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.05).max(1),
    height: z.number().min(0.05).max(1),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
  })
  .superRefine((crop, context) => {
    if (crop.x + crop.width > 1.000001) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: '裁剪区域超出图片右侧' });
    }
    if (crop.y + crop.height > 1.000001) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['height'], message: '裁剪区域超出图片底部' });
    }
  });

export type CropInput = z.infer<typeof cropSchema>;

export const createShelfSchema = z.object({
  name: z.string().trim().min(1).max(30),
  theme: z.enum(shelfThemes)
});

export const updateShelfSchema = createShelfSchema.partial();

export const reorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(1000)
});

export const createCollectibleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  shelfId: z.string().min(1)
});

export const updateCollectibleSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(30).optional(),
  shelfId: z.string().min(1).optional()
});

export const uploadPolicySchema = z.object({
  collectibleId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
  size: z.number().int().positive()
});

export const uploadCompleteSchema = z.object({
  assetId: z.string().min(1),
  collectibleId: z.string().min(1),
  key: z.string().min(1)
});

export const wechatLoginSchema = z.object({
  code: z.string().min(1).max(256),
  deviceName: z.string().max(120).optional()
});

export const refreshSchema = z.object({ refreshToken: z.string().min(32) });
export const logoutSchema = refreshSchema;

export const adminLoginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(256)
});

export const createOfficialBagSchema = z.object({
  name: z.string().trim().min(1).max(80),
  brandId: z.string().min(1).nullable().optional(),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(30).optional(),
  matting: z.boolean().optional()
});

export const updateOfficialBagSchema = createOfficialBagSchema.partial().extend({
  status: z.enum(officialBagStatuses).optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional()
});

export const createBrandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).max(1_000_000).optional()
});

export const updateBrandSchema = createBrandSchema.partial();

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface ShelfDto {
  id: string;
  name: string;
  theme: ShelfTheme;
  sortOrder: number;
  itemCount: number;
}

export interface CollectibleSummaryDto {
  id: string;
  name: string;
  shelfId: string;
  shelfName: string;
  processingStatus: ProcessingStatus;
  thumbnailUrl?: string;
  addedAt: string;
  updatedAt: string;
}

export interface CollectiblePageDto {
  items: CollectibleSummaryDto[];
  nextCursor: string | null;
  totalCount: number;
}

export interface CollectibleDto extends CollectibleSummaryDto {
  notes: string;
  tags: string[];
  processingError?: string;
  displayImageUrl?: string;
  standardImageUrl?: string;
}

export interface OfficialBagDto {
  id: string;
  name: string;
  brandId?: string;
  brand?: string;
  notes: string;
  tags: string[];
  matting: boolean;
  status: OfficialBagStatus;
  processStatus: OfficialProcessStatus;
  processError?: string;
  claimedCount: number;
  sortOrder: number;
  publishedAt?: string;
  thumbnailUrl?: string;
  displayImageUrl?: string;
  /** 用户端专用：当前用户是否已拥有过该袋子。 */
  claimed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OfficialBagPageDto {
  items: OfficialBagDto[];
  nextCursor: string | null;
  totalCount: number;
}

export interface OfficialClaimResultDto {
  collectibleId: string;
  processingStatus: ProcessingStatus;
}

export interface BrandDto {
  id: string;
  name: string;
  sortOrder: number;
  /** 旗下袋子数量（管理端返回）。 */
  bagCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const errorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  UPLOAD_INVALID: 'UPLOAD_INVALID',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  WECHAT_LOGIN_FAILED: 'WECHAT_LOGIN_FAILED',
  CONFLICT: 'CONFLICT'
} as const;
