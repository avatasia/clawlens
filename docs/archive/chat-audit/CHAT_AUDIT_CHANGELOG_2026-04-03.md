# Chat Audit Changelist 2026-04-03

本文基于当前未提交改动生成，只总结已落到工作区的修复，不覆盖既有分析稿。

对应改动范围：

- [index.ts](../../../extensions/clawlens/index.ts)
- [openclaw.plugin.json](../../../extensions/clawlens/openclaw.plugin.json)
- [api-routes.ts](../../../extensions/clawlens/src/api-routes.ts)
- [collector.ts](../../../extensions/clawlens/src/collector.ts)
- [logger-import.ts](../../../extensions/clawlens/src/logger-import.ts)
- [logger-message-mapper.ts](../../../extensions/clawlens/src/logger-message-mapper.ts)
- [store.ts](../../../extensions/clawlens/src/store.ts)
- [types.ts](../../../extensions/clawlens/src/types.ts)
- [inject.js](../../../extensions/clawlens/ui/inject.js)
- [styles.css](../../../extensions/clawlens/ui/styles.css)

## 概览

本轮主要关闭了 4 类问题：

- `[FIX][DATA]` chat message -> run -> turns 的归属链不稳定，最新消息经常缺失或只剩 assistant
- `[FIX][UI]` Audit 侧栏的首屏、展开、刷新、hover、滚动、覆盖布局不稳定
- `[FIX][HEARTBEAT]` heartbeat 与普通 chat run 混绑，污染 turns 与 current-message-run
- `[FIX][OPS]` logger 导入、Node 版本、调试开关、配置 schema 等工程收口缺失

---

## 一、后端数据链修复

### `[FIX][DATA-1]` 最新消息进入 transcript 但不进入 `conversation_turns`

现象：

- `current-message-run` 停留在旧消息
- 最新用户消息已在 session transcript 文件中出现
- Audit 中看不到这条消息对应的 run

修复：

- [collector.ts](../../../extensions/clawlens/src/collector.ts)
- [store.ts](../../../extensions/clawlens/src/store.ts)

具体做法：

- transcript update 归属顺序改为：
  - `explicitRunId`
  - `findActiveRunIdForSessionKind(...)`
  - `findRecentRunIdForSession(...)`
  - 仍无法命中时再进入 pending queue
- 新增 `findRecentRunIdForSession(...)`
  用 `sessionKey + timestamp + kind + 时间窗` 回查最近 run，覆盖“run 已结束但 transcript 晚到”的时序。

根因：

- 原逻辑过度依赖 active run
- 一旦 transcript update 晚于 run 完成到达，就只能等“下一条 run 启动”再被 drain
- 对当前消息展示来说，这个时序模型太脆弱

---

### `[FIX][DATA-2]` 最新 run 只有 assistant，没有 user

现象：

- 最新 run 的 turns 里只剩 assistant
- user transcript 明明在 session transcript 文件中存在

修复：

- [collector.ts](../../../extensions/clawlens/src/collector.ts)

具体做法：

- `findActiveRunIdForSessionKind(...)` 不再要求 `sessionKey` 完全相等
- 允许前缀升级关系命中：
  - `agent:main` -> `agent:main:main`
  - `agent:main:main` -> `agent:main`
- 如果 active run 的 `runKind` 还没确定，不再因为 kind 未初始化而拒绝匹配

根因：

- user transcript 往往到得更早
- 那时 active run 的 `sessionKey` 还可能是短形式，`runKind` 也还没由 `llm_input` 定型
- assistant transcript 来得更晚，反而更容易挂上正确 run

---

### `[FIX][DATA-3]` `llm_calls/tool_executions` 明细丢失

现象：

- run 已命中，但 `llmCalls/toolCalls/timeline` 为 0
- 只看到 transcript turns，看不到调用明细

修复：

- [collector.ts](../../../extensions/clawlens/src/collector.ts)

具体做法：

