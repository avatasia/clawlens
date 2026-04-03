# ClawLens Architecture

> [!IMPORTANT]
> Current Authority: This is the active master version for the current architecture.
>
> 当前权威架构文档。
> 本文以仓库当前代码为准，吸收了已达成共识的修复结论；旧分析稿与过程稿已转入 `docs/archive/`。

## 1. 定位

ClawLens 是一个 OpenClaw 插件，当前主要承担两类能力：

- Chat Audit
  面向 Chat 视图的 run 级审计，包括当前消息到当前 run 的定位、timeline、turns、LLM/tool 统计、heartbeat 分流。
- 运行数据采集与补强
  通过 OpenClaw runtime 事件、plugin hooks、可选 logger 导入，把 run / message / turns / llm calls / tool executions 写入本地 SQLite。

对比功能 `Comparator` 仍保留在代码中，但不是当前文档主线。当前主线是 Chat Audit 与消息归属链。

## 2. 当前系统边界

ClawLens 不尝试替代 OpenClaw 官方 Usage 视图。当前代码的责任边界是：

- 保留 run 级执行明细
- 提供 chat message -> current run 的查询
- 提供 chat-facing 的 Audit 侧栏与 audit drawer
- 将 heartbeat/background run 与普通 chat run 分开
- 提供可选 logger 导入，用于补强 `message_id -> runId` 映射

不负责：

- 替代官方 session 级 Usage 汇总
- 完整重建所有历史脏 run
- 仅靠前端 DOM 建立最终权威消息绑定

## 3. 运行时架构

```text
OpenClaw runtime / hooks
  -> Collector
  -> Store (SQLite)
  -> API Routes + SSE Manager
  -> inject.js / styles.css

Optional:
llm-api-logger files
  -> logger-message-mapper
  -> logger-import
  -> Store source upgrade
```

主要模块：

- `extensions/clawlens/index.ts`
  插件入口、版本检查、服务注册、静态注入、可选启动时 logger 导入
- `extensions/clawlens/src/collector.ts`
  事件采集、run 生命周期管理、transcript 归属、run kind 判定
- `extensions/clawlens/src/store.ts`
  SQLite 存储、聚合、查询、logger 导入状态、消息映射
- `extensions/clawlens/src/api-routes.ts`
  审计接口、message lookup、logger 导入接口
- `extensions/clawlens/src/logger-message-mapper.ts`
  解析 llm-api-logger 三段式日志文件
- `extensions/clawlens/src/logger-import.ts`
  logger 文件选取、容量检查、幂等导入
- `extensions/clawlens/ui/inject.js`
  Control UI 注入脚本，负责 overview panel、audit drawer、chat sidebar
- `extensions/clawlens/ui/styles.css`
  审计 UI 样式与 chat shell 让位布局

## 4. 数据源与职责分工

当前实现使用 6 条主数据源：

| 数据源 | 粒度 | 当前用途 |
|---|---|---|
| `runtime.events.onAgentEvent` | per-run | run start/end/error 生命周期 |
| `runtime.events.onSessionTranscriptUpdate` | per-message | transcript turn 入库、message 级索引 |
| `api.on("llm_input")` | per-call / per-run early signal | prompt preview、run kind 分类、pending transcript drain |
| `api.on("llm_output")` | per-call detail | LLM 调用明细、usage、provider/model、cost |
| `api.on("after_tool_call")` | per-tool-call | tool execution detail |
| `api.on("agent_end")` | per-run fallback | conversation turns 补偿写入 |

额外补强源：

| 数据源 | 用途 |
|---|---|
| llm-api-logger `.jsonl` | 从 prompt 中提取 `message_id -> runId`，提升消息映射精度 |

### 关键认识

- transcript update 是当前消息级能力的核心，不再只是 run 结束后的附属数据
- `llm_output` / `after_tool_call` 必须稳定落库，否则 run detail 会只剩 turns
- logger 导入不是基础链路，而是后续增强链路

## 5. 核心数据模型

### 5.1 `runs`

`runs` 是审计主表，代表一次 agent run。

当前关键字段包括：

- `run_id`
- `session_key`
- `channel`
- `agent_id`
- `provider`
- `model`
- `run_kind`
- `started_at`
- `ended_at`
- `duration_ms`
- `status`
- `error_message`
- `total_llm_calls`
- `total_input_tokens`
- `total_output_tokens`
- `total_cache_read`
- `total_cache_write`
- `total_cost_usd`
- `total_tool_calls`
- `compare_group_id`
- `is_primary`

