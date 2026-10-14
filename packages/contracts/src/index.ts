export * from './image-sides.js';
import { z } from 'zod';
export * from './scans.js';

export const shelfThemes = ['SAGE', 'AMBER', 'SKY', 'ROSE', 'GRAPHITE'] as const;
export const processingStatuses = [
  'UPLOADING',
  'NORMALIZING',
  'AWAITING_CROP',
  'CROPPING',
  'MATTING',
  'READY',
  'FAILED'
] as const;
export const officialBagStatuses = ['DRAFT', 'PUBLISHED', 'OFFLINE'] as const;
export const officialProcessStatuses = ['PENDING', 'PROCESSING', 'READY', 'FAILED'] as const;
export const submissionStatuses = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export const userStatuses = ['ACTIVE', 'SUSPENDED'] as const;
export const releaseNoteStatuses = ['PLANNED', 'DONE'] as const;

export type ShelfTheme = (typeof shelfThemes)[number];
export type ProcessingStatus = (typeof processingStatuses)[number];
export type OfficialBagStatus = (typeof officialBagStatuses)[number];
export type OfficialProcessStatus = (typeof officialProcessStatuses)[number];
export type SubmissionStatus = (typeof submissionStatuses)[number];
export type UserStatus = (typeof userStatuses)[number];
export type ReleaseNoteStatus = (typeof releaseNoteStatuses)[number];

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
export const cropSchema = cropGeometry.extend({ side: z.enum(['FRONT', 'BACK']).optional(), sourceVersion: z.number().int().positive().optional() }).superRefine(inBounds);

/** POST /collectibles/:id/matte —— 抠图。参数全部可省：
    省略时沿用上次保存的裁剪参数，从来没有裁剪记录则按全幅处理；
    也允许只覆盖其中几个字段（例如只调旋转再抠一次） */
export const matteSchema = cropGeometry.partial().extend({ side: z.enum(['FRONT', 'BACK']).optional(), sourceVersion: z.number().int().positive().optional() }).superRefine((crop, context) => {
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
  shelfId: z.string().min(1).optional(),
  // 同款袋子的拥有数量（1-99）：>1 时前端卡片显示 ×N 角标
  quantity: z.number().int().min(1).max(99).optional(),
  // 收藏日期（ISO 字符串）：编辑时允许修改
  addedAt: z.string().datetime().optional(),
  // 可见性：私密收藏 / 公开展示
  visibility: z.enum(['PRIVATE', 'PUBLIC']).optional()
});

/**
 * 「拥有」官方袋子（发现页标记已有）。
 * 全部字段可选：不传就用官方袋子自带的名称/备注/标签，并按品牌归类（无品牌才进「未分类」）；
 * 前端标记半窗允许用户改名、归类、改标签备注，这几项作为覆盖值传进来。
 */
export const claimOfficialBagSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  shelfId: z.string().min(1).optional(),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(30).optional(),
  /* 扫描匹配再次认领已拥有的袋子时置 true：不新建收藏，只叠加同款数量（quantity+1）。 */
  increment: z.boolean().optional()
});

export type ClaimOfficialBagInput = z.infer<typeof claimOfficialBagSchema>;

/**
 * POST /official-bags/match ——「拍照扫描袋子」。
 * 拿刚上传的那条收藏的照片去比对官方袋子库，命中就直接入库，否则给出候选或未命中。
 */
export const matchOfficialBagSchema = z.object({
  collectibleId: z.string().min(1)
});

export type MatchOfficialBagInput = z.infer<typeof matchOfficialBagSchema>;

/**
 * 扫描匹配的判定阈值（管理后台可调）。
 *
 * 之所以存在库里而不是只读 env：阈值必须拿真实数据反复校准，而 env 改一次要重启容器。
 * 两个阈值的语义是「高于 auto 直接入库 / 高于 candidate 出候选 / 都不到算未命中」，
 * 因此 auto 低于 candidate 是自相矛盾的配置，直接拦掉。
 */
