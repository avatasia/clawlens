# Chat Audit Remaining Work Implementation Plan

## 目标

基于当前已完成的 Chat Audit 主线修复，继续推进剩余增强项，但不回退现有可用链路。

本实施文档覆盖的范围是：

0. 工程加固与校验
1. `llm-api-logger` 自动导入链路
2. 前端实时层接入
3. 调试开关静默回归
4. 历史空明细 run 的补偿策略

## 当前前提

在开始实施前，以下前提必须成立：

- 当前 `current-message-run` 回查链路已稳定
- 当前新 run 的 `llm_calls/tool_executions/timeline` 已能正常写入
- 调试日志默认可关闭，且在需要时可通过：
  - `collector.debugLogs`
  - `CLAWLENS_DEBUG=1`
  开启
- 运行环境满足 Node.js `22.5.0+`

参考文档：

- [CHAT_AUDIT_REMAINING_WORK_ANALYSIS_2026-04-02.md](../../CHAT_AUDIT_REMAINING_WORK_ANALYSIS_2026-04-02.md)
- [CHAT_AUDIT_DETAIL_CAPTURE_FIX_2026-04-02.md](../../CHAT_AUDIT_DETAIL_CAPTURE_FIX_2026-04-02.md)
- [CHAT_AUDIT_DEBUG_LOG_SWITCH_2026-04-02.md](../../CHAT_AUDIT_DEBUG_LOG_SWITCH_2026-04-02.md)
- [CHAT_AUDIT_MESSAGE_MAPPING_DUAL_LAYER_DESIGN_2026-04-02.md](../../CHAT_AUDIT_MESSAGE_MAPPING_DUAL_LAYER_DESIGN_2026-04-02.md)
- [LLM_API_LOGGER_MESSAGE_MAPPING_IMPLEMENTATION_PLAN_2026-04-02.md](../../LLM_API_LOGGER_MESSAGE_MAPPING_IMPLEMENTATION_PLAN_2026-04-02.md)

## 实施原则

- 不破坏当前“后端回查优先”的可用链路
- 每一阶段都必须有独立验收，不允许多阶段混改后再统一排错
- 所有新增链路都必须保留降级路径
- 不把“精度增强”误做成“主链路替换”

## Phase 0：工程加固与校验

### 目标

在继续剩余增强项前，先确认运行前提、调试开关接线状态和运行时保护已满足实施条件。

### 实施内容

1. 调试开关接线校验

- 确认 [index.ts](../../../extensions/clawlens/index.ts) 中已调用：
  - `store.setDebugEnabled(config.collector?.debugLogs)`
- 该项当前代码已满足，但仍应作为后续改动前的回归检查点

2. Node.js 版本前置检查

- 当前实现依赖 `node:sqlite`
- 建议在插件启动路径中增加显式版本检查
- 若 Node.js `< 22.5.0`，应输出明确错误并拒绝启动相关存储能力
- 该检查必须放在 [index.ts](../../../extensions/clawlens/index.ts) 中 `new Store(stateDir)` 之前
- 不应等到 `registerService.start()` 阶段才做

3. 运行前提确认

- 明确远端部署后需重启 `openclaw-gateway`
- 明确 logger 目录必须对 ClawLens 进程可读
- 明确当前实现依赖 Node.js `22.5.0+`

### 完成判据

- 调试开关接线已确认存在且行为正确
- Node 版本不满足时有显式失败路径
- 实施文档中的运行前提与代码状态一致

## Phase 1：接入 llm-api-logger 自动导入

### 目标

把本地已具备解析逻辑的 `logger-message-mapper.ts` 接入可执行链路，使 `llm_prompt_metadata` 成为真实在线来源，而不只是本地模块。

### 实施内容

1. 新增导入入口

- 位置建议：
  - 插件启动后的延迟任务
  - 或单独的手动触发 API / 管理命令
- 第一版建议优先做“手动触发 + 幂等导入”
- 不建议第一步就做高频定时扫描

2. 定义输入目录

- 明确 logger 文件目录来源
- 不在代码里硬编码 repo 内参考路径
- 优先使用插件配置项，例如：
  - `collector.loggerImportDir`
- 第一版要么提供合理默认兜底，要么在导入入口中对缺失配置做显式失败

3. 定义不可读/过大文件策略

- 当 `collector.loggerImportDir` 不存在、不可读或为空时：
  - 返回明确错误
  - 不中断现有 Chat Audit 主链
- 当日志文件体积超过阈值时：
  - 第一版不得沿用 `readFileSync + split("\\n")` 这种整文件无上限读入内存的方式
  - 应采用流式解析，例如基于 stream / readline 的逐段扫描
  - 或在未完成流式改造前直接跳过并记录警告
- 建议实现时同步引入显式容量阈值，例如：
  - `collector.loggerImportMaxFileSizeMb`

4. 对账验证

- 在导入真正上线前，先做一次样本对账：
  - logger `message_id`
  - transcript `messageId`
- 若未证同值，禁止直接合并命名空间

