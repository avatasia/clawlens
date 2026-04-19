---
status: active
created: 2026-04-19
updated: 2026-04-19
---

# Model and Effort Selection Playbook

> [!IMPORTANT]
> Current Authority: This is the active master version for model-family and reasoning-effort selection guidance in this repo.
>
> 当前主文档，定义在本仓库内如何为不同任务选择模型家族与 effort 档位。

> [!NOTE]
> **Heuristic document, not benchmark truth.**
> 本文基于当前仓库的实际协作经验整理，不宣称对所有任务、所有版本、所有团队都最优。若与你们的真实质量数据冲突，以实际效果覆盖本文。

## 目标

本稿保留原 playbook 的主判断框架，只收紧四类问题：

1. 把会导致分流摇摆的 "`Claude 或 Codex`" 改成**有默认值的规则**。
2. 把 **budget / context headroom / cache TTL exposure** 纳入 effort 降档判断。
3. 把 `xhigh` 的触发条件写得更具体，避免它退化成“再认真一点”。
4. 删除未定义的第三选项，保持全文仍以 Claude / Codex 二元路由为主。

## 核心判断顺序

先定**任务形状**，再定**模型家族**，最后定 **effort**。

1. 任务更像**合成 / 写作 / 长文整理**，还是更像**执行 / 核对 / 落地 / 反驳**。
2. 任务输入是**模糊目标**，还是**已有明确约束与验收标准**。
3. 错误代价是**局部返工**，还是**会污染主文档、评审结论或高风险代码路径**。

资源约束不是新的主判断轴，而是 **effort 校正器**：

- 若 session 已接近 context 上限、cache TTL 暴露时间过长、配额紧张，或多轮高 effort 仍未收敛，应优先**降档 / 切分轮次 / 缩小 scope**。
- 这类场景与 [PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md](PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md) 的 Layer 1 / Layer 2 / Context high-water 决策联动，不应把高 effort 当成默认补救手段。

不要先把 effort 拉高，再指望它弥补模型家族选择错误。

## Claude 与 Codex 的默认分工

### Claude 更合适的场景

- 长文起草、结构重组、把零散材料压成一份可读主文档。
- 多轮讨论后，需要保留上下文中的因果链、语气和整体叙事。
- 需要把多个开放问题组织成一套成文方案，而不是先做强对抗式审查。
- 文档写作里重视“可读性 + 完整表达 + 长上下文连贯性”。

### Codex 更合适的场景

- 代码实现、代码修改、命令执行、测试验证、repo 内取证。
- 文档复核，尤其是要抓流程漏洞、约束冲突、遗漏步骤、未闭环条件。
- 对已有文本做“挑刺式”审查，而不是温和补写。
- 任务已经有明确边界，需要按仓库现状做 grounded 判断。

### 简化理解

- **Claude** 偏 writer / synthesizer。
- **Codex** 偏 executor / verifier / devil's advocate。

这不是能力上限，而是默认成功率更高的分工。

## Effort 档位的实际含义

### `low`

适合机械性任务：

- 小范围改字句
- 格式整理
- 已有明确模板的轻微改写
- 明确且低风险的单点核对

不适合：

- 首轮深审
- 高歧义需求
- 涉及多处约束联动的文档或代码改动

### `medium`

默认档位，适合大多数生产任务：

- 常规代码实现
- 常规文档修改
- 有明确 review scope 的复核
- 一般性 bug 排查
- 第二轮及之后的 blocker 验证

如果你没有明确理由开更高档，先用 `medium`。

### `high`

适合“不是信息量大，而是判断难”的任务：

- 首轮深度评审，需要主动发现问题而不只是核对
- 架构设计、流程设计、治理规则设计
- 高风险重构前的方案推演
- 范围较大的回归风险审查
- 任务目标不够清晰，需要先建立判定框架

不应把 `high` 当成“认真一点的默认值”。

### `xhigh`

`xhigh` 只在 `high` 已经试过一轮、但仍暴露出**高代价盲点**时才成立。

典型触发（下列每一项都以“`high` 已完成一轮后仍暴露该风险”为前提，不得作为首轮直接升档理由）：

