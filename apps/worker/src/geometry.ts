export interface NormalizedCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeCropRect(imageWidth: number, imageHeight: number, crop: NormalizedCrop): PixelCrop {
  const left = Math.max(0, Math.floor(imageWidth * crop.x));
  const top = Math.max(0, Math.floor(imageHeight * crop.y));
  const right = Math.min(imageWidth, Math.ceil(imageWidth * (crop.x + crop.width)));
  const bottom = Math.min(imageHeight, Math.ceil(imageHeight * (crop.y + crop.height)));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}
