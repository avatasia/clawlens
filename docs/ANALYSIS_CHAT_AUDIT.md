# Chat Audit

> [!IMPORTANT]
> Current Authority: This is the active master version for the Chat Audit theme.
>
当前主文档，描述 ClawLens Chat Audit 的现状、已完成能力和后续工作。

## 当前状态

Chat Audit 主链路当前已经可用：

- 当前消息到当前 run 的回查可用
- run detail 可显示 timeline、turns、LLM/tool 汇总
- heartbeat 与普通 chat run 已分流
- chat 侧栏默认排除 heartbeat
- 运行中 detail 与增量刷新链路已打通
- logger import 已具备工程入口，但属于增强链路

## 当前架构边界

Chat Audit 依赖三条主链：

1. 运行时采集链  
   `onAgentEvent` / `onSessionTranscriptUpdate` / `llm_input` / `llm_output` / `after_tool_call` / `agent_end`
2. 存储与查询链  
   `runs` / `llm_calls` / `tool_executions` / `conversation_turns` / `logger_import_state`
3. 前端展示链  
   `inject.js` + `styles.css` + `audit/session` / `audit/run` / `current-message-run`

## 已达成共识

- transcript 是 message-level 审计的核心来源
- `llm_output` 和 `after_tool_call` 必须稳定落库，否则 run detail 会失真
- heartbeat 必须作为独立 run kind 处理，不能与 chat 共用纯 `sessionKey` fallback
- 前端 detail 不能被 compact 列表覆盖
- 宿主页面布局应只改最外层稳定骨架，不改消息流内部容器

## 当前剩余工作

仍未完成但不阻塞当前主功能的事项：

- logger 自动导入与真实线上日志命中验证
- 前端实时层继续收口
- 历史脏数据补偿策略
- message-level 强绑定继续增强

## 推荐阅读

- 当前架构：
  [architecture.md](architecture.md)
- 当前剩余工作分析：
  [ANALYSIS_CHAT_AUDIT_REMAINING_WORK.md](ANALYSIS_CHAT_AUDIT_REMAINING_WORK.md)
- 当前剩余工作实施计划：
  [IMPLEMENTATION_CHAT_AUDIT_REMAINING_WORK.md](IMPLEMENTATION_CHAT_AUDIT_REMAINING_WORK.md)
- 历史记录入口：
  [CHAT_AUDIT_HISTORY.md](archive/history/CHAT_AUDIT_HISTORY.md)