5. 写入规则

- 只对 `user-entry` prompt 做 `message_id -> runId` 提取
- 保留现有来源优先级：
  - `transcript_explicit`
  - `llm_prompt_metadata`
  - `session_fallback`
- 不允许低优先来源覆盖高优先来源

### 涉及文件

- [logger-message-mapper.ts](../../../extensions/clawlens/src/logger-message-mapper.ts)
- [store.ts](../../../extensions/clawlens/src/store.ts)
- [index.ts](../../../extensions/clawlens/index.ts)
- 如需触发入口，再补：
  - [api-routes.ts](../../../extensions/clawlens/src/api-routes.ts)

### 完成判据

- 可对指定 logger 文件执行一次幂等导入
- 导入不会误提取 subagent/startup/cron/announce run
- 导入后 `conversation_turns.source_kind = llm_prompt_metadata` 可被实际查到
- 重复导入不会造成重复记录或错误覆盖
- 目录不可读或文件超阈值时，错误处理行为明确且不影响现有 Chat Audit 主链

## Phase 2：前端实时层接入

### 目标

在不替换后端回查主链路的前提下，引入前端实时层，提升“当前页面消息定位”的响应速度。

### 实施内容

1. 明确前端输入源

- 优先确认 control-ui 是否存在稳定的消息 ID / seq 可读入口
- 不允许直接依赖脆弱 DOM 结构作为唯一数据源

若最终确认当前阶段唯一可用来源仍然是 DOM：

- 第一版直接收敛为 `MutationObserver + 严格降级`
- 不等待未来“稳定 API”再启动实现
- 但必须在文档和代码中明确标注：该来源属于脆弱来源，不是稳定契约
- 降级逻辑默认应保持静默，仅在 debug 模式下输出原因

2. 接入方式

- 第一版建议只做“提示增强”，不做主链路替换
- 即：
  - 前端实时层提供当前消息候选
  - 后端仍保留 `current-message-run` 作为最终确认链路

3. 降级策略

- 若前端无法可靠读取消息 ID，则自动退回当前后端回查方案
- 不允许因为前端实时层失败而影响现有 Chat Audit 正常显示

### 涉及文件

- [inject.js](../../../extensions/clawlens/ui/inject.js)
- 如需补后端协同，再看：
  - [api-routes.ts](../../../extensions/clawlens/src/api-routes.ts)

### 完成判据

- 当前页面有新消息进入时，前端能更快聚焦当前 run
- 前端实时层失效时，现有后端回查行为不变
- 不新增 CSP 风险
- 不依赖内联脚本
- 若第一版依赖 DOM，则必须定义明确的 MutationObserver 触发条件和失效回退路径

## Phase 3：调试开关静默回归

### 目标

验证在默认关闭状态下，不会产生额外 debug 日志；在开启状态下，日志可用于复现 run 绑定和 detail capture 问题。

### 实施内容

1. 默认关闭验证

- 启动网关，不设置：
  - `collector.debugLogs`
  - `CLAWLENS_DEBUG`
- 执行一次完整 chat 流程
- 确认日志中无：
  - `clawlens-debug`
  - `clawlens-store`

2. 开启验证

- 分别用配置和环境变量打开调试日志
- 确认两套前缀都能按预期输出

### 完成判据

- 默认关闭时零 debug 输出
- 开启后能稳定输出 Collector / Store 两类日志
- 开关方式与文档一致

## Phase 4：历史空明细 run 补偿策略

### 目标

决定是否为修复前的历史异常 run 提供“元数据补强”，而不是默认承诺“全量数据恢复”。

### 可选路径

路径 A：不补偿

- 保持历史数据原样
- 文档注明“修复前历史 run 可能仅有 transcript”

路径 B：基于 logger 重建

- 仅在 logger 可用且命名空间对账成立后考虑
- 只补可安全重建的元数据字段，例如：
  - `message_id -> runId`
  - `source_kind`
  - `source_logger_ts`
- 不承诺 100% 恢复所有历史 `llm_calls/tool_executions/timeline`
- 默认不把这条路径描述成“全量恢复”

### 完成判据

- 至少明确产品策略
- 不再让“历史空明细是否会修”保持悬空

## 推荐实施顺序

1. Phase 0：工程加固与校验
2. Phase 1：logger 自动导入
3. Phase 2：前端实时层
4. Phase 3：调试开关静默回归
5. Phase 4：历史补偿策略

## 不在本轮实施范围内

以下内容不建议混入当前剩余项实施：

- 重新设计整个 Chat Audit 数据模型
- 改写现有 transcript 写入机制
- 依赖上游 OpenClaw 立刻新增 message-run 强绑定字段

这些都应视为后续架构演进，而不是当前剩余项落地的一部分。

## 结论

当前已经具备开始编写剩余项实施代码的条件。

但应遵循：

- 先完成工程加固与校验
- 再接入 logger 自动导入
- 再做前端实时增强
- 所有增强都必须保留当前可用的后端回查主链路