- `recordLlmOutput()`、`recordToolCall()` 从异步队列后置写入改为同步写库

根因：

- OpenClaw 的 hook 已正常触发，ClawLens 也收到了事件
- 问题出在插件自己的 `enqueue -> flush` 写库闭包并未稳定执行
- 这是插件侧竞态，不是“上游没发 llm_output”

---

### `[FIX][DATA-4]` 运行中摘要不更新

现象：

- 新 run 已执行，但 run 卡片上的 LLM/tool/token 摘要长时间不变

修复：

- [store.ts](../../../extensions/clawlens/src/store.ts)

具体做法：

- detail 组装时不再只依赖 `runs.total_*`
- 运行中优先参考 `llm_calls` / `tool_executions` 的实时记录

根因：

- `runs` 表上的 totals 偏向 `completeRun()` 之后的事后结算
- UI 却试图把它当实时摘要直接显示

---

## 二、Heartbeat / Chat 分流修复

### `[FIX][HEARTBEAT-1]` heartbeat turns 混进普通 chat run

现象：

- heartbeat 的 user/assistant 对话混入正常 chat run
- 一条最新聊天 run 本应只有 2 条 turns，却出现多条 heartbeat turns

修复：

- [collector.ts](../../../extensions/clawlens/src/collector.ts)
- [store.ts](../../../extensions/clawlens/src/store.ts)
- [api-routes.ts](../../../extensions/clawlens/src/api-routes.ts)
- [inject.js](../../../extensions/clawlens/ui/inject.js)

具体做法：

- 为 run 增加 `run_kind`
- 按 prompt/transcript 特征把 run 和 turn 区分为：
  - `heartbeat`
  - `chat`
- pending transcript turn 不再按纯 `sessionKey` 出队，而是按 `sessionKey + kind` 出队
- chat sidebar 默认 `excludeKinds=heartbeat`
- `current-message-run` 查询排除 heartbeat

根因：

- heartbeat 与普通 chat 共用 `agent:main:main`
- 原逻辑只按 sessionKey 做 pending 出队
- 任何 heartbeat turn 都可能被下一条普通 chat run 吞掉

---

### `[FIX][HEARTBEAT-2]` 历史混绑 run 污染当前展示

现象：

- 老 run 已被写坏
- 即使新逻辑修了，旧 run 仍会把 heartbeat turns 带出来

修复：

- [store.ts](../../../extensions/clawlens/src/store.ts)

具体做法：

- 读接口时按 turn preview 再做一层 kind 识别
- 如果 run 中全是 heartbeat turns，则按 heartbeat 解释
- 输出 detail 时只返回与 runKind 匹配的 turns

根因：

- 历史脏数据已经入库
- 仅修采集链无法自动净化旧展示

说明：

- 这次是“读时纠偏”，不是完整历史重建

---

## 三、前端交互与渲染修复

### `[FIX][UI-1]` 首开 Audit 长时间卡在 `Loading…`

现象：

- 进入 chat 页面后第一次打开 Audit，长时间只显示 `Loading…`
- 关闭再打开也一样

修复：

- [inject.js](../../../extensions/clawlens/ui/inject.js)

具体做法：

- 打开侧栏时如果已有内存数据，立即渲染
- 首屏列表返回后先展示列表，再后台补第一条 detail
- 增量刷新返回空时，不再保留假 loading

根因：

- 首屏 detail 预取阻塞了首屏渲染
- 同时“sessionKey 相同”被错误当成“已有可展示内容”

---

### `[FIX][UI-2]` 首次展开 run 看不到 turns，必须再点一次

现象：

- 第一次点击展开只显示：
  - `Expand this run to load turns.`
- 第二次才真正看到 turns

修复：

- [inject.js](../../../extensions/clawlens/ui/inject.js)

具体做法：

- 增加 `needsRunDetailFetch(run)`
- 首次展开需要 detail 的 run 时：
  - 立即进入 `Loading detail… / Loading turns…`
  - 立即发 `/audit/run/:runId`
  - 返回后直接替换成真实 turns

