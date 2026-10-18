export const imageSides = ['FRONT', 'BACK'] as const;
export type ImageSide = typeof imageSides[number];
export interface ImageCrop {
  x: number; y: number; width: number; height: number; rotation: number;
  brightness?: number; contrast?: number; saturation?: number;
}
export interface ImageSideDto {
  side: ImageSide;
  sourceVersion: number;
  processingVersion: number;
  publishedVersion: number | null;
  processingStatus: string;
  processingError?: string;
  thumbnailUrl?: string;
  displayImageUrl?: string;
  /** 无白边版缩略图/展示图：仅「加了白边」的透明口径会额外派生；白底实拍图没有该字段，前端回退到有白边版。 */
  thumbnailUrlPlain?: string;
  displayImageUrlPlain?: string;
  standardImageUrl?: string;
  cutoutImageUrl?: string;
  crop?: ImageCrop;
  matted?: boolean;
  matting?: boolean;
}
export interface SideState {
  side: ImageSide;
  sourceVersion: number;
  processingVersion: number;
  publishedVersion: number | null;
}
export function imageRevision(sourceId: string, states: readonly SideState[]): string {
  return `${sourceId}:${imageSides.map(side => {
    const state = states.find(s => s.side === side);
    return `${side}:${state?.publishedVersion ?? '-'}:${state?.sourceVersion ?? 0}`;
  }).join(':')}`;
}
/** Renditions must come from one committed version. STANDARD follows the current source. */
export function selectSideAssets<T extends { side?: ImageSide; kind: string; version: number }>(
  assets: readonly T[], state: SideState
): Partial<Record<string, T>> {
  const selected: Partial<Record<string, T>> = {};
  for (const asset of assets) {
    if ((asset.side ?? 'FRONT') !== state.side) continue;
    const wanted = asset.kind === 'STANDARD' || asset.kind === 'ORIGINAL'
      ? state.sourceVersion : state.publishedVersion;
    if (wanted !== null && asset.version === wanted) selected[asset.kind] = asset;
  }
  return selected;
}
