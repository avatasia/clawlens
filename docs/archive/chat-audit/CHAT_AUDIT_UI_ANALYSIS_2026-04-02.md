# ClawLens Audit 侧栏 UI 问题分析

> 分析时间：2026-04-02
> 证据源：
> - 截图：`../../../test/Image_20260402090908_76_247.png`
> - 前端实现：`extensions/clawlens/ui/inject.js`、`extensions/clawlens/ui/styles.css`
> - 采集/存储实现：`extensions/clawlens/src/collector.ts`、`extensions/clawlens/src/store.ts`
> - 远端接口验证：`103.85.224.131` 上 ClawLens API 返回正常数据
> 输出策略：新建分析文档；未修改原文件。

## 结论摘要

1. `ClawLens Audit` 右侧面板当前不是“可拖拽/可调宽”组件，而是固定宽度 `360px` 的 `position: fixed` 侧栏，代码里没有任何拖拽或 resize 逻辑，所以“不能向左拖拽”是实现缺失，不是偶发样式问题。
2. 长消息现在是“双重裁剪”：数据写库时先被截成最多 500 字符，渲染时又二次裁成 120 字符并强制单行省略，且没有 title / 展开 / 明细弹层，因此用户无法查看完整内容。
3. 右下角“内容有点重叠”的根因不是单点 z-index，而是侧栏采用覆盖式 fixed 布局，没有给宿主 Chat 布局预留右侧空间；宿主页面本来的右侧/底部元素仍按原布局渲染，视觉上就会与 Audit 侧栏挤在一起。
4. “没有滚动条、无法查看所有信息”与 flex 布局细节有关：虽然 `.clawlens-audit-body` 写了 `overflow-y: auto`，但侧栏本体没有补 `min-height: 0` / 明确滚动可视增强，且长列表在当前 overlay sidebar 中缺乏清晰滚动反馈，用户实际感知就是“底部信息被截断”。

## 一、问题 1：右侧面板不能向左拖拽

### 现象

截图中的 `ClawLens Audit` 是固定吸附在右侧的窄栏，用户无法像桌面抽屉那样向左拖动调整宽度。

### 代码证据

- `extensions/clawlens/ui/styles.css:213-220`
- `extensions/clawlens/ui/inject.js:446-460`

关键实现：

- `.clawlens-audit-sidebar` 使用 `position: fixed; top: 0; right: 0; bottom: 0; width: 360px;`
- `mountChatAuditSidebar()` 只是向 `document.body` append 一个固定侧栏
- 代码中没有：
  - 拖拽手柄
  - `pointerdown` / `mousemove` / `mouseup` 逻辑
  - `resize: horizontal`
  - 基于 CSS variable 的动态宽度更新

### 原理

当前组件是“固定宽度覆盖层”，不是“可调整尺寸的 split pane”。  
因此用户的拖拽预期与当前实现模型不一致，问题本质是功能未实现。

### 修复方向

1. 加一个左侧拖拽手柄，拖动时更新 sidebar 宽度。
2. 宽度建议落到 CSS 变量，例如 `--clawlens-audit-width`，方便响应式和持久化。
3. 需要设置最小/最大宽度，避免拖到遮挡主聊天区域。

## 二、问题 2：长消息被切割后无法查看明细

### 现象

截图右侧 `Turns` 列表中的消息都被截断成一行，后半段不可见，也没有点击展开入口。

### 代码证据

- 数据写入：`extensions/clawlens/src/collector.ts:312-318`
- 数据结构：`extensions/clawlens/src/store.ts:167-182`
- UI 渲染：`extensions/clawlens/ui/inject.js:381-388`
- 样式裁剪：`extensions/clawlens/ui/styles.css:305-314`

### 实际发生了什么

第一层裁剪，发生在采集阶段：

- `recordAgentEnd()` 里把消息内容转成 `raw`
- 然后只保存 `raw.slice(0, 500)` 到 `conversation_turns.content_preview`

第二层裁剪，发生在渲染阶段：

- `renderTurns()` 又对 `t.preview` 做 `.slice(0, 120)`
- `.clawlens-turn-preview` 再加 `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`

### 原理

这不是单纯“样式显示不全”，而是“数据层先截断，UI 层再截断”。

结果是：

1. 前端即使临时去掉 ellipsis，也最多只能看到落库后的 500 字符预览。
2. 当前 UI 还会再把这 500 字符缩到 120 字符，并强制单行。
3. 代码没有 title、popover、modal、展开收起，也没有“查看原文”接口。

### 修复方向

1. UI 侧最小修复：
   - turns 支持点击展开
   - 至少显示多行折叠，而不是永远单行
   - 加 `title` 或明细 drawer / modal
2. 数据侧真正修复：
   - 不要只存 `content_preview`
   - 或为明细查看提供完整 message 数据源
