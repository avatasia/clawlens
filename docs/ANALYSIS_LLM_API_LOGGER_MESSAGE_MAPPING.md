# LLM API Logger Message Mapping

> [!IMPORTANT]
> Current Authority: This is the active master version for logger-based message mapping.
>
当前主文档，描述 llm-api-logger 在 ClawLens 中的用途、现状和实施边界。

## 目标

利用 llm-api-logger 的 request prompt，从主入口 prompt 中提取 `message_id`，增强 `message_id -> runId` 映射。

## 当前已实现

- `logger-message-mapper.ts`
  已支持流式解析三段式 `.jsonl`
- 只对 `user-entry` prompt 提取 `message_id`
- `logger-import.ts`
  已支持目录选取、容量限制、幂等导入
- `POST /plugins/clawlens/api/audit/logger/import`
  已可手动触发导入
- 启动时可按配置自动尝试导入

## 当前边界

- logger import 是增强链，不是基础链
- 真实线上是否命中，取决于导入文件与当前 run 数据是否匹配
- 当前仍需保留 transcript / current-message-run 作为主链

## 推荐阅读

- 当前架构：
  [architecture.md](architecture.md)
- 历史记录：
  [LLM_API_LOGGER_MESSAGE_MAPPING_HISTORY.md](archive/history/LLM_API_LOGGER_MESSAGE_MAPPING_HISTORY.md)
