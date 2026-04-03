# Chat Audit 最终修复总结

日期：2026-04-02

## 结论

本轮 Chat Audit 问题最终收敛为三类：

1. 首次打开侧栏长期停留在 `Loading…`
2. `Turns` 明细在“轻列表 + 按需详情”改造后不稳定显示
3. run 数量较多时，侧栏卡片布局变形且没有正常滚动

当前这三类问题都已修正，线上验证结果为“恢复正常”。

## 根因总结

### 1. 首开 `Loading…`

根因不是后端接口无响应，而是前端状态机的两个入口互相干扰：

- chat 页进入时，路由监听会提前调用 `refreshChatAudit()`
- 真正点击 `Audit` 打开侧栏时，又复用同一份 `CHAT_STATE`
- 旧逻辑把“`sessionKey` 没变”错误地当成“已有可展示数据”
- 另外，侧栏打开时即使内存里已经有数据，也没有先渲染已有数据，而是直接显示初始 `Loading…`
- 如果后续增量刷新 `since=...` 没有新数据，页面就会一直停在这个占位态

### 2. `Turns` 明细看不到

根因是“摘要列表 + 按需详情”改造后，展开状态仍依赖 DOM 临时 class：

- 点击 run 后，明细异步请求 `/audit/run/<runId>`
- 回来后侧栏整体重渲染
- 原先展开的 run 状态丢失
- 用户看到的是 detail 区块被重置，表现为 `Turns` 像“消失了”

### 3. run 多时布局乱掉、没有滚动条

根因是侧栏内容区采用纵向 flex 布局，但 run 卡片允许 `flex-shrink`：

- run 少时问题不明显
- run 一多，卡片被压缩而不是让容器溢出滚动
- 于是出现“卡片内容被挤乱”和“滚动条不出现”同时发生

## 实际修复内容

修复文件：

- [inject.js](../../../extensions/clawlens/ui/inject.js)
- [styles.css](../../../extensions/clawlens/ui/styles.css)

### `inject.js`

1. 首屏与打开侧栏逻辑分离
   - 若已有 `CHAT_STATE.data`，打开侧栏时直接渲染，不再强制先显示 `Loading…`
   - 若当前没有数据，即使 `sessionKey` 未变化，也会重新走首屏加载

2. 首屏 detail 预取不再阻塞 UI
   - 首屏轻量列表返回后先渲染 run 列表
   - 第一条 run 的 detail 改为后台补拉，不再 `await` 阻塞首屏显示

3. 增量刷新空结果不再留下假 loading
   - `since=...` 返回空时，如果已有数据，立即重渲染当前数据
   - 避免页面停留在最初的占位态

4. 展开状态改为受控状态
   - 新增 `expandedRunIds`
   - 新增 `loadingRunIds`
   - run 展开/收起和 detail 加载改由前端状态机控制

5. 明确空状态提示
   - 无 timeline 时显示 `No timeline captured for this run.`
   - 无 turns 时显示 `No turns captured for this run.`

6. 调试日志
   - 增加统一前缀 `[ClawLens Audit]`
   - 覆盖首屏加载、侧栏打开、增量刷新、run detail 加载和侧栏渲染
   - 这组日志帮助确认最终问题落在“打开侧栏渲染入口”

### `styles.css`

1. run 卡片禁止在纵向 flex 容器中被压缩
   - `.clawlens-audit-run { flex: 0 0 auto; }`

2. 头部布局收紧
   - 为 header、顶部编号/时长行补 `gap`、`min-width: 0`、`flex-shrink: 0`

3. 侧栏滚动行为稳定化
   - 补 `scrollbar-gutter: stable`

4. 补齐 “Load older runs” 按钮样式

## 远端同步

本轮已同步到远端插件目录：

- `~/.openclaw/extensions/clawlens/ui/inject.js`
- `~/.openclaw/extensions/clawlens/ui/styles.css`

本轮收敛阶段以静态前端文件为主，因此不依赖 `openclaw-gateway` 重启即可生效；浏览器强刷后即可验证。

## 验证结果

最终验证结论：

- 刷新 chat 页面，停留在 `heartbeat`
- 第一次点击 `Audit`
- 侧栏能够正常显示，不再永久停留在 `Loading…`
- `Turns` 明细可见
- run 数量增加后，侧栏布局和滚动恢复正常

## 经验教训

1. Chat 页的“预热加载”和“真正打开侧栏显示”不能只靠同一套隐式状态推断。
2. 只要存在异步 detail 回填，就不能继续用 DOM 临时 class 保存展开状态。
3. 纵向 flex 列表如果希望溢出滚动，子项必须显式禁止 shrink。
4. 当界面表现像“布局坏了”时，实际根因也可能是状态机没有把已有数据重新渲染出来。
