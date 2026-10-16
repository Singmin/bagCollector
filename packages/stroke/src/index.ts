import sharp from 'sharp';
import { z } from 'zod';

/**
 * 白描边（贴纸效果）的可调参数。
 *
 * 算法口径（与 scripts/preview-stroke.mjs 一致）：
 *   1. 四周扩一圈透明 padding，给描边留出膨胀空间（否则贴边一侧白边被画布裁掉）；
 *   2. 低分辨率把 alpha 通道向外模糊膨胀成「软 alpha」；
 *   3. 用 feDisplacementMap 对软 alpha 做抖动位移，得到手绘不规则轮廓（先位移再锐化，
 *      而不是先硬化再位移 —— 后者会在硬边上产生像素级锯齿）；
 *   4. 放大回原尺寸；最后在原尺寸硬化成锐边（soften=false）或放大插值柔化（soften=true）。
 */
export interface StrokeParams {
  /** 描边宽度占短边的比例（0.01~0.3） */
  ratio: number;
  /** 手绘波浪频率（越大波浪越碎） */
  baseFrequency: number;
  /** 波浪起伏幅度系数（× 描边宽度，0=无起伏） */
  wobble: number;
  /** 是否柔化边缘（false=锐利硬边） */
  soften: boolean;
  /** 降采样倍数（越大越平滑，越小越锐利） */
  down: number;
}

export const DEFAULT_STROKE_PARAMS: StrokeParams = {
  ratio: 0.08,
  baseFrequency: 0.02,
  wobble: 0.3,
  soften: false,
  down: 2
};

export const strokeParamsSchema = z.object({
  ratio: z.number().min(0).max(0.3),
  baseFrequency: z.number().min(0.005).max(0.2),
  wobble: z.number().min(0).max(1),
  soften: z.boolean(),
  down: z.number().int().min(1).max(8)
});

/** 判断图片是否带透明通道（描边只作用于抠图结果）。 */
export async function hasAlpha(source: Buffer): Promise<boolean> {
  const meta = await sharp(source).metadata();
  return meta.hasAlpha === true;
}

/** 白底描边剪影（不含原图），供预览等场景单独叠加。 */
function whiteSilhouette(width: number, height: number, alpha: Buffer): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
}

/**
 * 给透明抠图加一圈手绘感白描边。
 * 输入无 alpha 通道时原样返回（防御：描边只作用于抠图结果）。
 */
export async function addWhiteStroke(source: Buffer, params: StrokeParams): Promise<Buffer> {
  const meta = await sharp(source).metadata();
  if (!meta.hasAlpha || !meta.width || !meta.height) return source;

  const shortSide = Math.min(meta.width, meta.height);
  const strokePx = Math.max(2, Math.round(shortSide * params.ratio));
  // 描边宽度 + 手绘位移余量，保证贴边方向也有完整白边
  const pad = Math.ceil(strokePx * 2);
  const padded = await sharp(source)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const W = meta.width + pad * 2;
  const H = meta.height + pad * 2;

  const down = params.down;
  const w = Math.max(64, Math.round(W / down));
  const h = Math.max(64, Math.round(H / down));
  const sigma = Math.max(0.5, (strokePx / down) / 2);

  const alpha = await sharp(padded).resize(w, h).extractChannel('alpha').toBuffer();
  const blurred = await sharp(alpha).blur(sigma).png().toBuffer();
  const blurredGray = await sharp(blurred).extractChannel('red').toBuffer();
  // lighten 即逐通道取 max：主体内部保持不透明，外侧是向外淡出的软 alpha
  const soft = await sharp(blurredGray).composite([{ input: alpha, blend: 'lighten' }]).toBuffer();
  // 白色剪影 + 软 alpha，交给 feDisplacementMap 抖动出手绘不规则轮廓（保持渐变）
  const softSil = await whiteSilhouette(w, h, soft);

  const scale = Math.max(2, Math.round((strokePx * params.wobble) / down));
  const b64 = softSil.toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <filter id="hand" x="-40%" y="-40%" width="180%" height="180%">
        <feTurbulence type="fractalNoise" baseFrequency="${params.baseFrequency}" numOctaves="3" seed="7" result="noise"/>
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
    </defs>
    <image href="data:image/png;base64,${b64}" x="0" y="0" width="${w}" height="${h}" filter="url(#hand)"/>
  </svg>`;
  const displacedLow = await sharp(Buffer.from(svg)).png().toBuffer();

  const silhouette = params.soften
    ? await softenSilhouette(displacedLow, W, H)
    : await hardenSilhouette(displacedLow, W, H);

  return sharp(silhouette).composite([{ input: padded }]).png().toBuffer();
}

/** 锐边：放大回原尺寸后，在原尺寸硬阈值 —— 轮廓不规则但边界平滑，1px 硬边不羽化。 */
async function hardenSilhouette(displacedLow: Buffer, W: number, H: number): Promise<Buffer> {
  const displaced = await sharp(displacedLow).resize(W, H).png().toBuffer();
  const displacedAlpha = await sharp(displaced).extractChannel('alpha').toBuffer();
  const mask = await sharp(displacedAlpha).threshold(8).extractChannel('red').toBuffer();
  return whiteSilhouette(W, H, mask);
}

/** 柔边：低分辨率硬阈值后放大回原尺寸，插值带来轻微柔和过渡（约 down 像素）。 */
async function softenSilhouette(displacedLow: Buffer, W: number, H: number): Promise<Buffer> {
  const maskLow = await sharp(displacedLow).extractChannel('alpha').threshold(8).extractChannel('red').toBuffer();
  const mask = await sharp(maskLow).resize(W, H).toBuffer();
  return whiteSilhouette(W, H, mask);
}
