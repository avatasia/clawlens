---
status: active
created: 2026-05-02
updated: 2026-05-02
---

# ClawLens UI Preview Interaction And Copy Actions

目的：收敛当前 Chat Audit UI 中 preview/source surface 的交互缺陷，并补上 run / turn 级一键复制能力。该方案只覆盖 `extensions/clawlens/ui/inject.js` 与 `extensions/clawlens/ui/styles.css` 的前端行为修正，不扩展新的 API，不改 store/schema。

## Scope

本轮只做：

1. preview surface 的持久化显示与切换语义修正
2. source 展开时的宽度 / 高度 / 底部留白稳定性修正
3. preview/source 在同一 surface 内的平滑切换
4. run 级与 turn 级复制按钮
5. 与上述行为直接相关的前端自动化/手动验证

本轮不做：

1. 新增后端 route
2. source payload 格式变更
3. structured preview 数据格式变更
4. 全局 UI 视觉重做

## Current Problems

### 1. Hover surface too eager to close

当前 `bindAuditPanelInteractions()` 使用 `mouseover`/`mouseout` 打开和关闭 preview，`ensurePreviewSurface()` 也在 surface `mouseleave` 时走 `schedulePreviewClose()`。

结果是：

1. 鼠标刚离开 turn 或 surface 就开始关闭
2. 用户移动到其他区域还未点击时，surface 已消失
3. source 展开、复制等操作都被迫依赖“快速 hover + click”，交互不稳

这与当前需求冲突。正确语义应是：

1. hover 到某个 turn：可以打开对应 surface
2. surface 打开后，不因普通移出而关闭
3. 点击另一个 turn：切换到新的 surface
4. 点击 surface 外部区域：关闭当前 surface
5. 点击同一个 turn：保持当前 surface，不闪烁关闭

### 2. Source load causes width jitter and bottom clipping

当前 `positionPreviewSurface()` 在 pinned / unpinned 两种状态下直接切不同宽度：

1. unpinned: `min(420px, viewport)`
2. pinned: `min(560px, viewport)`

而 `Source` 按钮会先 `openPreviewSurface(turn, true)`，再异步 `loadSourceForTurn(turn)`，导致：

1. source 请求前后内容重绘
2. 容器宽度随 pinned/content 二次变化
3. 视觉上先变宽再回缩，产生抖动

同时当前 surface 只做 `max-height + overflow:auto`，但底部定位没有预留独立的 viewport gutter，长 source 内容在接近页面底部时会出现“滚动到底仍像被贴边截住一点”的观感。

### 3. Preview body and source body switch is abrupt

当前 source 内容直接附着在 preview surface 底部，按钮点击后会立刻替换为 payload/miss note，没有稳定的“details mode”结构，也没有 source loading/loading cached 的明确状态。

这会造成：

1. turn preview 与 source payload 混在一个临时 hover surface 中
2. source 加载前后内容跳变突兀
3. 用户不容易判断当前是在看 turn preview，还是在看 source detail

### 4. Missing copy affordances

当前 UI 没有：

1. run detail 全量复制入口
2. turn/source 级复制入口

用户提出的目标是：

1. `Turns` 标签后增加 run copy 按钮
2. 每个 turn 的 `Source` 按钮后增加 `Copy` 按钮

## Target Behavior

### A. Single persistent preview surface

把当前 surface 视为“单实例 detail popover”，而不是 hover tooltip。

目标行为：

1. hover 到 turn 时可打开 surface
2. surface 一旦打开，不因 `mouseout` / `mouseleave` 自动关闭
3. 只有两类行为会关闭 surface：
   - 点击 surface 外部
   - 切换到另一个上下文并显式替换
4. hover 到另一个 turn 时，surface 改为复用同一个 DOM，更新内容并重定位，而不是先 hide 再 show

实现方向：

1. 去掉 `schedulePreviewClose()` 的 hover 驱动关闭语义
2. 保留 hover open delay，避免纯鼠标扫过时频繁闪烁
3. 增加显式状态，但不引入与 `S.previewPinnedKey` 平行的第二套 mode 真状态，区分：
   - 当前绑定的 turn key
   - 当前 source section 是否已打开
   - 当前是否处于 detail mode

其中：

1. detail / hover mode 由 `S.previewPinnedKey` 派生
2. 不新增可写 `S.previewMode`
3. 避免出现 `previewPinnedKey` 与另一个 mode 字段分离的双真值状态

### B. Stable surface dimensions

目标行为：