根因：

- 之前把“是否已加载 detail”和“是否需要补拉 detail”混成了一个 `hasDetail`
- 空数组 detail、compact detail、真实 detail 被混淆

---

### `[FIX][UI-3]` run 卡片点击不稳，双击才能开/关

现象：

- 首项 run 单击无法正确关闭
- 某些卡片需要双击才有反应
- 关闭后又会被自动展开顶回来

修复：

- [inject.js](../../../extensions/clawlens/ui/inject.js)

具体做法：

- 将隐式“首项默认展开”与显式 `expandedRunIds` 统一处理
- 一旦用户手动点击过任意 run，后续刷新不再干预展开态
- 点击触发的展开/折叠走即时渲染，不再共享后台刷新保护延迟

根因：

- 自动展开策略、增量刷新、交互保护窗三者互相覆盖
- 用户点击与后台刷新没有彻底隔离

---

### `[FIX][UI-4]` hover 闪烁、点击卡顿、刷新影响交互

现象：

- 轮询存在时 run 卡片 hover 闪烁
- 点击展开/折叠会卡顿
- 后台刷新会打断鼠标交互

修复：

- [inject.js](../../../extensions/clawlens/ui/inject.js)

具体做法：

- DOM 驱动刷新只认真正新增 `.chat-group`
- 增量刷新返回空时不再整块重绘侧栏
- 增加交互保护窗，仅阻止后台渲染覆盖，不阻止用户点击后的即时渲染

根因：

- 之前把“减少刷新频率”和“保证交互稳定”混成一件事
- 结果一边仍然高频刷新，一边又延迟了用户操作反馈

---

### `[FIX][UI-5]` 强制刷新后 turns 消失

现象：

- 当前 run 和历史 run 的 turns 强制刷新后消失

修复：

- [inject.js](../../../extensions/clawlens/ui/inject.js)

具体做法：

- compact 列表 merge 时，如果旧 run 已有 detail，保留 detail，不再被摘要版覆盖
- 当前已展开且仍需 detail 的 run 自动补拉 `/audit/run/:runId`

根因：

- 列表刷新把完整 run 覆盖回 compact run
- 前端把“有 run”误当成“有 detail”

---

## 四、布局与样式修复

### `[FIX][LAYOUT-1]` Audit 打开后覆盖主页面，不给宿主让位

现象：

- Audit 直接覆盖 chat 页面
- 右上角菜单被盖住

修复：

- [styles.css](../../../extensions/clawlens/ui/styles.css)

具体做法：

- 改成给整个 `.shell.shell--chat` 增加右侧留白
- 不再对消息流内部容器单独加 `margin-right`

根因：

- 之前的“让位”策略打到了内部容器
- 覆盖层和宿主布局没有一致的空间分配模型

---

### `[FIX][LAYOUT-2]` 消息气泡右对齐、顶栏、滚动被破坏

现象：

- 用户消息偏左，不再右对齐
- 顶部菜单消失或错位
- 主聊天区滚动手感变差

修复：

- [styles.css](../../../extensions/clawlens/ui/styles.css)

具体做法：

- 不再使用模糊选择器如：
  - `[class*="chat-container"]`
  - `[class*="chat-layout"]`
- 也不再推动 `.chat-main`、`.chat-thread`、输入栏等内层结构
- 只把最外层 chat shell 当作稳定布局单元处理

根因：

- 过度依赖页面内部类名
- 一旦命中过多层级，就会把气泡对齐与滚动上下文一起打坏

---

## 五、Logger 导入与工程加固

### `[FIX][OPS-1]` logger 导入链路缺失

现象：

- 研究结论可用，但没有真实导入入口
- `message_id -> runId` 补强无法落地

修复：

- [logger-import.ts](../../../extensions/clawlens/src/logger-import.ts)
- [api-routes.ts](../../../extensions/clawlens/src/api-routes.ts)
- [index.ts](../../../extensions/clawlens/index.ts)