export const matchSettingsSchema = z
  .object({
    /** 相似度 ≥ 此值：认定同一只袋子，前端零操作入库 */
    autoThreshold: z.number().min(0).max(1),
    /** 相似度 ≥ 此值：返回候选交给用户点选；低于则视为未命中 */
    candidateThreshold: z.number().min(0).max(1),
    /** 候选返回条数 */
    candidateLimit: z.number().int().min(1).max(10)
  })
  .refine((value) => value.autoThreshold >= value.candidateThreshold, {
    message: '自动入库阈值不能低于候选阈值',
    path: ['autoThreshold']
  });

export type MatchSettingsInput = z.infer<typeof matchSettingsSchema>;
export type MatchSettingsDto = MatchSettingsInput;

export const uploadPolicySchema = z.object({
  side: z.enum(['FRONT', 'BACK']).optional(),
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
  matting: z.boolean().optional(),
  backMatting: z.boolean().optional()
});

export const updateOfficialBagSchema = createOfficialBagSchema.partial().extend({
  status: z.enum(officialBagStatuses).optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional()
});

/**
 * POST /admin/official-bags/import —— Excel 批量导入。
 * 品牌按名称匹配（不区分大小写），不存在则自动创建；导入的袋子统一为草稿，
 * 需补图后手动发布（无图直接发布会被发布校验拦截）。
 */
export const importOfficialBagRowSchema = z.object({
  name: z.string().trim().min(1).max(80),
  brandName: z.string().trim().min(1).max(80).optional(),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(30).optional()
});

export const importOfficialBagsSchema = z.object({
  items: z.array(importOfficialBagRowSchema).min(1).max(1000)
});

export type ImportOfficialBagsInput = z.infer<typeof importOfficialBagsSchema>;

export const createBrandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).max(1_000_000).optional()
});

export const updateBrandSchema = createBrandSchema.partial();

/** POST /admin/submissions/:id/promote —— 把用户上传袋子纳入官方袋子。
 *  全部字段可选：缺省沿用用户上传时的名称/备注/标签，不指定品牌则无品牌。 */
export const promoteSubmissionSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  brandId: z.string().min(1).nullable().optional(),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(30).optional()
});

/** POST /admin/submissions/:id/reject —— 驳回，可附审核意见。 */
export const rejectSubmissionSchema = z.object({
  note: z.string().max(500).optional()
});

/** PATCH /admin/users/:id/quota —— 调整单用户配额，至少传一项。 */
export const updateUserQuotaSchema = z
  .object({
    storageQuotaBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    collectibleQuota: z.number().int().min(0).max(1_000_000).optional(),
    dailyMattingQuota: z.number().int().min(0).max(10_000).optional()
  })
  .refine(
    (value) =>
      value.storageQuotaBytes !== undefined ||
      value.collectibleQuota !== undefined ||
      value.dailyMattingQuota !== undefined,
    { message: '至少指定一项要调整的配额' }
  );

export type PromoteSubmissionInput = z.infer<typeof promoteSubmissionSchema>;
export type RejectSubmissionInput = z.infer<typeof rejectSubmissionSchema>;

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
  imageRevision?: string;
  imageEditable?: boolean;
  sourceOfficialBagId?: string;
  id: string;
  name: string;
  shelfId: string;
  shelfName: string;
  processingStatus: ProcessingStatus;
  thumbnailUrl?: string;
  /** 摘要级 B 面缩略图：有值即表示该收藏/袋子存在已发布的 B 面图。
      小程序详情卡据此在打开瞬间就按 A/B 并排布局渲染，不必等详情接口返回。 */
  backThumbnailUrl?: string;
  addedAt: string;
  updatedAt: string;
  /** 发现页 feed / 心愿袋条目的主人昵称（官方精选时为品牌名）；用户自己的收藏没有该字段。 */
  ownerName?: string;
  /** 仅 feed / 心愿袋条目返回：当前用户已认领该官方袋子时，值为认领生成的收藏 id。
      小程序据此恢复「标记已有」的已标记状态（含撤回标记所需的删除目标），不再依赖页面内存。 */
  myCollectibleId?: string;
}