1. source 点击后，不应出现“先变宽后变窄”抖动
2. pinned/detail mode 的宽度应稳定
3. source payload 高度较大时，surface 底部应留出稳定 gutter

实现方向：

1. 把 surface 宽度从“基于瞬时 pinned/content 切换”改成“detail mode 固定宽度，hover mode 固定宽度”
2. 一旦进入 detail mode，后续 source loading / source loaded / copy toast 都不再改宽度
3. `positionPreviewSurface()` 改为基于：
   - `detail mode width`
   - `hover mode width`
   - `viewport edge gutter`
   - `max-height with bottom padding`
4. 增加内部 body/source 区域滚动容器，而不是仅靠最外层 surface 滚动

建议尺寸：

1. hover mode: 420px
2. detail mode: 560px
3. viewport gutter: top/left/right/bottom 至少 12px，底部可加到 20px

### C. Unified preview/source detail layout

source 不再表现为“临时在 hover tooltip 下方塞一块内容”，而是作为 detail mode 里的第二块区域。

目标结构：

1. header
   - title
   - `Open details` / `Close`
2. preview body
3. source section
   - idle: `Load full source`
   - loading: `Loading source…`
   - success: source payload viewer
   - failure: miss/error note

交互语义：

1. 点击 turn 本体：进入 detail mode，展示 preview
2. 点击 `Source`：进入同一个 detail surface，并切 source section 到 loading/success/failure
3. 如果 surface 当前展示的是别的 turn，点击新 turn 的 `Source`：
   - 直接切上下文到新 turn
   - 保持 surface 连续可见
   - 显示 loading，再切到结果

### D. Copy actions

#### D1. Turn copy

位置：

1. 每个 turn row 的 `Source` 按钮后增加 `Copy`
2. tool row 同样增加 `Copy`

复制内容原则：

1. turn copy 复制“该 turn 当前最有价值的信息”
2. 优先使用结构化 JSON 文本，而不是 UI 截断文本

建议 payload：

```json
{
  "kind": "turn",
  "runId": "...",
  "messageId": "...",
  "role": "...",
  "previewFormat": "...",
  "preview": "...",
  "sourceKind": "...",
  "source": { ... } // only when already loaded and cached
}
```

tool row 复制：

```json
{
  "kind": "tool_turn",
  "runId": "...",
  "toolCallId": "...",
  "previewFormat": "...",
  "preview": "...",
  "source": { ... } // only when already loaded and cached
}
```

注意：

1. copy 不应隐式触发 source 请求
2. 如果 source 未加载，只复制 preview + metadata
3. 如果 source 已缓存，则一起带上 source
4. message turn 要补 `data-source-kind="message"`，与 tool turn 的 `data-source-kind="tool"` 保持对称
5. 如果 turn row 存在 deferred / not-yet-loaded 状态，则 `Copy` 必须禁用或提示“load turn detail first”
6. 如果当前实现里 turn row 一旦渲染就保证 preview 数据已可用，则实现时必须保持这个前提，不允许静默复制空 payload

#### D2. Run copy

位置：

1. `Turns` section label 后增加 `Copy`

复制内容范围：

1. 当前 run 的 header metadata
2. summary
3. timeline
4. turns

建议 payload：

```json
{
  "kind": "run",
  "runId": "...",
  "status": "...",
  "runKind": "...",
  "userPrompt": "...",
  "summary": { ... },
  "timeline": [ ... ],
  "turns": [ ... ]
}
```

注意：

1. run copy 不需要等待额外 API
2. 只复制当前内存里已有的 run detail
3. 如果该 run 还是 deferred detail，则 copy 按钮应禁用或提示“load run detail first”
4. run copy payload 直接使用 `renderAuditPanel()` 当前渲染作用域里的 `run` 对象，不在 click 时回头从 `S.runs` 或 `CHAT_STATE.data.runs` 二次查找
5. run copy 里的 `turns[]` 条目沿用 D1 的 turn copy 规则：
   - source 仅在当前内存里已加载且已缓存时附带
   - 不为 run copy 额外触发 source 请求

### E. Feedback and non-disruptive UX

复制成功后需要轻量反馈，但不能引起 surface reflow。

建议：

1. 用按钮短暂变成 `Copied`
2. 1.2s 后恢复
3. 不插入额外大块提示 DOM
4. copy 反馈通过局部按钮 DOM 文案更新完成，不通过整个 preview surface 的 full rerender 传播

## Proposed Implementation

## 1. State model updates

在 `inject.js` 中新增或重构这些状态：

1. `S.previewSurfaceKey`
2. `S.previewPinnedKey`
3. `S.previewSourceStateByKey`
   - `idle` / `loading` / `loaded` / `error`