- 前一轮 `high` 评审后，下一轮首次暴露新的 critical finding。
- 高风险设计分歧里，`high` 已无法收敛，仍需显式展开 2 到 3 条可能失败路径再做裁决。
- 复杂策略文档或架构方案会成为后续多轮协作锚点，且 `high` 那一轮已证明单轮判断不足以覆盖遗漏代价。

不应升级到 `xhigh` 的场景：

- 常规评审、常规编码、常规文档修改。
- 只是想“再认真一点”但没有新风险信号。
- `high` 仍足够覆盖问题空间时。

一句话判断：

- `high` 已够用时不要升 `xhigh`。
- 只有在 `high` 一轮后仍出现高代价盲点时，才考虑 `xhigh`。

## 任务类型与推荐组合

### 文档起草

| 任务 | 推荐模型 | 推荐 effort | 原因 |
|---|---|---|---|
| 新建主文档、从零成稿 | Claude | `medium` / `high` | 需要长文合成、结构铺陈、整体语气一致 |
| 既有文档局部修订 | Codex（默认）；若同轮需要保留跨段叙事和语气连续性则 Claude | `medium` | 默认按仓库证据准确落稿；只有叙事连续性成为主目标时才切回 Claude |
| 把多份笔记合并成单文档 | Claude | `high` | 需要长上下文压缩与结构重排 |

规则：

- 起草优先保证结构和语气稳定，先选 Claude。
- 若任务本质是“按仓库证据修正一段文档”，默认转给 Codex。

### 文档评审

| 任务 | 推荐模型 | 推荐 effort | 原因 |
|---|---|---|---|
| Claude 写的文档做外部首轮评审 | Codex | `high` | 需要跨家族 + 主动挑漏洞 |
| 第二轮以后只验证 blockers 是否修复 | Codex | `medium` | 范围已收窄，重点是核对闭环 |
| 超长文一致性、跨多文档比对 | 可拆两步时 Claude 负责合成、Codex 负责结构复核；仅有单轮/单 reviewer 时默认 Codex `high` 做结构复核 | `high` | 长链一致性与局部约束校对需要分工；单轮时以 grounded 结构复核为主，放弃合成侧收益 |
| 同家族互评 | 不推荐 | - | 容易变成 rubber-stamp |

针对当前仓库的默认口径：

- **Claude 写，Codex 审** 是文档评审的首选组合。
- 若评审目标是“round 2 blocker closure check”，Codex 用 `medium` 通常足够。
- 若评审目标是“first-pass deep review”，Codex 才值得开到 `high`。

这与 [PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md](PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md) 的 reviewer 选型一致。

### 代码实现

| 任务 | 推荐模型 | 推荐 effort | 原因 |
|---|---|---|---|
| 常规实现、修 bug、补测试 | Codex | `medium` | grounded、执行稳定、便于直接验证 |
| 跨模块高风险改动 | Codex | `high` | 需要更强的回归和边界意识 |
| 先想方案、后再编码 | Claude 先出方案，Codex 落地 | Claude `high` + Codex `medium`/`high` | 先分解问题，再做仓库内执行 |

规则：

- 真正要改仓库时，优先让 Codex 执行。
- 需要先把问题空间讲清楚时，可以先让 Claude 起草方案，再交给 Codex 落地。

### 调试与排障

| 任务 | 推荐模型 | 推荐 effort | 原因 |
|---|---|---|---|
| 明确报错、可复现、日志充分 | Codex | `medium` | 更适合逐步取证和命令验证 |
| 现象模糊、需要先建立假设树 | Claude（默认）；若日志已充分、主要工作变成 repo 内取证则 Codex | `high` | 默认先建模问题空间；证据密集型验证再切回 Codex |
| 回归验证、复测 SOP 执行 | Codex | `medium` | 需要严格执行和结果比对 |

### 治理 / SOP / Playbook 设计

