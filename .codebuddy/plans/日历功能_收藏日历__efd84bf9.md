---
name: 日历功能（收藏日历）
overview: 在首页搜索图标左侧新增一个日历 icon 入口，点击进入月视图日历页；用户收藏袋子的日期（addedAt）会自动在对应日期上显示一个占位标签，纯前端实现、无需后端改动。
design:
  styleKeywords:
    - 暖纸质感
    - 极简
    - 玻璃卡
    - 朱红点缀
    - 衬线标题
  fontSystem:
    fontFamily: PingFang SC
    heading:
      size: 38rpx
      weight: 700
    subheading:
      size: 28rpx
      weight: 600
    body:
      size: 24rpx
      weight: 400
  colorSystem:
    primary:
      - "#141414"
      - "#C50405"
    background:
      - "#F2F3F7"
      - "#FFFFFF"
      - "#FBFBFD"
    text:
      - "#141414"
      - "#77736D"
      - "#8D877C"
    functional:
      - "#1DA84A"
      - "#943D37"
      - "#8A5A10"
todos:
  - id: add-calendar-entry
    content: 新增 calendar.svg 图标、在 pages.json 注册日历页路由，并在首页搜索左侧添加日历入口按钮
    status: completed
  - id: build-calendar-view
    content: 创建日历页月视图：星期头、6×7 网格、上/下月切换、今日高亮与日期占位标签
    status: completed
    dependencies:
      - add-calendar-entry
  - id: wire-calendar-data
    content: 接入收藏数据按 addedAt 翻页聚合并按日期点亮，实现点击日期查看当天袋子列表
    status: completed
    dependencies:
      - build-calendar-view
  - id: verify-build
    content: 运行 pnpm typecheck 与小程序本地构建，修复类型与样式问题
    status: completed
    dependencies:
      - wire-calendar-data
---

## 产品概述

在微信小程序「袋袋集」中新增一个收藏日历页。用户在哪一天收藏/标记了袋子，日历对应日期上就自动出现一个占位标签，方便按时间回顾收藏足迹。界面按用户提供的参考图实现（暖纸底 + 白色圆角大卡 + 独立日期方块 + 焦糖色今日高亮）。

## 核心功能

- 首页搜索图标左侧新增一个日历 icon 入口，点击进入日历页。
- 日历页以月视图展示，支持上/下月切换，并高亮「今天」。
- 用户有收藏记录的日期自动显示占位标签（标签样式未定，先用数字下方小圆点 + 数量角标替代）。
- 点击带标签的日期，可查看当天收藏的袋子名称列表（本地数据，无需额外接口）。
- 收藏数据变化后再次进入页面自动刷新。

## 参考图设计还原（用户 2026-10-16 提供截图）

- **页面底色**：暖米纸色（约 `#F5F1E9`，带轻微纸纹噪点感）。
- **标题区**：居中大号衬线粗体标题（参考图 "Today"，这里用「收藏日历」或「今天」），下方一行等宽/衬线小字日期副标题（如 "Fri, Oct 16, 2026"），深棕色。
- **日历卡片**：一张白色大圆角卡片（大圆角 ~40rpx），承载星期头与日期网格，带柔和投影。
- **星期头**：`Sun Mon Tue Wed Thu Fri Sat`，**周日为首日**（与参考图一致，覆盖此前周一为首日的方案），弱化灰棕色小字、字距拉开。
- **日期格**：每个日期是**独立的浅米色圆角方块**（约 `#EFEBE2`，圆角 ~18rpx），格子之间留缝隙；非当月日期不渲染格子（留空），与参考图首行一致。
- **今日高亮**：焦糖/琥珀色实心圆角方块（约 `#D99C4F`）+ 白色数字，替代描边方案。
- **收藏占位标签**：有收藏的日期，在方块内数字下方加一颗朱红小圆点；同天多件时圆点旁加 ×N 小角标（占位方案，后续可换）。
- **月份切换**：参考图未展示，但功能需要 —— 在卡片上方或标题下方加一行「‹ 2026年10月 ›」，两侧圆形轻量按钮。

## 技术栈选择

- 前端：uni-app（Vue 3 + TypeScript），仅构建 mp-weixin，遵循现有页面写法。
- 数据源：复用现有 `dataService.collectibles`（`GET /collectibles?limit=1000`），无后端改动。
- 图标：新增 stroke 描边风格 SVG，对齐 `static/figma` 现有图标规范。
- 路由：主包 `pages.json` 注册，`uni.navigateTo` 进入。

