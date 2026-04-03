# Chat Audit Remaining Work Implementation Plan

> [!IMPORTANT]
> Current Authority: This is the active master version for Chat Audit remaining-work implementation planning.
>
当前主文档，描述 Chat Audit 剩余工作的实施顺序与当前状态。

## 当前总体状态

- 主链功能状态：已完成并可用
- 剩余项状态：非阻塞增强项
- 当前建议：继续按 Phase 1 -> Phase 4 收口，不再重建新的实施计划

## Phase 0

状态：`已完成`

- 已校验 Node.js 运行版本要求
- 已校验 debug 开关接线
- 已校验 schema 与配置项一致性

## Phase 1

状态：`进行中`

- 已完成 logger import 工程入口、自动导入、幂等跳过与流式解析
- 仍需继续完成真实线上命中验证
- 仍需使用真实 logger 目录验证 `applied > 0`

## Phase 2

状态：`进行中`

- 已完成当前可用的实时刷新链路
- 仍需继续收口前端实时层
- 仍需在不破坏点击/hover 的前提下，继续缩短当前 run 更新延迟
- 继续维持“DOM 只作触发，不作最终真相源”的原则

## Phase 3

状态：`未开始`

- 需要做默认关闭下的静默回归验证
- 需要确认 debug 开关关闭时无额外噪音输出

## Phase 4

状态：`未开始`

- 需要对历史脏 run 做有限元数据补强
- 不做全量历史重建

## 配套文档

- 分析：
  [ANALYSIS_CHAT_AUDIT_REMAINING_WORK.md](ANALYSIS_CHAT_AUDIT_REMAINING_WORK.md)
- 历史记录：
  [CHAT_AUDIT_REMAINING_WORK_HISTORY.md](archive/history/CHAT_AUDIT_REMAINING_WORK_HISTORY.md)