4. copy feedback 不新增全局 `S.copyFeedbackByKey`
   - 直接走按钮局部 DOM 文案切换

目标是让 surface 行为由显式状态驱动，而不是由 `mouseleave` 定时器隐式驱动。

关键约束：

1. `S.previewPinnedKey` 仍然是 detail/hover 的唯一真状态
2. 如果需要判断 mode，只能通过 `S.previewPinnedKey != null` 派生
3. 只要 `S.previewPinnedKey != null`，就必须保持 `S.previewSurfaceKey === S.previewPinnedKey`
4. 设置新的 `previewPinnedKey` 时，必须原子地把 `previewSurfaceKey` 切到同一个 key

## 2. Event model changes

### remove

1. turn `mouseout -> schedulePreviewClose`
2. surface `mouseleave -> schedulePreviewClose`

### keep

1. hover open delay
2. click outside to close
3. click turn / keyboard turn to pin detail

### add

1. hover another turn while surface open：
   - 若当前不是 detail lock，切换上下文
   - 若当前是 detail lock，忽略纯 hover 切换
   - detail lock 下只允许通过显式 click / keyboard 切换到新的 turn
2. click `Source`：
   - 强制进入 detail mode
   - source section 切 loading，再渲染结果
3. click `Copy`：
   - 调 `navigator.clipboard.writeText`
   - 只更新当前按钮局部反馈状态
   - 不触发整个 preview surface 的 full rerender
4. explicit click / keyboard 切换到新的 turn：
   - 若新 turn 已有 cached source，source section 直接进入 `loaded`
   - 若新 turn 无 cached source，source section 回到 `idle`
   - 不沿用旧 turn 的可视 source 状态

## 3. Layout changes

在 `styles.css` 中：

1. `clawlens-preview-surface`
   - 改成内部 header/body/source 分区
   - 外层固定 gutter 与 stable width
2. `clawlens-preview-body`
   - 可独立滚动或受控高度
3. `clawlens-preview-source`
   - 独立顶部边界
   - payload viewer 使用独立 `max-height`
   - 建议值：`max-height: min(48vh, 300px)`
4. 新增 copy button 样式：
   - turn row copy
   - section label copy
5. 为底部增加可见余量，避免紧贴 viewport bottom
6. turn row 的 `Source` + `Copy` 不能继续依赖单按钮绝对定位
   - 需要改成右侧 action group
   - 同步调整或移除 `.clawlens-turn` 当前为单按钮预留的固定 `padding-right`

## 4. Rendering changes

### turn rows

给 message/tool row 增加：

1. `Source`
2. `Copy`
3. 右侧 action group container

### section label

`Turns` label 改成 actions row：

1. `Turns`
2. `Copy`

### preview surface

统一经由 `renderPreviewSurfaceContent()` 产出：

1. preview body
2. source panel
3. local action state

但：

1. source loading / source loaded / source error 仍可以通过 surface rerender 更新
2. copy success 不应通过 `surface.innerHTML = ...` 触发，避免长内容滚动位置被重置

## Validation Plan

### Automated

至少补：

1. 复制 payload helper 的单元测试
2. preview/source state helper 的单元测试
3. 最小 DOM interaction test：
   - detail lock 下 hover 其他 turn 不切上下文
   - `Copy` 不触发额外 source `apiFetch`
4. 如现有 harness 仍不足，再把剩余部分保留为手动验证项

### Manual / Remote

必须复测：

1. hover 一个 turn 后移开鼠标，surface 保持
2. 点击页面空白处，surface 关闭
3. hover/点击另一个 turn，surface 平滑切到新内容
4. 点击 `Source` 不出现宽度抖动
5. 长 source 滚到底不再被底部贴边遮挡
6. turn `Copy` 可复制 preview metadata；若 source 已加载则携带 source
7. run `Copy` 可复制当前 run detail
8. 可通过浏览器抓包确认：
   - hover 不触发 source 请求
   - 点击 `Source` 才触发 source 请求
   - `Copy` 不触发额外 source 请求

## Acceptance Boundary For Reviewer

Reviewer 应重点检查：

1. 是否去除了 hover-close 导致的易失交互
2. 是否避免了 source load 时的宽度抖动
3. copy 是否错误地触发了 source 请求
4. run copy / turn copy 的 payload 是否足够稳定、可复查
5. 是否引入了新的 preview/source 状态冲突

Reviewer 不需要要求：

1. 新后端接口
2. 新数据库字段
3. 复杂动画系统