其中：

- `run_kind` 当前用于区分：
  - `chat`
  - `heartbeat`

### 5.2 `llm_calls`

记录单次 LLM 调用明细。

当前关键字段包括：

- `run_id`
- `call_index`
- `started_at`
- `ended_at`
- `duration_ms`
- `input_tokens`
- `output_tokens`
- `cache_read`
- `cache_write`
- `official_cost`
- `calculated_cost`
- `provider`
- `model`
- `stop_reason`
- `system_prompt_hash`
- `user_prompt_preview`
- `tool_calls_in_response`

### 5.3 `tool_executions`

记录工具执行明细。

当前关键字段包括：

- `run_id`
- `tool_call_id`
- `tool_name`
- `started_at`
- `ended_at`
- `duration_ms`
- `is_error`
- `args_summary`
- `result_summary`

### 5.4 `conversation_turns`

这是当前 message-level 审计的关键索引表。

当前关键字段包括：

- `run_id`
- `session_key`
- `turn_index`
- `role`
- `content_preview`
- `content_length`
- `timestamp`
- `message_id`
- `session_file`
- `source_kind`
- `source_session_id`
- `source_logger_ts`
- `tool_calls_count`
- `tokens_used`

`source_kind` 当前支持的优先级：

1. `transcript_explicit`
2. `llm_prompt_metadata`
3. `session_fallback`

### 5.5 `logger_import_state`

用于记录 logger 文件导入状态，避免重复扫同一文件。

关键字段：

- `file_path`
- `file_mtime_ms`
- `file_size_bytes`
- `imported_at`
- `total_mappings`
- `applied_count`
- `skipped_count`

## 6. 采集链路

### 6.1 run 生命周期

`Collector.handleAgentEvent(...)` 负责消费 `lifecycle` 事件：

- `start`
  建立 active run，并写入 `runs`
- `end`
  延后完成 run，给 trailing hooks 留出写库窗口
- `error`
  以 error 状态完成 run

这里仍然保留了一个短的 completion delay，用于等待尾随 hook 落库。

### 6.2 transcript 归属

当前 transcript 归属顺序是：

1. 显式 `runId`
2. 活跃 run 匹配
3. 最近 run 回查
4. pending queue

对应逻辑在：

- [collector.ts](../extensions/clawlens/src/collector.ts)
- [store.ts](../extensions/clawlens/src/store.ts)

关键修复点已经并入当前架构：

- `sessionKey` 不再要求严格完全相等，允许前缀升级关系
- active run 的 `runKind` 未初始化时不再错误拒绝 transcript
- transcript update 晚于 run 完成时，可用 `findRecentRunIdForSession(...)` 兜底

### 6.3 pending transcript turns

pending queue 仍然存在，但已从“按纯 sessionKey 出队”改成“按 `sessionKey + run kind` 出队”。

这一步是 heartbeat 分流的核心，否则 heartbeat turns 会被普通 chat run 吞掉。

### 6.4 LLM / Tool detail 落库

当前实现里：

- `llm_output`
  直接同步写 `llm_calls`
- `after_tool_call`
  直接同步写 `tool_executions`

原因：

- 之前的异步 `enqueue -> flush` 后置写入曾导致 detail 丢失
- 当前已确认“同步写 detail，延后 completeRun 聚合”是更稳的架构选择

## 7. Heartbeat 与 Chat 分流

这是当前架构中的一个显式子系统，而不是 UI 层过滤技巧。

### 当前策略

- prompt 与 transcript preview 会被分类为：
  - `heartbeat`
  - `chat`
- run 会写入 `run_kind`
- pending transcript turns 也带 `kind`
- chat-facing 查询默认排除 heartbeat

### 读取时纠偏

考虑到历史脏数据已存在，`Store.buildRunAuditDetail(...)` 还会按 turn preview 再做一层 read-time kind 过滤。

这意味着：

- 新数据尽量从采集链上不再混绑
- 旧数据在展示层尽量不再污染 chat

## 8. API 架构

当前主要接口如下：

