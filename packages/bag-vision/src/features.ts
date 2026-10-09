import sharp from 'sharp';

/* ── 工作分辨率与特征分块 ───────────────────────────────────────────────
   预处理之后的一切都在这套常量上计算。任何一块的维度变了，都必须同步改
   BAG_FEATURE_MODEL —— 因为模型标识就是向量的坐标系，坐标系换了而标识
   没换，新旧向量会被当成同一套混着比对，结果静默错乱。 */
const WORK = 128; // 预处理后的工作画布边长
const H_BINS = 16; // 色相分箱
const S_BINS = 4; // 饱和度分箱
const V_BINS = 4; // 明度分箱
const GRID = 4; // 空间布局网格（4×4）
const COARSE = 8; // 粗结构灰度缩略（8×8）

const COLOR_DIM = H_BINS * S_BINS * V_BINS; // 256：HSV 联合直方图（主力）
const LAYOUT_DIM = GRID * GRID * 4; // 64：每格平均色相(sin/cos)+饱和度+明度
const STRUCT_DIM = COARSE * COARSE; // 64：粗结构（灰度减均值）
const STATS_DIM = 5; // 平均饱和度/平均明度/饱和度标准差/边缘密度/宽高比

/** 解码像素上限：挡住超大图拖垮内存与解码。与 worker 的 MAX_IMAGE_PIXELS 默认值一致。 */
const DEFAULT_MAX_PIXELS = 60_000_000;

/**
 * 袋子图的视觉特征：「拍照扫描袋子」做以图搜图的基础。
 *
 * 这个包被 API 与 worker **共用**，这不是代码复用的洁癖，而是正确性的前提 ——
 * 官方袋子的向量由 worker 写入、用户拍照的查询向量由 API 计算，两侧只要预处理
 * 口径不一致，特征分布就不可比，相似度会直接失效。放在同一个包里，「两边同一份
 * 实现」由模块结构保证，而不是靠人记得同步改两处。
 *
 * 设计取舍：
 *
 * 1. **特征以颜色为主导。** 袋子这类物品同款之间颜色分布高度一致、不同款往往
 *    颜色有别，这是最可靠的判别信号；再叠加空间布局（谁在中间、谁在边缘）与
 *    粗结构，用来区分「颜色相近但不是同一款」。也正因如此，先不上深度学习模型：
 *    在「用户按取景框拍照」这个前提下，颜色+布局已经能扛住大部分场景。
 *
 * 2. **纯本地计算，零模型权重、零外部 API。** 手写像素循环换来的是部署确定性
 *    （本机与国内服务器都不需要拉模型权重）。将来若要升级成 CLIP / DINOv2，
 *    只需在这里换实现并改 BAG_FEATURE_MODEL —— 对账任务会按新 model id 把全部
 *    向量重算，无需停机、也无需改调用方。
 */

export interface BagFeatureOptions {
  /** 输入像素上限，超过直接解码失败，避免超大图吃满内存。 */
  maxPixels?: number;
}

export interface BagFeatureExtractor {
  /** 模型标识，写入数据库用于区分向量坐标系。换实现 = 换此值。 */
  readonly id: string;
  /** 向量维度，写入库前用于自检。 */
  readonly dim: number;
  /** 从任意图片 buffer 提取 **已 L2 归一化** 的特征向量。 */
  extract(source: Buffer, options?: BagFeatureOptions): Promise<Float32Array>;
}

export const BAG_FEATURE_MODEL = 'color-layout-v1';
export const BAG_FEATURE_DIM = COLOR_DIM + LAYOUT_DIM + STRUCT_DIM + STATS_DIM;

/** 各分块在全向量里的权重：颜色为主，其余作为分辨「同色不同款」的补充信号。 */
const WEIGHT = {
  color: 1,
  layout: 0.7,
  struct: 0.5,
  stats: 0.5
} as const;

/** 判定「背景像素」的阈值：接近纯白且几乎无色相 —— contain 补的白边与纯白底都会落到这里。 */
const BG_MIN_VALUE = 0.94;
const BG_MAX_SATURATION = 0.06;

function rgbToHsv(r: number, g: number, b: number): [h: number, s: number, v: number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 1e-6) {
    if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / delta + 2) / 6;
    else h = ((r - g) / delta + 4) / 6;
  }
  const s = max <= 1e-6 ? 0 : delta / max;
  return [h, s, max];
}