具体做法：

- 新增统一导入模块 `logger-import.ts`
- 新增手动导入接口：
  - `POST /plugins/clawlens/api/audit/logger/import`
- 启动时若配置了 `collector.loggerImportDir`，自动尝试导入一次

根因：

- 之前只有分析文档，没有工程化入口

---

### `[FIX][OPS-2]` 大日志文件会阻塞进程

现象：

- 原 `logger-message-mapper.ts` 使用 `readFileSync + split("\n")`
- 日志一大就可能阻塞事件循环甚至 OOM

修复：

- [logger-message-mapper.ts](../../../extensions/clawlens/src/logger-message-mapper.ts)

具体做法：

- 改为基于 `readline` 的流式解析

根因：

- 研究阶段只验证了“能解析”，没把“文件量级”和“运行时代价”一起评估

---

### `[FIX][OPS-3]` 重复导入同一 logger 文件

现象：

- 手动导入、启动导入都可能反复扫同一文件

修复：

- [store.ts](../../../extensions/clawlens/src/store.ts)
- [logger-import.ts](../../../extensions/clawlens/src/logger-import.ts)

具体做法：

- 新增 `logger_import_state`
- 按 `filePath + mtime + size` 做幂等跳过

根因：

- 之前只关心“能否导入”，没把“重复导入副作用”纳入设计

---

### `[FIX][OPS-4]` 运行环境与配置 schema 缺失

现象：

- Node.js 版本要求没有前置拦截
- 新 collector 配置没有写进 schema，OpenClaw 会拒绝配置

修复：

- [index.ts](../../../extensions/clawlens/index.ts)
- [openclaw.plugin.json](../../../extensions/clawlens/openclaw.plugin.json)
- [types.ts](../../../extensions/clawlens/src/types.ts)

具体做法：

- 增加 Node.js `22.5.0+` 前置检查，位置放在 `new Store(...)` 之前
- 补齐：
  - `collector.debugLogs`
  - `collector.loggerImportDir`
  - `collector.loggerImportMaxFileSizeMb`

根因：

- 实现前期先写代码，再补配置契约
- 导致“本地可跑”和“框架可接受”脱节

---

## 六、调试与诊断能力

### `[FIX][DEBUG-1]` 排障只能临时加日志，无法按需开启

现象：

- 每次排障都要临时改代码、重新部署

修复：

- [index.ts](../../../extensions/clawlens/index.ts)
- [types.ts](../../../extensions/clawlens/src/types.ts)
- [collector.ts](../../../extensions/clawlens/src/collector.ts)
- [store.ts](../../../extensions/clawlens/src/store.ts)

具体做法：

- 支持通过：
  - `collector.debugLogs: true`
  - `CLAWLENS_DEBUG=1`
  打开排障日志

根因：

- 之前调试能力没有产品化，只能临时插桩

---

## 七、Changelist

可单独作为提交说明使用。

### `[CHANGESET][BACKEND]`

- 为 run 增加 `run_kind`
- 增加 transcript/chat/heartbeat 分流
- 增加 `findRecentRunIdForSession(...)`，覆盖 transcript 晚到场景
- 修复 active run 匹配对 `sessionKey` 前缀和未定 `runKind` 的兼容
- `llm_output` / `after_tool_call` 改为同步写库
- 读接口对历史混绑 turns 做过滤纠偏

### `[CHANGESET][API]`

- `/audit/session/:sessionKey` 支持：
  - `excludeKinds`
  - `requireConversation`
- 新增：
  - `/audit/session/:sessionKey/current-message-run`
  - `/audit/message/:messageId`
  - `POST /audit/logger/import`

### `[CHANGESET][LOGGER]`

- `logger-message-mapper` 改为流式解析
- 新增 `logger-import.ts`
- 新增 `logger_import_state` 幂等导入状态表
- 支持启动自动导入和手动导入

### `[CHANGESET][FRONTEND]`

