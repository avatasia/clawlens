# Chat Audit 底部重叠感分析

日期：2026-04-02  
关联截图：`/test/ScreenShot_2026-04-02_114349_780.png`

## 结论

红框区域“还是感觉不对”的根因，不是单一 CSS 漏写，而是下面三类因素叠加：

1. Chat Audit 侧栏仍然是覆盖式 `position: fixed` 面板，宿主 Chat 页面只对一组猜测性的容器加了 `margin-right`，底部固定层未必一起右移。
2. 侧栏内部滚动容器虽然可滚动，但底部只有 `20px` 留白，最后一张展开的 run 卡片会紧贴视口底边，视觉上容易形成“压住了底部内容”的感觉。
3. run 详情默认首张展开，且 Timeline + Turns 叠加后高度较大，底部最后一屏同时出现卡片边框、宿主页面底部控件和深色背景时，会放大“重叠/压迫感”。

## 代码证据

### 1. 宿主布局只做了启发式右移，不保证底部固定层一起移动

文件：[styles.css](../../../extensions/clawlens/ui/styles.css)

```css
body.clawlens-audit-open .chat-split-container,
body.clawlens-audit-open .chat-main,
body.clawlens-audit-open main.chat,
body.clawlens-audit-open [class*="chat-container"],
body.clawlens-audit-open [class*="chat-layout"] {
  margin-right: var(--clawlens-audit-width, 360px) !important;
}
```

这套做法的问题是：

- 它只移动“命中这些选择器的容器”
- 如果底部输入框、浮动操作区、sticky footer、悬浮按钮不在这些容器里，就不会一起右移
- 因为侧栏本身是固定定位，未被右移的宿主底部层仍可能出现在侧栏右下附近，形成截图中的残余重叠感

### 2. 侧栏内部底部安全区偏小

文件：[styles.css](../../../extensions/clawlens/ui/styles.css)

```css
.clawlens-audit-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  padding-bottom: 20px;
  min-height: 0;
}
```

`padding-bottom: 20px` 对普通列表够用，但对“展开态 run 卡片”不够。最后一项滚到最底部时，会出现：

- 卡片圆角和底边距过小
- Timeline/Turns 紧贴视口底部
- 用户能看到的末尾缓冲区不足

因此即使没有真正 DOM 重叠，视觉上也会像“底部被压住”。

### 3. 首张 run 默认展开，会放大底部拥挤感

文件：[inject.js](../../../extensions/clawlens/ui/inject.js)

```js
<div class="clawlens-audit-run${i === 0 ? " expanded" : ""}">
```

同时详情区包含：

- Timeline
- Turns 列表
- 可展开的消息 preview

文件：[inject.js](../../../extensions/clawlens/ui/inject.js)

```js
<div class="clawlens-audit-run-detail">
  ...
  <div class="clawlens-turns">${renderTurns(run.turns)}</div>
</div>
```

这会导致右侧栏一打开时，顶部和底部都被大块内容占住。若当前页面底部还有宿主输入框或工具条，用户会更容易把“紧贴底边”感知为“底部重叠”。

## 原理说明

这类问题本质上是两层布局系统没有完全解耦：

- ClawLens Audit 侧栏希望自己像独立 drawer 一样工作
- 但实现上它并没有真正接管 chat 页面布局，只是在 `body` 上加类，再试图把若干宿主容器往左推

结果就是：

1. 右侧栏自身是固定定位，始终覆盖在最上层
2. 宿主页面只有部分区域被右移
3. 宿主底部固定元素若没有被同样处理，就会在右下角残留
4. 侧栏内容区底部缓冲不够时，这种残留会被放大成“叠在一起”的视觉问题

所以红框问题更接近“布局协同不完整”，不是单纯“多加一个 `overflow-y: auto`”就能彻底解决。

## 优化方案

### 方案 A：把宿主 chat 主体和底部固定层一起右移

优先级：高

做法：

- 明确定位 OpenClaw chat 页面真正的主容器、输入区容器、底部固定工具层
- 不再只依赖 `[class*="chat-layout"]` 这类模糊选择器
- 用一组更精确的选择器，确保侧栏打开时：
  - 主内容区右移
  - 输入框区右移
  - 底部 sticky/fixed 区右移

建议：

- 用 `transform` 或 `padding-right` 驱动宿主主布局
- 避免只靠零散 `margin-right` 猜测多个容器

预期收益：

- 消除右下角残余宿主元素
- 让侧栏与 chat 页面形成稳定的“双栏态”

### 方案 B：增加侧栏底部安全区

优先级：高

做法：

- 将 `.clawlens-audit-body` 的底部留白从 `20px` 提升到至少 `48px` 到 `72px`
- 如页面底部存在固定输入栏，可进一步使用：

```css
padding-bottom: max(56px, env(safe-area-inset-bottom));
```

预期收益：

- 最后一张卡片不会紧贴底边
- 滚动到末尾时视觉更松弛
- 即使宿主仍有少量底部元素残留，冲突感也会下降

### 方案 C：打开侧栏时默认折叠所有 run

优先级：中

做法：

- 去掉首项默认 `expanded`
- 只在用户主动点击后展开

预期收益：

- 首屏高度明显下降
- 底部压迫感减轻
- 侧栏更像“摘要列表”，不是一打开就堆大量细节

代价：

- 首次查看细节多一次点击

### 方案 D：给底部增加淡出遮罩或滚动终点提示

优先级：中

做法：

- 在侧栏底部增加一个 `pointer-events: none` 的渐变遮罩
- 或在滚动区底部加一个轻量 footer spacer / divider

目的不是遮问题，而是明确告诉用户：

- 这里是滚动容器的自然终点
- 不是内容和宿主页面叠在了一起

### 方案 E：对展开详情区加内部高度约束

优先级：中

做法：

- 为 `.clawlens-audit-run-detail` 增加 `max-height`
- 超过时在详情内部滚动，而不是让单个 run 无限拉长

适用场景：

- 某个 run 的 turns 很多
- preview 展开后正文较长

预期收益：

- 避免单卡片占满整屏
- 降低底部大面积深色块堆叠感

## 推荐落地顺序

1. 先做方案 A，补全宿主页面底部层的布局协同。
2. 同时做方案 B，把侧栏滚动区底部安全区增大。
3. 再做方案 C，取消首项默认展开。
4. 若仍觉得底部视觉发闷，再加方案 D 或 E。

## 判断标准

优化后应满足：

- 右下角不再看到宿主底部控件残留到侧栏区域
- 最后一张 run 卡片滚到底时，底边下方仍有明显缓冲区
- 用户能直观看出这里是“滚动终点”，不是“内容重叠”
- 在窄屏和宽屏下都不会出现底部挤压感突然加重

## 本文与前一份分析的关系

前一份文档 [CHAT_AUDIT_UI_ANALYSIS_2026-04-02.md](../../CHAT_AUDIT_UI_ANALYSIS_2026-04-02.md) 解决的是整体交互问题：可拖拽、长消息查看、整体滚动和 overlay 布局。

本文聚焦的是该问题的剩余细节：右下角底部区域为什么在修完前面几项后，视觉上仍然“不干净”。