- `GET /plugins/clawlens/api/overview`
- `GET /plugins/clawlens/api/sessions`
- `GET /plugins/clawlens/api/run/:runId`
- `GET /plugins/clawlens/api/audit`
- `GET /plugins/clawlens/api/audit/run/:runId`
- `GET /plugins/clawlens/api/audit/message/:messageId`
- `GET /plugins/clawlens/api/audit/session/:sessionKey`
- `GET /plugins/clawlens/api/audit/session/:sessionKey/current-message-run`
- `POST /plugins/clawlens/api/audit/logger/import`
- `GET /plugins/clawlens/api/events?token=...`

### `audit/session/:sessionKey`

这是 chat sidebar 的核心接口。

当前支持：

- `limit`
- `before`
- `since`
- `compact=1`
- `excludeKinds=heartbeat`
- `requireConversation=1`

### `current-message-run`

用于把“当前聊天消息”映射到当前最可能的 run。

当前返回并不是最终强绑定真相，而是：

- 当前可用的最佳后端回查结果
- heartbeat 已排除在 chat-facing 路径之外

### logger import

`POST /audit/logger/import` 当前已经是正式接口，不再只是计划项。

它支持：

- 从 `collector.loggerImportDir` 选最新 `.jsonl`
- 或通过 `?file=...` 指定文件
- `force=1` 强制重导

并带有：

- 容量限制
- 幂等跳过
- 明确错误返回

## 9. 前端架构

`inject.js` 当前承担三类 UI：

- Overview 页面小面板
- Audit drawer
- Chat 右侧 Audit sidebar

### Chat sidebar 当前特点

- 以 `audit/session/:sessionKey` 为列表主数据源
- 以 `audit/run/:runId` 为 detail 补拉数据源
- 以 `current-message-run` 为当前消息提示/展开辅助
- 以 SSE 和轻量轮询驱动增量更新

### 当前前端策略

- 列表可走 compact 数据
- detail 按需补拉
- 新 run 到达时自动展开最新 run
- 背景刷新与用户点击/hover 尽量隔离
- chat shell 打开 sidebar 时整体让位，而不是覆盖消息流内部布局

### 稳定性原则

- 不依赖宿主页面模糊 class 选择器修布局
- 只推动最外层稳定 chat shell
- 对 detail merge 做保守合并，避免 compact 覆盖真实 detail

## 10. Logger Mapping 增强链

当前 logger 增强链已经具备工程入口，但仍是可选能力。

### 已实现

- 流式解析三段式 `.jsonl`
- 只对 `user-entry` prompt 提取 `message_id`
- 手动导入接口
- 启动时自动尝试导入
- 幂等跳过

### 当前边界

- 是否能 `applied > 0` 取决于导入文件是否与当前远端 run 数据匹配
- 它提升 message mapping 精度，但不是 chat audit 正常显示的前提

## 11. 运行时与配置约束

当前架构依赖这些工程约束：

- Node.js `22.5.0+`
- `node:sqlite`
- plugin config schema 已定义：
  - `collector.enabled`
  - `collector.snapshotIntervalMs`
  - `collector.retentionDays`
  - `collector.debugLogs`
  - `collector.loggerImportDir`
  - `collector.loggerImportMaxFileSizeMb`
  - `compare.*`

当前 `snapshotIntervalMs` 仍未真正接入 snapshot 调度器。

它现在**不是** DB flush 间隔控制项，当前 flush 仍保持 100ms cadence。

## 12. 当前已知边界

以下是当前仍然存在、但已明确接受的边界：

- logger import 仍是增强链，而非主链
- 历史已写坏 run 不会自动完全重建
- `current-message-run` 是当前最佳回查，不等于理论最终强绑定
- 前端实时层当前仍以前端观察 + 后端回查为主，而不是直接消费稳定的上游消息标识 API
- Comparator 仍在代码中，但本架构文档不把它作为当前主线

## 13. 当前权威文档关系

本文是“当前架构真相源”。

配套阅读顺序建议：

1. [architecture.md](architecture.md)
2. [clawlens-usage.md](clawlens-usage.md)
3. [CHAT_AUDIT_CHANGELOG_2026-04-03.md](archive/chat-audit/CHAT_AUDIT_CHANGELOG_2026-04-03.md)
4. [ANALYSIS_CHAT_AUDIT_REMAINING_WORK.md](ANALYSIS_CHAT_AUDIT_REMAINING_WORK.md)
5. [IMPLEMENTATION_CHAT_AUDIT_REMAINING_WORK.md](IMPLEMENTATION_CHAT_AUDIT_REMAINING_WORK.md)

历史复核、研究过程、旧稿请去：

- [docs/archive/README.md](archive/README.md)
