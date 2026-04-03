# Chat Audit Remaining Work Analysis

> [!IMPORTANT]
> Current Authority: This is the active master version for Chat Audit remaining-work analysis.
>
当前主文档，汇总 Chat Audit 剩余增强项及其影响范围。

## 已完成收口项

### 1. Logger import 的真实命中验证

现状：

- 导入接口与幂等状态表已实现
- 状态诊断接口已实现，可返回配置目录、候选文件和最近导入状态
- 远端已接入真实线上 llm-api-logger 目录：`/home/openclaw/.openclaw/logs/llm-api`
- 真实日志格式与参考样本不同，当前已补齐 `Sender (untrusted metadata)` 模板解析
- 当前已用真实日志完成命中验证，已实际出现 `applied > 0`
- 当前远端自动导入也已稳定命中，启动日志已多次出现 `applied > 0`

影响：

- 不影响当前 Chat Audit 基础显示
- 影响 `message_id -> runId` 的增强精度
- 当前 Phase 1 的主要工程目标已完成

### 2. 前端实时层继续收口

现状：

- 当前已有 SSE、轮询、DOM 触发联合驱动
- 当前已完成统一刷新调度、route-change 去重、chat-root 过滤、detail 强刷节流
- 当前已补齐页面隐藏/恢复的刷新抑制与恢复
- 当前已对等价增量结果做 no-op 跳过，减少无效重绘

影响：

- 不影响基础正确性
- 当前这一轮主收口已完成，后续仅剩常规体验优化

### 3. 历史脏数据补偿

现状：

- 当前已对历史脏 run 做读时纠偏
- 但不会自动重建全部历史 run
- 当前已开始做有限元数据补强：
  - 针对缺失或错误的历史 `run_kind`
  - 只在 prompt/turn 特征足够强时回填 heartbeat/chat
- 当前已用手动补强接口验证，已实际出现 `updated > 0`
- 当前也已具备启动时自动补强能力，避免旧数据只能靠手动修正
- 当前已形成“读时纠偏 + 手动补强 + 启动自动补强”的有限补强闭环

影响：

- 旧数据仍可能有局部残留不完美
- 当前不再阻塞 heartbeat/chat 分流与主界面展示

## 仍待继续的长期增强项

### 4. Message-level 强绑定继续增强

现状：

- 当前已有 transcript + current-message-run + 可选 logger import
- 但仍不是理论上的最终强绑定方案

影响：

- 当前已足够支持主功能
- 后续可继续提升定位精度与审计确定性

## 配套文档

- 实施计划：
  [IMPLEMENTATION_CHAT_AUDIT_REMAINING_WORK_2026-04-03.md](IMPLEMENTATION_CHAT_AUDIT_REMAINING_WORK_2026-04-03.md)
- 历史记录：
  [CHAT_AUDIT_REMAINING_WORK_HISTORY.md](../history/CHAT_AUDIT_REMAINING_WORK_HISTORY.md)
