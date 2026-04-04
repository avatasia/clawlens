# OpenClaw Stale Tool Result Replay PR Materials

> [!IMPORTANT]
> Current Status: 本文件是 `Phase 1` 提交 OpenClaw PR 前的材料清单。
> 它不替代主分析稿和主实施稿，只用于收拢当前已具备的证据、验证和提交边界。

## 目标

为 `stale diagnostic toolResult replay pollution` 这条修复线提供一份最小 PR 准备清单，确保：

- 问题定义一致
- patch 来源清楚
- 验证记录完整
- PR 说明边界收紧

## 当前已具备材料

### 1. 根因研究

- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](../research/RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md](../research/RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_HISTORY_REPLAY_BEHAVIOR_2026-04-04.md](../research/RESEARCH_OPENCLAW_TOOL_RESULT_HISTORY_REPLAY_BEHAVIOR_2026-04-04.md)

### 2. 主方案

- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](../archive/analysis/IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)

### 3. 范围控制

- [ANALYSIS_OPENCLAW_PR_SCOPE_CONTROL_2026-04-03.md](ANALYSIS_OPENCLAW_PR_SCOPE_CONTROL_2026-04-03.md)

### 4. 验证记录

- [REVIEW_OPENCLAW_STALE_TOOL_RESULT_REPLAY_VALIDATION_2026-04-04.md](REVIEW_OPENCLAW_STALE_TOOL_RESULT_REPLAY_VALIDATION_2026-04-04.md)

### 5. Patch

- [OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_2026-04-04.patch](../../patches/openclaw/OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_2026-04-04.patch)

## PR 核心叙述

PR 说明建议固定传达以下几点：

1. 这不是跨渠道读取问题。
2. 这不是单纯模型幻觉。
3. 根因是：
   - 旧的诊断型 `toolResult` 会进入后续 replay
   - provider 输入转换不显式传递 `timestamp`
   - 模型在混合历史里不一定稳定按“最新优先”采信
4. 第一版只做：
   - `Tag & Expire`
   - replay 侧摘要化替换
   - 少量明确高风险诊断类型
5. 第一版明确不做：
   - compaction 扩展
   - assistant 文本污染治理
   - 全量上下文治理

## PR 前最小检查清单

提交 PR 前，至少应确认：

1. patch 基于：
   - `OpenClaw v2026.4.2`
2. 对应测试通过：
   - `src/agents/session-tool-result-guard.test.ts`
   - `src/agents/pi-embedded-runner.sanitize-session-history.test.ts`
3. 关键行为验证通过：
   - 旧成功结果
   - 新失败/空结果
   - 后续 replay 不再原样沿用旧成功结果
4. 替换时未破坏 `toolResult.content` 的原结构类型
5. 正常多轮任务未出现明显回退

## PR 描述建议结构

建议 PR 描述按以下顺序组织：

1. Problem
2. Root cause
3. Why timestamp alone does not solve it
4. Proposed fix
5. Scope deliberately excluded
6. Validation

## 当前状态判断

按当前材料，`Phase 1` 已经满足：

- 研究闭环
- 方案闭环
- 本地测试
- 远端完整包验证
- patch 导出

因此当前已可以进入：

- 你的 OpenClaw fork 应用 patch
- 再做一次 fork 内验证
- 整理 PR 说明并提交

## 相关文档

- [IMPLEMENTATION_OPENCLAW_PR_WORKFLOW_2026-04-03.md](IMPLEMENTATION_OPENCLAW_PR_WORKFLOW_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_REMOTE_DEBUG_PATCH_WORKFLOW_2026-04-03.md](IMPLEMENTATION_OPENCLAW_REMOTE_DEBUG_PATCH_WORKFLOW_2026-04-03.md)