/**
 * 把图片拉到统一的「特征起点」：EXIF 转正 → 去单色边 → 等比缩放到工作画布并居中补白。
 *
 * 去边对官方图几乎总能把画面收拢到袋子轮廓（白底/透明底），对实拍图则常常无从下刀
 * （背景是桌面、床铺这类杂色）。这不影响正确性 —— 后面还有 contain 居中收敛，且
 * 直方图会剔除近白背景像素。真正要靠的是拍摄时那个取景框。
 */
async function toWorkPixels(source: Buffer, maxPixels: number): Promise<{ pixels: Buffer; aspect: number }> {
  const rotated = await sharp(source, { limitInputPixels: maxPixels }).rotate().toBuffer();

  let body = rotated;
  try {
    const trimmed = await sharp(rotated, { limitInputPixels: maxPixels })
      .trim({ background: { r: 255, g: 255, b: 255 }, threshold: 22 })
      .toBuffer();
    const meta = await sharp(trimmed, { limitInputPixels: maxPixels }).metadata();
    if (meta.width && meta.height) body = trimmed;
  } catch {
    // 「整张图都是背景色」等情况 trim 会抛错，回退原图即可，不阻断提取。
  }

  const meta = await sharp(body, { limitInputPixels: maxPixels }).metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;

  const { data } = await sharp(body, { limitInputPixels: maxPixels })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(WORK, WORK, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  /* 宽高比夹在 [1/3, 3]：长条形购物袋与方正纸袋有这个量级的差别就够判别了，
     再极端的比例（卷起来的袋子、超长条）不该靠这一维主导结果。 */
  const aspect = Math.min(3, Math.max(1 / 3, width / Math.max(1, height)));
  return { pixels: data, aspect };
}

export async function extractBagFeature(source: Buffer, options: BagFeatureOptions = {}): Promise<Float32Array> {
  const { pixels, aspect } = await toWorkPixels(source, options.maxPixels ?? DEFAULT_MAX_PIXELS);
  const total = WORK * WORK;
  const vector = new Float32Array(BAG_FEATURE_DIM);

  const color = new Float32Array(COLOR_DIM);
  const layout = new Float32Array(LAYOUT_DIM);
  const struct = new Float32Array(STRUCT_DIM);
  const stats = new Float32Array(STATS_DIM);

  const cell = WORK / GRID; // 每格边长
  const coarseCell = WORK / COARSE;

  /* 空间布局用「色相的 sin/cos 双分量」而不是直接取角度：色相是环形的，
     359° 与 1° 本该最接近，直接取平均会得到 180° 这种完全相反的结论。 */
  const layoutHueSin = new Float64Array(GRID * GRID);
  const layoutHueCos = new Float64Array(GRID * GRID);
  const layoutSat = new Float64Array(GRID * GRID);
  const layoutVal = new Float64Array(GRID * GRID);
  const layoutCount = new Float64Array(GRID * GRID);
  const coarseSum = new Float64Array(STRUCT_DIM);
  const coarseCount = new Float64Array(STRUCT_DIM);

  let foreground = 0;
  let satSum = 0;
  let valSum = 0;
  let satSqSum = 0;
  let edgeSum = 0;
  let edgeCount = 0;

  const gray = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const o = i * 3;
    const r = pixels[o] / 255;
    const g = pixels[o + 1] / 255;
    const b = pixels[o + 2] / 255;
    gray[i] = r * 0.299 + g * 0.587 + b * 0.114;
  }

  for (let y = 0; y < WORK; y += 1) {
    for (let x = 0; x < WORK; x += 1) {
      const i = y * WORK + x;
      const o = i * 3;
      const r = pixels[o] / 255;
      const g = pixels[o + 1] / 255;
      const b = pixels[o + 2] / 255;
      const [h, s, v] = rgbToHsv(r, g, b);

      // 粗结构：每一格累加灰度，最后减均值只保留相对明暗
      const ci =
        Math.min(COARSE - 1, Math.floor(y / coarseCell)) * COARSE + Math.min(COARSE - 1, Math.floor(x / coarseCell));
      coarseSum[ci] += gray[i];
      coarseCount[ci] += 1;

      // 边缘密度：与右邻、下邻的灰度差
      if (x + 1 < WORK) {
        edgeSum += Math.abs(gray[i + 1] - gray[i]);
        edgeCount += 1;
      }
      if (y + 1 < WORK) {
        edgeSum += Math.abs(gray[i + WORK] - gray[i]);
        edgeCount += 1;
      }

      const background = v > BG_MIN_VALUE && s < BG_MAX_SATURATION;
      if (background) continue;

      foreground += 1;
      satSum += s;
      valSum += v;
      satSqSum += s * s;

      const hi = Math.min(H_BINS - 1, Math.floor(h * H_BINS));
      const si = Math.min(S_BINS - 1, Math.floor(s * S_BINS));
      const vi = Math.min(V_BINS - 1, Math.floor(v * V_BINS));
      color[(hi * S_BINS + si) * V_BINS + vi] += 1;

      const gi = Math.min(GRID - 1, Math.floor(y / cell)) * GRID + Math.min(GRID - 1, Math.floor(x / cell));
      const angle = h * Math.PI * 2;
      layoutHueSin[gi] += Math.sin(angle);
      layoutHueCos[gi] += Math.cos(angle);
      layoutSat[gi] += s;
      layoutVal[gi] += v;
      layoutCount[gi] += 1;
    }
  }

  /* 前景像素过少（几乎整张都是背景/白底）说明这张图没有可用信号。此时若继续拼装，
     最终向量会被「宽高比」这类与"是什么袋子"无关的杂项主导，产生一个看似正常、
     实则误导的向量。不如明确给哨兵，让它对谁都不像。 */
  if (foreground < total * 0.02) {
    vector[0] = 1;
    return vector;
  }

  // ── 颜色直方图：按前景像素数做 L1 归一化，得到「颜色占比分布」 ──
  for (let i = 0; i < COLOR_DIM; i += 1) color[i] /= foreground;

  // ── 空间布局：每格 4 维（色相 sin/cos、饱和度均值、明度均值） ──
  for (let i = 0; i < GRID * GRID; i += 1) {
    const count = layoutCount[i];
    if (count <= 0) continue;
    layout[i * 4] = layoutHueSin[i] / count;
    layout[i * 4 + 1] = layoutHueCos[i] / count;
    layout[i * 4 + 2] = layoutSat[i] / count;
    layout[i * 4 + 3] = layoutVal[i] / count;
  }

  // ── 粗结构：每格灰度减全局均值，只保留相对明暗（对整体曝光变化不敏感） ──
  let grayMean = 0;
  for (let i = 0; i < STRUCT_DIM; i += 1) grayMean += coarseCount[i] > 0 ? coarseSum[i] / coarseCount[i] : 0;
  grayMean /= STRUCT_DIM;
  for (let i = 0; i < STRUCT_DIM; i += 1) {
    struct[i] = (coarseCount[i] > 0 ? coarseSum[i] / coarseCount[i] : 0) - grayMean;
  }

  // ── 统计量 ──
  const satMean = foreground > 0 ? satSum / foreground : 0;
  const valMean = foreground > 0 ? valSum / foreground : 0;
  const satVariance = foreground > 0 ? Math.max(0, satSqSum / foreground - satMean * satMean) : 0;
  stats[0] = satMean;
  stats[1] = valMean;
  stats[2] = Math.sqrt(satVariance);
  stats[3] = edgeCount > 0 ? edgeSum / edgeCount : 0;
  stats[4] = (aspect - 1 / 3) / (3 - 1 / 3); // 归一到 [0,1]

  /* 各分块先各自归一化再按权重拼装：分块内部量纲差异很大（直方图是概率、
     统计量是原值），不分别归一化的话权重就形同虚设。 */
  const normalize = (block: Float32Array, weight: number, offset: number) => {
    let norm = 0;
    for (let i = 0; i < block.length; i += 1) norm += block[i] * block[i];
    norm = Math.sqrt(norm);
    if (norm < 1e-6) return; // 该分块无信息（如全白图），整体留 0
    for (let i = 0; i < block.length; i += 1) vector[offset + i] = (block[i] / norm) * weight;
  };

  normalize(color, WEIGHT.color, 0);
  normalize(layout, WEIGHT.layout, COLOR_DIM);
  normalize(struct, WEIGHT.struct, COLOR_DIM + LAYOUT_DIM);
  normalize(stats, WEIGHT.stats, COLOR_DIM + LAYOUT_DIM + STRUCT_DIM);

  // 整体 L2 归一化：之后比对时点积即余弦相似度
  let total2 = 0;
  for (let i = 0; i < vector.length; i += 1) total2 += vector[i] * vector[i];
  const length = Math.sqrt(total2);
  if (length < 1e-6) {
    // 整张图都是背景（全白/全透明）：没有任何可用信号，给一个确定的哨兵向量，
    // 让它在比对时对谁都相似度极低，而不是产生 NaN 把整轮匹配带崩。
    vector[0] = 1;
    return vector;
  }
  for (let i = 0; i < vector.length; i += 1) vector[i] /= length;
  return vector;
}

export const bagFeatures: BagFeatureExtractor = {
  id: BAG_FEATURE_MODEL,
  dim: BAG_FEATURE_DIM,
  extract: extractBagFeature
};
