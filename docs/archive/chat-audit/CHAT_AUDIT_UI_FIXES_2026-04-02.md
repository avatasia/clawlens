# ClawLens Audit 侧栏 UI 优化方案

> 基于 `CHAT_AUDIT_UI_ANALYSIS_2026-04-02.md` 修订。
> 修正了原文一处行号错误，补充了具体实施细节。
> 实施范围：`extensions/clawlens/ui/styles.css`、`extensions/clawlens/ui/inject.js`

---

## 勘误

原分析文档 §四 引用了错误行号：

| 原文引用 | 实际行号 | 说明 |
|---|---|---|
| `styles.css:145` | `styles.css:154` | `.cl-drawer-body { … min-height: 0; }` |

其余行号均正确：
- `styles.css:213-223` — `.clawlens-audit-sidebar`
- `styles.css:242-245` — `.clawlens-audit-body`
- `styles.css:305-314` — turns CSS（含 `white-space: nowrap` 的单行裁剪）
- `inject.js:381-389` — `renderTurns()`，`.slice(0, 120)` 在第 386 行
- `inject.js:445-465` — `mountChatAuditSidebar()`
- `inject.js:467-476` — `hideChatAuditSidebar()`
- `collector.ts:342` — `raw.slice(0, 500)` 写入 `content_preview`

---

## 修复范围与优先级

### P1 — 滚动稳定性（styles.css）

**根因**：`.clawlens-audit-sidebar` 有 `overflow: hidden` 但缺 `min-height: 0`；子元素 `.clawlens-audit-body` 虽有 `overflow-y: auto`，在 flex 链中仍可能被父级压缩到零高度，导致内部滚动失效。

**改动**：
- `.clawlens-audit-sidebar` 补 `min-height: 0`
- `.clawlens-audit-body` 补 `padding-bottom: 20px`，避免最后一张卡片贴底

### P2 — turns 可展开（inject.js + styles.css）

**根因**：`renderTurns()` 把 preview 硬截到 120 字符，CSS 再加 `white-space: nowrap` 强制单行；无任何展开入口。

**改动**：
- 去掉 `white-space: nowrap`，改为 `-webkit-line-clamp: 3` 三行折叠
- 点击 turn 行切换 `expanded` class，展开后显示完整 preview（最多 500 字符，即数据层上限）
- `renderTurns()` 去掉 `.slice(0, 120)`，直接传入完整 `t.preview`
- 渲染时在每行末尾加 `title` 属性，便于鼠标悬停查看原文

### P3 — 可拖拽调宽（inject.js + styles.css）

**根因**：sidebar 固定 `width: 360px`，无拖拽手柄，无 resize 逻辑。

**改动**：
- sidebar 宽度改为读取 CSS 变量 `--clawlens-audit-width`（默认 360px）
- 在 sidebar 左边缘加 `div.clawlens-resize-handle`，`cursor: col-resize`
- `pointerdown` → `pointermove` → `pointerup` 逻辑：
  - 拖动时：`width = window.innerWidth - event.clientX`，夹在 `[240, min(760, 85vw)]`
  - 更新 `document.documentElement.style.setProperty('--clawlens-audit-width', …)`

### P4 — 宿主内容让位（inject.js + styles.css）

**根因**：overlay 模式覆盖宿主页面，右侧元素被遮挡。

**改动**：
- 打开侧栏时，给 `document.body` 加 `clawlens-audit-open` class
- CSS 对常见宿主容器选择器添加 `margin-right: var(--clawlens-audit-width)`，推开主内容区
- 关闭时移除 class
- 选择器为 best-effort（无法保证对所有 OpenClaw 版本生效，但不会破坏布局）

---

## 不改动的项目

| 项 | 原因 |
|---|---|
| `collector.ts:342` 的 500 字符截断 | 改变数据结构需要迁移现有 DB，本轮只做 UI 修复 |
| overlay → split pane 的根本性重构 | 超出本轮范围；P4 是 best-effort 过渡方案 |
| `content_preview` 字段增宽 | 同上，数据层改动留后续专项 |