export interface CollectiblePageDto {
  items: CollectibleSummaryDto[];
  nextCursor: string | null;
  totalCount: number;
}

export interface CollectibleDto extends CollectibleSummaryDto {
  sides?: Partial<Record<import('./image-sides.js').ImageSide, import('./image-sides.js').ImageSideDto>>;
  notes: string;
  tags: string[];
  processingError?: string;
  displayImageUrl?: string;
  standardImageUrl?: string;
}

export interface OfficialBagDto {
  sides?: Partial<Record<import('./image-sides.js').ImageSide, import('./image-sides.js').ImageSideDto>>;
  imageRevision?: string;
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
  /** 管理后台专用：是否已生成当前扫描模型（DINO）的主参考特征向量。 */
  hasEmbedding?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OfficialBagPageDto {
  items: OfficialBagDto[];
  nextCursor: string | null;
  totalCount: number;
  /** 当前用户已拥有的官方袋子总数（全量，不受列表筛选/分页影响）。 */
  ownedCount: number;
}

export interface OfficialClaimResultDto {
  collectibleId: string;
  processingStatus: ProcessingStatus;
  /** 叠加后的同款数量（再次认领已拥有袋子时返回；首次认领为 1） */
  quantity?: number;
  /** true = 本次为「再次认领」：不新建收藏，只叠加数量 */
  alreadyOwned?: boolean;
}

/** MATCHED is retained for old decoders; current endpoints only emit CANDIDATES/NONE. */
export const officialBagMatchResults = ['MATCHED', 'CANDIDATES', 'NONE'] as const;
export type OfficialBagMatchResult = (typeof officialBagMatchResults)[number];

export interface OfficialBagMatchCandidateDto {
  bag: OfficialBagDto;
  /** 余弦相似度。返回给前端便于排查/调阈值，UI 不必展示。 */
  score: number;
}

export interface OfficialBagMatchDto {
  result: OfficialBagMatchResult;
  /** @deprecated Compatibility field; servers no longer emit automatic matches. */
  matched?: OfficialBagDto;
  /** result = CANDIDATES：按相似度降序的候选，交给用户点选。 */
  candidates?: OfficialBagMatchCandidateDto[];
  /** 本次实际参与比对的官方袋子数（0 表示库为空、或向量尚未生成）。 */
  compared: number;
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

/** 审核后台：用户上传袋子（Collectible）的审核视图。 */
export interface SubmissionDto {
  sides?: Partial<Record<import('./image-sides.js').ImageSide, import('./image-sides.js').ImageSideDto>>;
  /** 收藏 id。 */
  id: string;
  name: string;
  notes: string;
  tags: string[];
  userId: string;
  shelfName: string;
  processingStatus: ProcessingStatus;
  submissionStatus: SubmissionStatus;
  reviewNote?: string;
  /** 已纳入官方时，指向生成的官方袋子 id。 */
  promotedBagId?: string;
  thumbnailUrl?: string;
  displayImageUrl?: string;
  /** 是否已抠图（有可用 CUTOUT 资产）。 */
  hasCutout: boolean;
  /** 全部可用图片资产的字节数之和，供管理端展示/排序「图片大小」。 */
  byteSize: number;
  addedAt: string;
  reviewedAt?: string;
}

export interface SubmissionPageDto {
  items: SubmissionDto[];
  totalCount: number;
}

/** 管理后台：用户「标记已有」认领官方袋子的记录行。 */
export interface ClaimRowDto {
  id: string;
  userId: string;
  openidMasked: string;
  bagId: string;
  bagName: string;
  brandName?: string;
  collectibleId: string;
  claimedAt: string;
}

export interface ClaimPageDto {
  items: ClaimRowDto[];
  totalCount: number;
}

/** 管理后台：被认领最多的官方袋子排行行。 */
export interface ClaimedBagRankDto {
  bagId: string;
  bagName: string;
  brandName?: string;
  claimCount: number;
  latestClaimedAt: string;
}

export type UpdateUserQuotaInput = z.infer<typeof updateUserQuotaSchema>;

/** 管理后台：用户列表行。openid 脱敏展示，不落完整值给前端。 */
export interface AdminUserSummaryDto {
  id: string;
  openidMasked: string;
  hasUnionid: boolean;
  status: UserStatus;
  collectibleCount: number;
  shelfCount: number;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  lastLoginAt: string;
  createdAt: string;
}

export interface AdminUserPageDto {
  items: AdminUserSummaryDto[];
  totalCount: number;
}

/** 管理后台：用户详情。附带配额与最近收藏（不含图片，避免列表/详情签名开销）。 */
export interface AdminUserDetailDto extends AdminUserSummaryDto {
  unionid?: string;
  collectibleQuota: number;
  dailyMattingQuota: number;
  recentCollectibles: {
    id: string;
    name: string;
    shelfName: string;
    processingStatus: ProcessingStatus;
    addedAt: string;
  }[];
}

export interface AuditLogDto {
  id: string;
  action: string;
  targetId?: string;
  adminId?: string;
  adminUsername?: string;
  userId?: string;
  metadata?: unknown;
  createdAt: string;
}

export interface AuditLogPageDto {
  items: AuditLogDto[];
  totalCount: number;
}

/** 管理后台：图片处理任务行。 */
export interface JobDto {
  id: string;
  type: string;
  status: string;
  attemptCount: number;
  errorMessage?: string;
  /** 关联的收藏（任务列表要显示"在处理哪只袋子"） */
  collectible?: { name: string } | null;
  createdAt: string;
  finishedAt?: string;
}

export interface JobPageDto {
  items: JobDto[];
  totalCount: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * 「版本改动」功能（管理后台菜单）。
 * ReleaseNote 是每次发版的改动记录，正文自由书写；留言挂在其下；PlanItem 是「下期要做什么」的待办。
 */
export const createReleaseSchema = z.object({
  version: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(120),
  content: z.string().max(10_000).optional(),
  status: z.enum(releaseNoteStatuses).optional()
});

export const updateReleaseSchema = createReleaseSchema.partial();

export const createReleaseCommentSchema = z.object({
  content: z.string().trim().min(1).max(2000)
});

export const createPlanItemSchema = z.object({
  title: z.string().trim().min(1).max(200)
});

export const updatePlanItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    done: z.boolean().optional()
  })
  .refine((value) => value.title !== undefined || value.done !== undefined, {
    message: '至少指定一项要更新的内容'
  });

export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;
export type UpdateReleaseInput = z.infer<typeof updateReleaseSchema>;
export type CreateReleaseCommentInput = z.infer<typeof createReleaseCommentSchema>;
export type CreatePlanItemInput = z.infer<typeof createPlanItemSchema>;
export type UpdatePlanItemInput = z.infer<typeof updatePlanItemSchema>;

export interface ReleaseCommentDto {
  id: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface ReleaseNoteDto {
  id: string;
  version: string;
  title: string;
  content: string;
  status: ReleaseNoteStatus;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseNotePageDto {
  items: ReleaseNoteDto[];
  totalCount: number;
}

/** 管理后台「版本改动」页的「改动文档」页签：直接读仓库 docs/ 下的改动记录 md，无需手工录入。 */
export interface ChangelogDocDto {
  /** 文件名，如 CHANGES-2026-10-08.md。 */
  id: string;
  /** 从文件名解析出的日期（YYYY-MM-DD）；文件名里没有日期时为 null，排序时排最后。 */
  date: string | null;
  /** md 正文的第一个一级标题；没有标题时用文件名（去 .md 后缀）。 */
  title: string;
  /** md 全文。 */
  content: string;
}

export interface PlanItemDto {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
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
