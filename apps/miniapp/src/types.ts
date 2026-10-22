import type { ImageSide, ImageSideDto } from '../../../packages/contracts/src/image-sides';
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
  imageRevision?: string;
  imageEditable?: boolean;
  sourceOfficialBagId?: string;
  id: string;
  name: string;
  shelfId: string;
  shelfName: string;
  /** 同款袋子拥有数量：>1 时卡片右上角显示 ×N 角标（feed/心愿条目没有该字段） */
  quantity?: number;
  /** 可见性：私密收藏 / 公开展示（feed/心愿条目没有该字段） */
  visibility?: 'PRIVATE' | 'PUBLIC';
  processingStatus: ProcessingStatus;
  thumbnailUrl?: string;
  /** 无白边版缩略图：仅「加了白边」的透明口径返回；缺失时前端回退 thumbnailUrl。 */
  thumbnailUrlPlain?: string;
  /** 摘要级 B 面缩略图：有值即表示存在已发布的 B 面，详情卡直接按 A/B 布局打开 */
  backThumbnailUrl?: string;
  /** 摘要级 B 面无白边缩略图：与 backThumbnailUrl 对应，缺失回退 backThumbnailUrl。 */
  backThumbnailUrlPlain?: string;
  addedAt: string;
  updatedAt: string;
  /** 发现页 feed 条目的主人昵称（官方精选时为品牌名）；自己的收藏没有该字段 */
  ownerName?: string;
  /** 仅 feed / 心愿袋条目返回：当前用户已认领该官方袋子时，值为认领生成的收藏 id。
      陈列页据此恢复「标记已有」已标记态（再点弹删除确认）——服务端持久真值，刷新不丢 */
  myCollectibleId?: string;
}

export interface Collectible extends CollectibleSummary {
  sides?: Partial<Record<ImageSide, ImageSideDto>>;
  notes: string;
  tags: string[];
  processingError?: string;
  displayImageUrl?: string;
  /** 无白边版展示图：仅「加了白边」的透明口径返回；缺失时前端回退 displayImageUrl。 */
  displayImageUrlPlain?: string;
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

/** 拥有官方袋子（发现页「标记已有」）的结果：收藏立即引用官方图片。 */
export interface OfficialClaimResult {
  collectibleId: string;
  processingStatus: ProcessingStatus;
  /** 叠加后的同款数量：再次认领已拥有袋子时返回（首次认领为 1） */
  quantity?: number;
  /** true = 本次为「再次认领」：不新建收藏，只叠加数量 */
  alreadyOwned?: boolean;
}

export interface UploadPolicy {
  assetId: string;
  key: string;
  uploadUrl: string;
  expiresAt: string;
  formData: Record<string, string>;
}

/* ── 逛袋子页：官方袋子的品牌分类与袋子数据（GET /official-bags）── */
export interface Brand {
  id: string;
  name: string;
  /** 品牌展示图（logo）：品牌管理上传，未上传时缺省 */
  displayImageUrl?: string;
  /** 旗下可见袋子数量 */
  bagCount: number;
}

export interface OfficialBag {
  sides?: Partial<Record<ImageSide, ImageSideDto>>;
  imageRevision?: string;
  id: string;
  name: string;
  brandId?: string;
  brand?: string;
  notes: string;
  tags: string[];
  claimedCount: number;
  thumbnailUrl?: string;
  displayImageUrl?: string;
  /** 无白边版缩略图/展示图：仅「加了白边」的透明口径返回；缺失时前端回退有白边版。 */
  thumbnailUrlPlain?: string;
  displayImageUrlPlain?: string;
  /** 当前用户是否已拥有该袋子 */
  claimed?: boolean;
  publishedAt?: string;
  updatedAt: string;
}

export interface OfficialBagPage {
  items: OfficialBag[];
  nextCursor: string | null;
  totalCount: number;
  /** 当前用户已拥有的官方袋子总数（全量，不受列表筛选/分页影响）。 */
  ownedCount: number;
}

/* ── 拍照扫描袋子：拿刚拍的照片比对官方袋子库 ── */

/** 匹配结果的三种形态：
 *  MATCHED    相似度足够高，直接入库（用户零操作）
 *  CANDIDATES 有几个相近的，交给用户点选
 *  NONE       都不像，视为官方库没有这只袋子
 */
export type OfficialBagMatchResult = 'MATCHED' | 'CANDIDATES' | 'NONE';

export interface OfficialBagMatchCandidate {
  bag: OfficialBag;
  /** 余弦相似度：用于排查与调阈值，UI 不展示 */
  score: number;
}

export interface OfficialBagMatch {
  result: OfficialBagMatchResult;
  matched?: OfficialBag;
  candidates?: OfficialBagMatchCandidate[];
  /** 本次实际参与比对的官方袋子数（0 = 库为空或向量未生成） */
  compared: number;
}

export interface MatchScan {
  scanId: string; stage: 'QUEUED' | 'RECOGNIZING' | 'ENHANCING' | 'DONE' | 'FAILED';
  reason?: string; enhancement: string; elapsedMs?: number; compared: number;
  result: 'CANDIDATES' | 'NONE'; candidates: OfficialBagMatchCandidate[];
}