- 修复首开 `Loading…`
- 修复首次展开 turns 不显示
- 修复 compact/detail merge 覆盖
- 修复 run 自动展开、点击抖动、hover 闪烁
- 新 run 增量到达时默认展开
- chat sidebar 默认排除 heartbeat

### `[CHANGESET][LAYOUT]`

- Audit 打开时改为整个 chat shell 让位
- 不再推动消息流和输入框内部容器

### `[CHANGESET][OPS]`

- 增加 Node.js 版本前置检查
- 补齐 plugin schema 与配置项
- 调试日志开关化

---

## 八、经验教训

### `[LESSON-1]` 先画事件时序图，再写归属逻辑

这轮最贵的问题不是代码难，而是：

- transcript 先到还是 lifecycle 先到
- `llm_input` 在什么时刻把 `runKind/sessionKey` 补全
- `agent_end` 与 transcript update 是否可能交错

如果在分析阶段先把这几条时序画清，就不会一开始写出只依赖 active run 的脆弱逻辑。

建议：

- 每遇到“消息/事件归属”问题，先列出最少 4 条真实时序：
  - 正常 chat
  - transcript 晚到
  - runKind 晚到
  - heartbeat/后台任务混入

### `[LESSON-2]` 不要把“能看到数据”误当成“能正确归属数据”

最开始不少判断只是：

- transcript 文件里有消息
- UI 里也能看到一部分消息

但真正的问题是：

- 这些消息是不是挂到了正确 run
- user / assistant 是否成对
- heartbeat 是否污染 chat

建议：

- 分析阶段必须同时做 3 份对账：
  - transcript 文件
  - DB 索引表
  - API 返回

### `[LESSON-3]` 前端问题先区分“数据没到”还是“渲染没显示”

这轮很多 UI 问题一开始都像样式问题，后面才发现是：

- run detail 被 compact 数据覆盖
- detail 请求根本没发
- session 响应里已有数据，但前端状态被重置

建议：

- 分析阶段先打 2 类最小日志：
  - API 实际返回样本
  - render 函数实际入参
- 不要先改一堆 CSS 或交互节流

### `[LESSON-4]` 避免用模糊选择器修宿主布局

`[class*="chat-layout"]`、`[class*="chat-container"]` 这类选择器在短期看省事，长期会持续踩坑。

建议：

- 先抓一份页面 HTML 快照
- 找稳定骨架层级
- 只改最外层布局单元，不碰消息气泡、thread、输入栏等内层

### `[LESSON-5]` 研究结论落地前，必须补工程约束

本轮 logger 方案一开始只有“理论上能提取 `message_id`”，但少了：

- 文件大小上限
- 流式解析
- 导入幂等
- 权限/目录配置
- schema 校验

建议：

- 分析稿进入实施前，至少补 5 项工程前置：
  - 运行时版本
  - 配置 schema
  - 文件量级
  - 幂等策略
  - 回退/跳过策略

### `[LESSON-6]` 调试能力要产品化，而不是临时插桩

这轮多次依靠临时日志才定位到：

- queue flush 没执行
- detail 请求没发
- render 入参为空数组

建议：

- 对高风险链路预留开关式 debug
- 默认关闭
- 排障时配置开启
- 不要每次现场再加日志、再发布

---

## 结论

当前未提交改动的核心价值不是“补了很多小逻辑”，而是把 Chat Audit 从一条脆弱的“事后拼接链路”，收成了一条更完整的审计链：

- transcript 能更稳定挂到正确 run
- heartbeat 不再污染普通 chat
- 运行中的 run 能显示真实 detail
- 前端侧栏的交互、刷新、布局更接近可用状态
- logger 导入与工程加固具备了后续扩展基础

后续如果继续推进，优先级建议是：

1. 用真实远端 logger 日志验证 `applied > 0`
2. 再做前端实时层的进一步稳固
3. 最后再考虑历史数据补偿，而不是继续扩大当前修复面
