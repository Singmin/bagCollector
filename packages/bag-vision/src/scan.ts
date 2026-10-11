import sharp from 'sharp';
import { BAG_FEATURE_DIM, extractBagFeature } from './features.js';
import { cosineSimilarity } from './similarity.js';

export const SCAN_PREPROCESS_VERSION = 'rgb-contain224-v1';
export const DINO_CHECKPOINT_REVISION = 'ed25f3a31f01632728cabb09d1542f84ab7b0056';
export const DINO_SCAN_MODEL = `dinov2-small-ed25f3a-cls-${SCAN_PREPROCESS_VERSION}`;
export const COLOR_SCAN_MODEL = `color-layout-${SCAN_PREPROCESS_VERSION}`;
export interface ScanCrop { x: number; y: number; width: number; height: number; rotation?: number }
export interface ScanSettings {
  engine: 'color' | 'dino'; candidateThreshold: number; candidateLimit: number;
  visualWeight: number; enhancementEnabled: boolean; enhancementSkipThreshold: number;
  enhancementMinGap: number; dailyUserEnhancements: number; dailyGlobalEnhancements: number;
}
export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  engine: 'color', candidateThreshold: 0.60, candidateLimit: 5, visualWeight: 0.90,
  enhancementEnabled: true, enhancementSkipThreshold: 0.80, enhancementMinGap: 0.05,
  dailyUserEnhancements: 5, dailyGlobalEnhancements: 100
};

/** Preserve the source; crop only a derived buffer in EXIF-corrected coordinates. */
export async function cropScanImage(source: Buffer, crop?: ScanCrop, maxPixels = 60_000_000): Promise<Buffer> {
  let body = await sharp(source, { limitInputPixels: maxPixels }).rotate().toColourspace('srgb').ensureAlpha().png().toBuffer();
  if (!crop) return body;
  if (crop.rotation) body = await sharp(body).rotate(crop.rotation, { background: '#ffffff' }).png().toBuffer();
  const meta = await sharp(body).metadata();
  const width = meta.width!; const height = meta.height!;
  const left = Math.max(0, Math.min(width - 1, Math.floor(crop.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(crop.y * height)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil((crop.x + crop.width) * width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil((crop.y + crop.height) * height)));
  return sharp(body).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
}

/** One shared preprocessing contract for queries and references. Never stretch or center-crop. */
export async function normalizeScanImage(source: Buffer, maxPixels = 60_000_000): Promise<Buffer> {
  let body = await cropScanImage(source, undefined, maxPixels);
  const { data, info } = await sharp(body).raw().toBuffer({ resolveWithObject: true });
  let left = info.width; let top = info.height; let right = -1; let bottom = -1;
  let transparent = false;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const alpha = data[(y * info.width + x) * 4 + 3];
    if (alpha < 255) transparent = true;
    if (alpha >= 16) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  if (right < left) throw new Error('图片没有可识别的主体');
  if (transparent) body = await sharp(body).extract({ left, top, width: right - left + 1, height: bottom - top + 1 }).png().toBuffer();
  else {
    try { body = await sharp(body).trim({ background: '#ffffff', threshold: 22 }).png().toBuffer(); } catch { /* solid backgrounds are checked below */ }
  }
  const normalized = await sharp(body).flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb')
    .resize(208, 208, { fit: 'contain', background: '#ffffff' }).extend({ top: 8, bottom: 8, left: 8, right: 8, background: '#ffffff' }).png().toBuffer();
  const stats = await sharp(normalized).stats();
  if (stats.channels.every(c => c.min >= 242)) throw new Error('图片没有可识别的主体');
  return normalized;
}

export interface ScanFeature { vector: number[]; colorVector: number[] }
export async function extractScanFeature(source: Buffer, engine: 'color' | 'dino', serviceUrl?: string, maxPixels?: number): Promise<ScanFeature> {
  const normalized = await normalizeScanImage(source, maxPixels);
  const colorVector = Array.from(await extractBagFeature(normalized, maxPixels === undefined ? {} : { maxPixels }));
  if (colorVector.length !== BAG_FEATURE_DIM || !colorVector.every(Number.isFinite)) throw new Error('颜色特征无效');
  if (engine === 'color') return { vector: colorVector, colorVector };
  if (!serviceUrl) throw new Error('视觉模型服务未配置');
  const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/embed`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(normalized), signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`视觉模型服务不可用（${response.status}）`);
  const result = await response.json() as { model: string; vector: number[] };
  if (result.model !== DINO_SCAN_MODEL || result.vector?.length !== 384 || !result.vector.every(Number.isFinite)) throw new Error('视觉模型版本或维度不一致');
  const norm = Math.sqrt(result.vector.reduce((sum, x) => sum + x * x, 0));
  if (Math.abs(norm - 1) > 0.001) throw new Error('视觉特征未归一化');
  return { vector: result.vector, colorVector };
}

export interface ScanEntry extends ScanFeature { officialBagId: string }
export interface ScanScore { bagId: string; score: number }
export function rankScanCandidates(queries: ScanFeature[], entries: ScanEntry[], settings: ScanSettings): ScanScore[] {
  const best = new Map<string, number>();
  for (const entry of entries) for (const query of queries) {
    if (query.vector.length !== entry.vector.length || query.colorVector.length !== entry.colorVector.length) continue;
    const visual = cosineSimilarity(query.vector, entry.vector);
    const color = cosineSimilarity(query.colorVector, entry.colorVector);
    const score = settings.engine === 'dino' ? settings.visualWeight * visual + (1 - settings.visualWeight) * color : visual;
    if (Number.isFinite(score)) best.set(entry.officialBagId, Math.max(best.get(entry.officialBagId) ?? -1, score));
  }
  return [...best].map(([bagId, score]) => ({ bagId, score })).sort((a, b) => b.score - a.score || a.bagId.localeCompare(b.bagId)).slice(0, 10);
}
export function needsScanEnhancement(scores: ScanScore[], settings: ScanSettings): boolean {
  return settings.enhancementEnabled && (!scores.length || scores[0].score < settings.enhancementSkipThreshold ||
    (scores.length > 1 && scores[0].score - scores[1].score < settings.enhancementMinGap));
}
export function scanCandidates(scores: ScanScore[], settings: ScanSettings): ScanScore[] {
  return scores.filter(s => s.score >= settings.candidateThreshold).slice(0, settings.candidateLimit);
}
