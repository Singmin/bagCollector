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

export type ShelfTheme = (typeof shelfThemes)[number];
export type ProcessingStatus = (typeof processingStatuses)[number];

/* 裁剪几何 + 调色：只描述「怎么裁」，不含「要不要抠图」——
   抠图是独立端点（POST /collectibles/:id/matte），两个动作互不夹带 */
const cropGeometry = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0.05).max(1),
  height: z.number().min(0.05).max(1),
  /* P1：自由角度矫正 —— 不再限定 90° 步进，允许任意角度（-180~360） */
  rotation: z.number().min(-180).max(360),
  /* P2：调色（可选，缺省 1 = 不调整）；预览在小程序端用 CSS filter，落盘由 worker 的 sharp 处理 */
  brightness: z.number().min(0.5).max(2).optional(),
  contrast: z.number().min(0.5).max(2).optional(),
  saturation: z.number().min(0).max(3).optional()
});

const inBounds = (crop: { x: number; y: number; width: number; height: number }, context: z.RefinementCtx) => {
  if (crop.x + crop.width > 1.000001) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: '裁剪区域超出图片右侧' });
  }
  if (crop.y + crop.height > 1.000001) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['height'], message: '裁剪区域超出图片底部' });
  }
};

/** POST /collectibles/:id/crop —— 只按裁剪参数重新出图（不做抠图） */
export const cropSchema = cropGeometry.superRefine(inBounds);

/** POST /collectibles/:id/matte —— 抠图。参数全部可省：
    省略时沿用上次保存的裁剪参数，从来没有裁剪记录则按全幅处理；
    也允许只覆盖其中几个字段（例如只调旋转再抠一次） */
export const matteSchema = cropGeometry.partial().superRefine((crop, context) => {
  if (crop.x !== undefined && crop.width !== undefined && crop.x + crop.width > 1.000001) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: '裁剪区域超出图片右侧' });
  }
  if (crop.y !== undefined && crop.height !== undefined && crop.y + crop.height > 1.000001) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['height'], message: '裁剪区域超出图片底部' });
  }
});

export type CropInput = z.infer<typeof cropSchema>;
export type MatteInput = z.infer<typeof matteSchema>;

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