| 任务 | 推荐模型 | 推荐 effort | 原因 |
|---|---|---|---|
| 新规则设计、流程编排 | Claude | `high` | 需要组织规则层次和叙述完整性 |
| 规则漏洞审查、闭环性检查 | Codex | `high` | 需要反例意识和约束核对 |
| 后续窄范围修订 | Codex（默认）；若仍在同轮连续重写大段叙事则 Claude | `medium` | 默认以准确更新为主；仅在叙事连续性主导时回切 Claude |

## 评审场景的默认配方

### 配方 A：首轮文档深审

- Writer: Claude
- Reviewer: Codex
- Writer effort: `medium` 或 `high`
- Reviewer effort: `high`

适用：

- 新 playbook
- 新 SOP
- 结构性重写
- 预计 reviewer 需要主动挖洞，而不是只做核对

### 配方 B：第二轮 blocker 复核

- Writer: Claude
- Reviewer: Codex
- Writer effort: `medium`
- Reviewer effort: `medium`

适用：

- 上一轮 blocker 已经明确
- 本轮只确认修复是否闭环
- 不重新讨论已冻结决定

### 配方 C：代码方案 + 落地

- 方案：Claude `high`
- 实施：Codex `medium`；若跨模块或回归半径明显增大，再升到 `high`
- 验收：Codex `medium`

适用：

- 问题空间复杂，但最终还要回到仓库执行

## 什么时候该升 / 降 effort

### 从 `medium` 升到 `high`

满足以下任一条件，再考虑升档：

- 任务目标本身含糊，需要先澄清“怎么算对”。
- 需要同时满足多条治理规则、流程规则或接口约束。
- 过去一轮已经漏过关键问题。
- 这次输出会成为后续多轮协作的锚点文档。
- 失败代价不是“多改一次”，而是会污染后续 review / handoff / frozen decisions。

### 从 `high` 降回 `medium`

满足以下任一条件，应优先降档而不是硬顶：

- scope 已被上轮 findings 缩得很小。
- 当前任务只是核对现成文本是否满足明确条件。
- 主要工作是提取证据、比对行文、更新少量段落。
- 任务瓶颈不是推理，而是执行、查证或等待工具结果。
- session 已接近 context 上限，或最近一次 compact 摘要质量开始下降。
- cache TTL 暴露时间过长，等待 reviewer / 工具结果的成本已经高于继续维持高 effort 的收益。
- 配额或预算紧张，继续高 effort 会压缩后续轮次。
- 已跨多轮仍未收敛，此时更应该切任务、重写 handoff、或拆分评审目标，而不是无上限加 effort。

## 常见误区

1. **把 `high` 当默认值。**
   结果通常是更慢、更贵，但结论质量未必同步上升。
2. **用同家族 reviewer 审同家族 writer。**
   容易错过共享盲点。
3. **模型选错后靠 effort 补救。**
   例如拿偏写作型的模型做高强度代码落地，收益有限。
4. **scope 很窄还坚持高 effort。**
   典型场景是 round-2 blocker 验证，这时 `medium` 往往更合理。
5. **资源约束已经主导成本，还继续靠高 effort 硬顶。**
   这时更应该缩 scope、降档或切轮次。
6. **任务明明需要仓库证据，却只做抽象讨论。**
   这类任务应直接转给更擅长 grounded 执行的模型。

## 最短决策法

- 写文档、做方案、整理长上下文：先用 Claude。
- 改代码、跑命令、做 grounded review：先用 Codex。
- effort 默认 `medium`。
- 只有在**首轮深审 / 高风险设计 / 高歧义任务**时再升到 `high`。
- 资源、上下文、TTL、预算开始主导成本时，优先降档或切分轮次。
- `xhigh` 只在 `high` 一轮后仍出现高代价盲点时使用。

## 相关文档

- [PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md](PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md) — Claude writer / 外部 reviewer 多轮评审闭环
- [PLAYBOOK_ANALYSIS_PROMPT.md](PLAYBOOK_ANALYSIS_PROMPT.md) — 分析提示词入口
- [PLAYBOOK_ENGINEERING_LESSONS.md](PLAYBOOK_ENGINEERING_LESSONS.md) — 仓库沉淀出的通用工程经验
