---
name: shelf-drag-sort
overview: 为收藏页「我的」展架模式实现长按展架标题进入排序模式（所有展架抖动提示），拖拽调整展架前后顺序，松手后调用已就绪的 reorderShelves 接口云端保存。
todos:
  - id: sort-state
    content: 在 use-library-collection.ts 新增排序模式状态与 enterSortMode/moveShelf/commitSortOrder/cancelSort，并补充依赖注入 reorderShelves
    status: completed
  - id: shelf-row-gesture
    content: 在 LibraryShelfRow.vue 实现长按标题进入排序、抖动动画与拖拽手势上报，排序模式下禁用横向滚动和卡片删除
    status: completed
    dependencies:
      - sort-state
  - id: page-wiring
    content: 在 library/index.vue 接线排序状态与事件，处理分段切换、搜索及页面隐藏时的退出与保存
    status: completed
    dependencies:
      - sort-state
  - id: verify-build
    content: 执行小程序类型检查与构建，回归长按删除、横向滚动和宫格/心愿模式不受影响
    status: completed
    dependencies:
      - shelf-row-gesture
      - page-wiring
---

## 产品概述

收藏页「我的」展架模式新增自定义排序能力：用户长按任意展架标题行后进入排序模式，所有展架开始轻微抖动提示可拖动，拖拽展架行调整前后顺序，松手后顺序云端保存，所有设备保持一致。

## 核心功能

- 长按展架标题行进入排序模式，所有展架行同时抖动，视觉提示进入可拖动状态。
- 按住并上下拖动展架行时，实时预览新的排列顺序。
- 松手后自动调用已就绪的展架排序接口，将顺序保存到云端。
- 排序模式自动屏蔽展架内横向滚动、卡片点击和长按删除，避免手势冲突。
- 只对「我的」收藏的展架模式生效，宫格模式与「心愿」分段不进入排序模式。

## 技术栈

- 小程序：uni-app + Vue 3（`<script setup lang="ts">` + virtualHost），WXSS 动画。
- 后端与数据层全部复用现有实现，本次不改后端、不改契约、不改 data 层。

## 实现方案

### 关键结论

后端展架排序链路已完全就绪：`Shelf.sortOrder` 字段、`POST /shelves/reorder` 接口、`shelves.service.ts` 的 `reorder()` 校验与事务写入、前端 `data.ts` 的 `reorderShelves(ids)` 封装均已存在。因此本次改动集中在小程序前端交互层。

### 核心数据流

展架列表 `shelves.value` 已按 `sortOrder asc` 返回，`groups` computed 是按 `shelves.value` 顺序过滤映射的。因此排序只需在排序模式下对 `shelves.value` 数组做本地 `splice` 重排，`groups` 会自动跟随；松手后调用 `reorderShelves(shelves.value.map(s => s.id))`，用接口返回的新列表写回 `shelves.value`，保证本地顺序与后端 `sortOrder` 一致。

### 排序模式状态设计

状态放在 `use-library-collection.ts`（与现有 `segment`/`displayMode` 同层）：

- `sortingMode`：是否处于排序模式。
- `draggingShelfId`：当前正在拖动的展架 id。
- `enterSortMode(shelfId)`：长按标题触发，进入排序模式并标记拖动行。
- `moveShelf(shelfId, toIndex)`：拖拽过程中按目标索引重排 `shelves.value`。
- `commitSortOrder()`：松手时调 `data.reorderShelves(ids)` 保存并退出排序模式。
- `cancelSort()`：页面隐藏/离开或用户取消时退出，不提交。

### 拖拽手势方案

小程序端用手势方案而非 `movable-area/movable-view`（后者在动态高度列表项中定位复杂）：

- 长按标题 `@longpress` 进入排序模式；进入后该行转为「拖动中」态。
- `@touchmove` 读取 `event.touches[0].clientY`，与相邻展架行中心点比较，越过中线即交换顺序（本地 splice）。
- `@touchend`/`@touchcancel` 提交排序或取消。
- 排序模式下给展架行加 `pointer-events` 与手势拦截：屏蔽 `scroll-view` 横向滚动、卡片 `@tap` 打开详情、卡片 `@longpress.stop` 删除收藏。

### 抖动动画

WXSS `@keyframes shelf-wiggle`（小幅左右 rotate），所有展架行共享动画，每行用 `animation-delay` 错开相位形成自然抖动；拖动的行单独放大或加阴影高亮，其余行继续轻微抖动。

## 实现要点

- `use-library-collection.ts` 的依赖注入 `data?: Pick<typeof dataService, ...>` 需补上 `reorderShelves`，否则无法调用保存接口。
- `groups` 是 `computed`，本地重排 `shelves.value` 即可同步 UI 顺序，不要另存一份排序数组，避免两处状态不一致。
- 保存失败需回滚：先用 `reorderShelves` 返回的新列表覆盖 `shelves.value`；失败时恢复重排前的快照并提示，不能留下本地与云端不一致。
- 页面 `onHide`/`onUnload` 时退出排序模式并提交未保存的顺序（或按产品取舍放弃），复用现有页面生命周期接线。
- 只对 `displayMode === 'shelf'` 且「我的」分段生效；切换分段、切换宫格模式、搜索时退出排序模式。
- 不新增状态管理库，不改动 `library-card-events.ts` 的现有手势，只在排序模式下用标志位旁路其 `open`/`longPress` 触发。

## 架构设计

展架排序属于现有收藏页的一条独立交互链，沿用「页面组合层 + 组合函数 + 行组件」三层结构：

- 状态与保存逻辑集中在 `use-library-collection.ts`，避免散落在页面。
- `LibraryShelfRow.vue` 只负责长按标题、抖动样式、手势坐标上报和拖动视觉，跨行重排逻辑通过 emit 交回集合层。
- `library/index.vue` 负责把排序模式状态传给各展架行并处理生命周期退出。

## 目录结构

```
apps/miniapp/src/
├── pages/library/
│   └── index.vue                        # [MODIFY] 接线排序模式：把 sortingMode/draggingShelfId 传给展架行，处理 sortStart/move/end 事件、切换分段/搜索/页面隐藏时退出排序。
├── services/
│   └── use-library-collection.ts        # [MODIFY] 新增 sortingMode、draggingShelfId、enterSortMode/moveShelf/commitSortOrder/cancelSort；依赖注入 Pick 补 reorderShelves；导出排序状态与方法。
└── components/
    └── LibraryShelfRow.vue              # [MODIFY] 新增长按标题进入排序、抖动动画、拖动高亮与手势坐标上报；排序模式下禁用横向滚动、卡片点击和长按删除。
```

## 关键代码结构

```ts
// use-library-collection.ts 新增导出（方法签名，实现按现有模式）
sortingMode: Ref<boolean>;
draggingShelfId: Ref<string | null>;
enterSortMode(shelfId: string): void;
moveShelf(shelfId: string, toIndex: number): void;
commitSortOrder(): Promise<void>;
cancelSort(): void;
```

```ts
// LibraryShelfRow.vue 新增 props 与 emit
props: {
  // ...现有 group/index/activeId/viewportRevision
  sorting?: boolean;      // 当前是否处于排序模式
  dragging?: boolean;     // 当前行是否为被拖动行
};
emit: {
  sortStart: [shelfId: string];
  sortMove: [shelfId: string, clientY: number];
  sortEnd: [];
};
```