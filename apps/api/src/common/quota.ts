import { ProcessingStatus } from '@prisma/client';

/** 收藏配额统计口径：只统计真正会出现在收藏架（或即将出现）的收藏 ——
 *  READY（已就绪）+ NORMALIZING / CROPPING / MATTING（处理中，马上变 READY）。
 *
 *  排除三类「收藏列表里不可见、却会悄悄吃掉配额」的记录：
 *   · UPLOADING —— 只建了记录、图片还没传（旧版「标记已有」僵尸 / 上传半路放弃）
 *   · AWAITING_CROP —— 图已传、但停在裁剪页没点「确定添加」
 *   · FAILED —— 处理失败
 *  否则这些隐身记录会把配额从「收藏统计」之外的暗处顶满，挡住用户继续拍照。 */
export const QUOTA_COUNTED_STATUSES: ProcessingStatus[] = [
  ProcessingStatus.READY,
  ProcessingStatus.NORMALIZING,
  ProcessingStatus.CROPPING,
  ProcessingStatus.MATTING
];
