# Chat Audit Turns 明细回归修复记录

日期：2026-04-02

## 背景

在将 Chat Audit 侧栏从“首屏全量详情”调整为“轻列表 + 按需明细”后，`heartbeat -> agent:main:main` 这类会话虽然能够正常返回 run 列表，但展开 run 后经常看不到 `Turns` 明细，用户侧感知为“前端布局有问题，Turns 看不到了”。

本次文档记录的是该回归的实际根因、修复内容与后续注意事项。

## 现象

- Chat Audit 首屏能够渲染 run 卡片。
- 点击 run 标题后，`Timeline` / `Turns` 区域经常为空。
- 某些情况下界面不是明确空状态，而像是 detail 区块被挤没、被重置或没有正确展开。

## 根因分析

问题不在后端数据缺失，而在前端展开状态与按需拉详情的组合方式。

之前的实现有两个关键缺陷：

1. 侧栏展开状态是“非受控”的
   - run 的展开/收起仅靠 DOM 上的 `expanded` class 切换。
   - 当 `ensureChatRunDetail()` 拉到 `/audit/run/<runId>` 明细后，`updateAuditSidebarContent()` 会整体重渲染侧栏。
   - 重渲染后，原本手工点开的 run 会丢失展开状态。

2. 首屏摘要模式与默认展开逻辑冲突
   - 首屏 `/audit/session/<key>?compact=1` 返回的是轻量摘要，`timeline` / `turns` 默认为空。
   - 旧逻辑默认展开第一条 run，但这条 run 在详情回填前其实没有完整数据。
   - 一旦重渲染把展开项重置，用户看到的就会是“展开区在，但 Turns 没了”。

因此，这次问题的本质不是 CSS 单点缺陷，而是：

- 前端把“展开状态”放在临时 DOM 上
- 但“按需详情加载”会触发整体重渲染
- 两者组合后导致 `Turns` 明细被视觉上冲掉

## 修复内容

修复文件：

- [inject.js](../../../extensions/clawlens/ui/inject.js)

本次修复在前端侧栏引入了受控状态：

1. 新增 `CHAT_STATE.expandedRunIds`
   - 用于持久记录哪些 run 当前处于展开状态。
   - 重渲染后根据状态重新决定哪些卡片展开，不再依赖 DOM 临时 class。

2. 新增 `CHAT_STATE.loadingRunIds`
   - 用于标记哪些 run 正在补拉 `/audit/run/<runId>`。
   - detail 加载中时，界面显示 `Loading detail…`，避免用户误判为布局丢失。

3. 修改 run 点击逻辑
   - Chat 侧栏点击 run 标题时，不再直接 `classList.toggle("expanded")`。
   - 改为 `toggleChatRunExpanded(runId)`：
     - 先更新 `expandedRunIds`
     - 再按需调用 `ensureChatRunDetail(runId)`
     - 回填明细后再重新渲染

4. 首条 run 首屏主动补拉详情
   - 新增 `primeInitialChatRunDetail()`
   - 首屏轻量列表成功返回后，默认把第一条 run 放进 `expandedRunIds`
   - 并主动调用 `ensureChatRunDetail(firstRunId)`，避免“默认展开的是空摘要”。

5. 明确空状态文案
   - `renderTimeline()` 在无数据时显示 `No timeline captured for this run.`
   - `renderTurns()` 在无数据时显示 `No turns captured for this run.`
   - 避免将真实空数据误判为布局错误。

## 为什么不是纯布局问题

用户最初的感知是“前端布局有问题，Turns 看不到了”，这个判断从现象上是合理的，但从代码机制看，主因不是：

- 侧栏容器高度不足
- 某个 `overflow: hidden`
- 或 `Turns` 区块被 CSS 隐藏

真正的问题是：**前端重渲染时把当前展开态冲掉了**，导致 detail 区块显示的仍是摘要态或空态。

也就是说，这更接近“前端状态管理回归”，而不是单纯样式回归。

## 影响范围

受影响范围主要是 Chat Audit 侧栏：

- 轻量摘要模式下的 run 展开
- 首屏默认展开的第一条 run
- 异步详情回填后的再次渲染

不影响：

- Audit 抽屉页（左侧 session list + 右侧 detail pane）的基础拉取能力
- 后端 `/audit/run/<runId>` 明细接口本身的数据生成

## 远端同步

本次只同步了前端文件：

- `~/.openclaw/extensions/clawlens/ui/inject.js`

这是纯前端静态资源改动，不依赖 `openclaw-gateway` 重启；页面强刷后即可生效。

## 验证建议

验证时重点看这三点：

1. 打开 Chat 页面，点击 `Audit`
   - 首条 run 默认展开时，应能看到已回填的 `Timeline` / `Turns`

2. 切换展开其他 run
   - 展开后应先出现 `Loading detail…`
   - 随后回填完整明细

3. 若某条 run 确实没有采集到对话 turn
   - 应显示 `No turns captured for this run.`
   - 而不是大片空白或疑似布局塌陷

## 经验教训

当 UI 改成“列表轻量加载 + 点击后按需明细”时，不能继续依赖 DOM 临时 class 表示展开状态。只要异步明细会触发整体重渲染，展开状态就必须进入前端状态机，否则很容易出现：

- 详情回填后展开态丢失
- 用户误以为 detail 没返回
- 或把状态问题误判为布局问题