3. 若暂时不改存储结构，也应在 UI 上明确标识“这里只是 preview，不是全文”

## 三、问题 3：右下角内容有重叠感

### 现象

从截图右下区域可以看到，Audit 侧栏与宿主页面右下内容在视觉上互相挤压，存在“贴边重叠”的感觉。

### 代码证据

- `extensions/clawlens/ui/styles.css:213-220`
- `extensions/clawlens/ui/inject.js:446-460`

### 原理

当前侧栏是覆盖式 fixed sidebar：

- 它直接浮在页面最上层
- 但没有通知宿主 Chat 布局“右侧已被占用 360px”
- 宿主页面原本的右侧元素、底部控件、浮动内容仍按全宽布局渲染

所以问题不是“某一个元素 margin 不对”，而是：

- Audit 采用 overlay 模式
- 宿主 Chat 仍按原始宽度布局
- 二者没有 layout contract

这也是为什么截图里的右下区域会显得拥挤，不是独立 panel，而像“在现有页面上又盖了一层”

### 修复方向

1. 若继续用 overlay 模式：
   - 需要给宿主主内容区加右侧占位或 transform
   - 至少在打开侧栏时降低右侧宿主元素冲突
2. 若改成 split layout：
   - 直接把 chat 主区缩窄，侧栏占据真实布局空间
   - 这是从根上解决“重叠感”的方式

## 四、问题 4：面板没有滚动条，无法查看所有信息

### 现象

截图中右侧内容明显超过一屏，但底部查看体验很差，用户感知为“没有滚动条 / 看不到全部信息”。

### 代码证据

- `extensions/clawlens/ui/styles.css:213-220`
- `extensions/clawlens/ui/styles.css:242-245`
- `extensions/clawlens/ui/inject.js:446-460`

### 当前实现

- `.clawlens-audit-sidebar` 是 `display: flex; flex-direction: column; overflow: hidden;`
- `.clawlens-audit-body` 是 `flex: 1; overflow-y: auto;`

表面看起来已经“允许滚动”，但还有两个问题：

1. 侧栏容器没有显式 `min-height: 0`
2. 没有任何滚动可视增强或滚动提示

### 原理

在 flex 布局里，子元素是否能稳定产生内部滚动，往往依赖父级/子级的 `min-height: 0`。  
Drawer 主面板那套实现里已经有这个处理：

- `extensions/clawlens/ui/styles.css:145`

但 chat audit sidebar 这套没有同样补齐。

因此当前体验很容易出现：

- 内容确实在内部 overflow
- 但滚动区域不够明确
- 底部内容被“吃掉”的感知比“可滚动”更强

### 修复方向

1. 给 `.clawlens-audit-sidebar` 和 `.clawlens-audit-body` 补 `min-height: 0`
2. 明确 scrollbar 样式或至少保留可见滚动反馈
3. 给底部留出额外 padding，避免最后一张卡贴边

## 五、远端验证结果

### 执行结果

已通过你提供的远端 SSH 信息连到服务器，并执行：

- 远端本机 `curl http://localhost:18789/plugins/clawlens/api/overview`
- 远端本机 `curl 'http://localhost:18789/plugins/clawlens/api/audit?days=7&limit=3'`

结果：

- ClawLens API 正常返回 JSON，说明插件在线
- `audit` 接口返回了实际 session 数据

额外观察：

- 远端登录 shell 中 `openclaw` 不在 PATH，所以 `openclaw dashboard --no-open` 直接报 `command not found`
- 这不影响对 `localhost:18789` 上现有插件 API 的验证

### 与本次 UI 问题的关系

远端结果足以说明：

1. 当前线上确实有 Audit 数据
2. 截图里看到的 UI 问题不是“没有数据导致的空态异常”
3. 问题主要在前端布局/交互模型，而不是 API 无响应

## 六、建议优先级

### 建议先修

1. 给 chat audit sidebar 增加可滚动稳定性：`min-height: 0`、底部 padding、明确滚动反馈
2. 让长消息至少能展开查看；若短期不改数据结构，先把 120 字符单行裁剪改成多行折叠
3. 给侧栏增加可调宽能力，或在打开时给主聊天区域让出空间，减少重叠感

### 建议后修

1. 重新设计 turn 明细的数据来源，不再只依赖 `content_preview`
2. 将 overlay sidebar 升级为真正的 split pane

## 七、最终判断

这 4 个问题里：

1. “不能向左拖拽”是功能缺失
2. “长消息看不到明细”是数据裁剪 + UI 裁剪双重叠加
3. “右下角重叠”是 overlay 布局模型与宿主页面没有协同
4. “没有滚动条”是 flex/overflow 细节没有补齐，滚动反馈也不足

它们都不是偶发 bug，而是当前 chat audit sidebar 这套布局/交互实现的结构性结果。
