import { formattedDate, daysAgoText } from './format';

/* 微信小程序专属能力（uni-app 类型未收录 createOffscreenCanvas / showShareImageMenu），
   直接访问运行时全局 wx。 */
declare const wx: any;

export interface SharePosterPayload {
  name: string;
  brand: string;
  addedAt: string;
  imageUrl: string;
  isWish?: boolean;
}

/* 模板与画布：画布取模板 2 倍，保证分享到聊天后依旧清晰 */
const TEMPLATE_SRC = '/static/share/share-card-1-1.png';
const TEMPLATE_WIDTH = 318;
const TEMPLATE_HEIGHT = 512;
const SCALE = 2;
const CANVAS_WIDTH = TEMPLATE_WIDTH * SCALE;
const CANVAS_HEIGHT = TEMPLATE_HEIGHT * SCALE;

/* 黄框内卡片区（奶油色方形区域，量取自模板像素：x 41..276, y 67..302）。 */
const FRAME = { x: 41, y: 67, width: 236, height: 236 };
/* 袋子图在框内居中，四周留边让金色边框露出来 */
const FRAME_PADDING = 16;

/* 文案配色：深暖棕，在金色底上保证可读性 */
const COLOR_NAME = '#2e1f08';
const COLOR_SECONDARY = '#5a3f10';
const COLOR_WATERMARK = '#6b4c08';

function getImageInfo(src: string): Promise<{ width: number; height: number; path: string }> {
  return new Promise((resolve, reject) => {
    uni.getImageInfo({
      src,
      success: (result) => resolve(result),
      fail: (error: any) => reject(new Error(error?.errMsg || '图片加载失败')),
    });
  });
}

function loadImage(canvas: any, src: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}

function drawBag(ctx: any, image: any, imageWidth: number, imageHeight: number) {
  const box = {
    x: FRAME.x + FRAME_PADDING,
    y: FRAME.y + FRAME_PADDING,
    width: FRAME.width - FRAME_PADDING * 2,
    height: FRAME.height - FRAME_PADDING * 2,
  };
  const ratio = Math.min(box.width / imageWidth, box.height / imageHeight);
  const drawWidth = imageWidth * ratio;
  const drawHeight = imageHeight * ratio;
  const dx = box.x + (box.width - drawWidth) / 2;
  const dy = box.y + (box.height - drawHeight) / 2;
  ctx.drawImage(image, dx, dy, drawWidth, drawHeight);
}

function fitText(ctx: any, text: string, font: string, maxWidth: number): string {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
}

function drawCopy(ctx: any, payload: SharePosterPayload) {
  const centerX = TEMPLATE_WIDTH / 2;
  const dateLabel = payload.isWish ? '上架日期' : '收藏日期';
  const durationLabel = payload.isWish ? '上架天数' : '入库时长';
  const date = formattedDate(payload.addedAt, '-');
  const duration = daysAgoText(payload.addedAt);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const name = fitText(ctx, payload.name, '600 22px Georgia, "Songti SC", serif', 250);
  ctx.fillStyle = COLOR_NAME;
  ctx.font = '600 22px Georgia, "Songti SC", serif';
  ctx.fillText(name, centerX, 356);

  const brand = fitText(ctx, payload.brand, '13px sans-serif', 250);
  ctx.fillStyle = COLOR_SECONDARY;
  ctx.font = '13px sans-serif';
  ctx.fillText(brand, centerX, 386);

  ctx.strokeStyle = 'rgba(90,63,16,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(centerX - 40, 408);
  ctx.lineTo(centerX + 40, 408);
  ctx.stroke();

  ctx.fillStyle = COLOR_SECONDARY;
  ctx.font = '13px sans-serif';
  ctx.fillText(`${dateLabel}  ${date}`, centerX, 438);
  ctx.fillText(`${durationLabel}  ${duration}`, centerX, 462);

  ctx.fillStyle = COLOR_WATERMARK;
  ctx.font = '11px sans-serif';
  ctx.fillText('@袋袋集 · 2026', centerX, 494);
}

function exportCanvas(canvas: any): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      x: 0,
      y: 0,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      destWidth: CANVAS_WIDTH,
      destHeight: CANVAS_HEIGHT,
      fileType: 'png',
      success: (result: any) => resolve(result.tempFilePath),
      fail: (error: any) => reject(new Error(error?.errMsg || '图片生成失败')),
    });
  });
}

export async function generateSharePoster(payload: SharePosterPayload): Promise<string> {
  if (typeof wx === 'undefined' || !wx.createOffscreenCanvas) {
    throw new Error('当前微信版本过低，无法生成分享图');
  }
  if (!payload.imageUrl) throw new Error('还没有可分享的袋子图片');

  /* 袋子图是远程 CDN 图：getImageInfo 负责下载并返回本地临时路径 + 宽高。
     模板图不能走 getImageInfo —— 它不认代码包内路径，会把 /static/... 当成
     网络 URL 请求（实测 500）；canvas.createImage 直接支持包内路径。 */
  const bagInfo = await getImageInfo(payload.imageUrl);

  const canvas = wx.createOffscreenCanvas({ type: '2d', width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);

  const [templateImage, bagImage] = await Promise.all([
    loadImage(canvas, TEMPLATE_SRC),
    loadImage(canvas, bagInfo.path),
  ]);

  ctx.drawImage(templateImage, 0, 0, TEMPLATE_WIDTH, TEMPLATE_HEIGHT);
  drawBag(ctx, bagImage, bagInfo.width, bagInfo.height);
  drawCopy(ctx, payload);

  return exportCanvas(canvas);
}

/** 直接调起微信「发送给朋友」图片分享面板；用户主动取消时不打扰。 */
export function shareImageToFriend(path: string) {
  if (typeof wx === 'undefined' || !wx.showShareImageMenu) {
    uni.showToast({ title: '当前微信版本过低，无法分享', icon: 'none' });
    return;
  }
  wx.showShareImageMenu({
    path,
    fail: (error: any) => {
      if (error?.errMsg?.includes('cancel')) return;
      uni.showToast({ title: '分享失败，请重试', icon: 'none' });
    },
  });
}
