/**
 * 日期与相对时长。
 *
 * 陈列页（首页卡背面）与全部收藏页（详情卡）都要展示「收藏日期 / 入库时长」，
 * 两处口径必须完全一致，所以统一放在这里，别在页面里各写一份。
 */

export function formattedDate(value: string, separator: '/' | '-' = '/') {
  const date = new Date(value);
  const two = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}${separator}${two(date.getMonth() + 1)}${separator}${two(date.getDate())}`;
}

/** 入库时长：按自然日差算，与 H5 的 daysAgo 同口径（今天 / 昨天 / N 天前）。 */
export function daysAgoText(value: string) {
  const added = new Date(value);
  const now = new Date();
  const startOfAdded = new Date(added.getFullYear(), added.getMonth(), added.getDate()).getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.max(0, Math.round((startOfToday - startOfAdded) / 86400000));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}
