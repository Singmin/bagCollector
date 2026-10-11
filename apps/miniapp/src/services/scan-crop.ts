export interface Rect { left: number; top: number; width: number; height: number }
/** Camera preview uses a centered cover projection. Clamp the visible guide to the actual stage. */
export function previewCrop(stage: Rect, guide: Rect, imageWidth: number, imageHeight: number) {
  if (stage.width <= 0 || stage.height <= 0 || imageWidth <= 0 || imageHeight <= 0) throw new Error('无法读取拍摄范围，请重试');
  const scale = Math.max(stage.width / imageWidth, stage.height / imageHeight);
  const width = imageWidth * scale; const height = imageHeight * scale;
  const left = stage.left + (stage.width - width) / 2; const top = stage.top + (stage.height - height) / 2;
  const x0 = Math.max(stage.left, guide.left); const y0 = Math.max(stage.top, guide.top);
  const x1 = Math.min(stage.left + stage.width, guide.left + guide.width); const y1 = Math.min(stage.top + stage.height, guide.top + guide.height);
  if (x1 <= x0 || y1 <= y0) throw new Error('取景框不在画面内，请重试');
  return { x: (x0 - left) / width, y: (y0 - top) / height, width: (x1 - x0) / width, height: (y1 - y0) / height, rotation: 0 };
}
