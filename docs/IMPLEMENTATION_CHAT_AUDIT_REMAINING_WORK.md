# Chat Audit Remaining Work Implementation Plan

> [!IMPORTANT]
> Current Authority: This is the active master version for Chat Audit remaining-work implementation planning.
>
当前主文档，描述 Chat Audit 剩余工作的实施顺序。

## Phase 0

- 校验 Node.js 运行版本要求
- 校验 debug 开关接线
- 校验 schema 与配置项一致性

## Phase 1

- 继续完成 logger import 的真实线上命中验证
- 使用真实 logger 目录验证 `applied > 0`
- 保持大文件流式解析与幂等跳过逻辑

## Phase 2

- 继续收口前端实时层
- 在不破坏点击/hover 的前提下，缩短当前 run 更新延迟
- 维持“DOM 只作触发，不作最终真相源”的原则

## Phase 3

- 做默认关闭下的静默回归验证
- 确认 debug 开关关闭时无额外噪音输出

## Phase 4

- 对历史脏 run 做有限元数据补强
- 不做全量历史重建

## 配套文档

- 分析：
  [ANALYSIS_CHAT_AUDIT_REMAINING_WORK.md](ANALYSIS_CHAT_AUDIT_REMAINING_WORK.md)
- 历史记录：
  [CHAT_AUDIT_REMAINING_WORK_HISTORY.md](archive/history/CHAT_AUDIT_REMAINING_WORK_HISTORY.md)
