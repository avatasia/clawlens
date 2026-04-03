# Chat Audit Remaining Work Implementation Plan

> [!IMPORTANT]
> Current Authority: This is the active master version for Chat Audit remaining-work implementation planning.
>
当前主文档，描述 Chat Audit 剩余工作的实施顺序与当前状态。

## 当前总体状态

- 主链功能状态：已完成并可用
- 当前实施状态：Phase 0 - Phase 4 已全部收口
- 后续状态：仅剩非阻塞长期增强项，不再需要维持独立的 Phase 执行链

## Phase 0

状态：`已完成`

- 已校验 Node.js 运行版本要求
- 已校验 debug 开关接线
- 已校验 schema 与配置项一致性

## Phase 1

状态：`已完成`

- 已完成 logger import 工程入口、自动导入、幂等跳过与流式解析
- 已补充 logger import 状态诊断接口，用于暴露配置目录、候选文件与最近导入状态
- 已接入远端真实线上 llm-api-logger 目录
- 已补齐真实日志格式的解析兼容
- 已使用真实 logger 目录验证 `applied > 0`
- 远端当前自动导入也已稳定命中，启动日志已多次出现 `applied > 0`

## Phase 2

状态：`已完成`

- 已完成当前可用的实时刷新链路
- 已引入统一刷新调度器，收敛 SSE、轮询、DOM、侧栏打开等多源触发
- 已对 route-change 触发增加签名去重，避免宿主 DOM 小变化反复触发同一轮刷新
- 已对 DOM 消息观察增加 chat-root 过滤，避免非 chat 区域的变动误触发刷新
- 已为运行中 run 的 detail 强刷增加最小间隔，减少 detail 级重复重拉
- 已为页面隐藏/恢复增加刷新抑制与恢复机制，避免后台标签页无意义刷新
- 已对等价增量结果增加 no-op 跳过，减少无效重绘
- 继续维持“DOM 只作触发，不作最终真相源”的原则

## Phase 3

状态：`已完成`

- 已收紧前端 `inject.js` 调试日志，默认关闭
- 已完成默认关闭下的静默回归核查
- 当前保留的 `console.error` 仅用于异常路径，不属于默认噪音输出

## Phase 4

状态：`已完成`

- 不做全量历史重建
- 已增加历史 `run_kind` 补强入口，只在证据足够强时回填 heartbeat/chat 类型
- 已增加手动补强接口，用于对旧 run 做有限元数据修正
- 远端已验证补强接口可用，且已实际出现 `updated > 0`
- 已增加启动时自动补强，默认按上限扫描最近历史 run
- 当前已形成“读时纠偏 + 手动补强 + 启动自动补强”的有限补强闭环

## 配套文档

- 分析：
  [ANALYSIS_CHAT_AUDIT_REMAINING_WORK_2026-04-03.md](ANALYSIS_CHAT_AUDIT_REMAINING_WORK_2026-04-03.md)
- 历史记录：
  [CHAT_AUDIT_REMAINING_WORK_HISTORY.md](../history/CHAT_AUDIT_REMAINING_WORK_HISTORY.md)