## 实现方案

采用纯前端新增独立页面的方式，把「标记袋子」直接映射为收藏记录 `Collectible.addedAt`（添加收藏与首页「标记已有」认领官方袋子都会生成带 `addedAt` 的记录）。

### 数据流

用户进入日历页 → `dataService.collectibles('limit=1000')` 拉取收藏（若 `nextCursor` 存在则循环翻页）→ 聚合全部 `addedAt` 与 `name` → 按本地时区 `YYYY-MM-DD` 归组为 `Map<string, CollectibleSummary[]>` → 生成当前月份 6×7 网格并点亮有记录的日期 → 点击日期展示当天袋子列表。

### 关键决策

- **复用既有接口而非新增后端聚合端点**：个人收藏量级有限，`limit=1000` 单次基本可覆盖；换来零后端改动与零部署成本。若未来收藏量级明显增大，再评估新增轻量 `GET /collectibles/dates` 端点。
- **月视图生成规则**：以**周日**为首日（对齐参考图），星期头为 `日一二三四五六`（视觉上可作 Sun–Sat 或中文，实现时与现有页面语言保持一致用中文），用「当月第一天周几」计算前置空位，生成 6×7 固定网格，非当月格留空。
- **日期分组统一本地时区**：使用 `new Date(addedAt).getFullYear()/getMonth()/getDate()` 生成键，与现有 `services/format.ts` 的 `formattedDate` 口径一致，避免时区偏移导致「今天」错位。

## 实现要点

- 首页 `showcase/index.vue`：在现有 `gallery-entry`（搜索）左侧新增日历按钮，定位基于已有 `exploreTop`/`exploreRight`/`exploreSize` 推导（`right = exploreRight + exploreSize + 间隙`），共用垂直居中和尺寸；样式与 `gallery-entry` 共用同一视觉规范。
- 日历页：`navigationStyle: custom` + 自绘返回（参考 `pages/explore/index.vue` 的 `statusBarHeight` 与返回按钮写法），页面内部用 flex 布局，超出可滚动的区域用 `scroll-view` 承载。
- 错误处理沿用 `console.error` + `uni.showToast`，加载/空态参照 explore/library 页。
- 刷新：`onShow` 拉取最新，收藏变更后靠 `collection-state` 的 revision 判断刷新（与 library 同套路）。

## 目录结构

```
apps/miniapp/
├── src/
│   ├── pages.json                        # [MODIFY] 主包 pages 注册日历页（custom nav）
│   ├── static/figma/
│   │   └── calendar.svg                  # [NEW] 日历图标（24×24 viewBox、stroke #333333、宽度约 2）
│   └── pages/
│       ├── calendar/
│       │   └── index.vue                 # [NEW] 收藏日历页：月视图网格、月切换、今日高亮、日期占位标签、当天袋子列表
│       └── showcase/
│           └── index.vue                 # [MODIFY] 首页搜索图标左侧新增日历入口按钮并跳转
```

## 关键代码结构

```ts
// 日历格子（6×7 网格中的一格）
interface CalendarDay {
  date: string;      // 'YYYY-MM-DD'，非当月占位格为空串
  day: number;       // 几号
  count: number;     // 该日收藏数，0 表示无标签
  isToday: boolean;
  inMonth: boolean;
}

// 收藏按本地日期归组
function groupByDay(items: CollectibleSummary[]): Map<string, CollectibleSummary[]>
```

## 页面结构（自上而下，按参考图）

- **顶部导航区**：状态栏留白 + 自绘返回按钮（参考图左上角为设置齿轮，本页对应为返回）。
- **标题区**：居中衬线粗体大标题「收藏日历」+ 下方小字当前选中日期（格式对齐参考图 "Fri, Oct 16, 2026"）。
- **月份切换行**：‹ 2026年10月 ›，圆形轻量按钮，点按有轻微缩放反馈。
- **白色日历卡**：星期头（日为首日）+ 6×7 独立圆角方块网格；今日焦糖色实心块白字；有收藏的日期数字下方朱红小圆点（多件加 ×N 角标）。
- **底部当天明细**：点击带标签日期后，滑出暖白卡片，展示当天收藏的袋子名称列表（本地数据）；无选择时收起。