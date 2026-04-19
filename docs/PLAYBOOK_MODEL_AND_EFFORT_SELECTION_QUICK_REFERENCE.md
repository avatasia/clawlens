---
status: active
created: 2026-04-19
updated: 2026-04-19
---

# Model and Effort Selection Quick Reference

> [!IMPORTANT]
> Fast lookup companion for [PLAYBOOK_MODEL_AND_EFFORT_SELECTION.md](PLAYBOOK_MODEL_AND_EFFORT_SELECTION.md).
>
> 快查表只保留默认规则；完整解释、例外讨论和背景理由以主文档为准。

## 一眼判断

1. 先定任务更像**写作 / 合成**，还是**执行 / 核对 / 落地**。
2. 再定默认模型：写作偏 Claude，执行和 review 偏 Codex。
3. effort 默认 `medium`；只有判断难、风险高、首轮深审时再升 `high`。
4. 不要先拉高 effort，再指望补救模型选错。

## 模型默认分流

| 场景 | 默认模型 | 例外 |
|---|---|---|
| 新建主文档、长文整理、方案起草 | Claude | 若本质只是按仓库证据修正文案，切到 Codex |
| Claude 文档首轮外部评审 | Codex `high` | 无 |
| blocker closure check / 第二轮以后窄范围复核 | Codex `medium` | 无 |
| 超长文一致性、跨多文档比对 | 可拆两步时 Claude 合成 + Codex 复核；单 reviewer 时默认 Codex `high` | 不要回到 "`Claude 或 Codex`" 二选一摇摆 |
| 常规代码实现、修 bug、补测试 | Codex `medium` | 跨模块高风险改动升到 `high` |
| 先想方案、后再编码 | Claude 先出方案，Codex 落地 | 若问题空间已清楚，直接 Codex |
| 现象模糊、要先建立假设树 | Claude `high` | 若日志充分且主要工作变成 repo 内取证，切到 Codex |
| 治理 / SOP / playbook 新规则设计 | Claude `high` | 漏洞审查和闭环检查交给 Codex `high` |

## Effort 快查

| Effort | 何时用 | 何时别用 |
|---|---|---|
| `low` | 小范围改字句、格式整理、低风险单点核对 | 首轮深审、高歧义任务、多约束联动 |
| `medium` | 默认档；常规实现、常规文档修改、一般复核、round-2 blocker 验证 | 已明确需要主动挖洞或建立判定框架 |
| `high` | 首轮深审、高风险设计、治理规则设计、目标含糊但必须先判断“怎么算对” | 只是想“更认真一点” |
| `xhigh` | 只在一轮 `high` 后仍暴露高代价盲点时使用 | 绝不能作为首轮直接升档 |

## 什么时候先降档

出现以下任一信号，优先**降档 / 切分轮次 / 缩小 scope**，不要继续硬顶：

- scope 已被上轮 findings 缩得很小
- 当前只是核对现成文本、提取证据、执行 SOP
- session 已接近 context 上限，或 compact 摘要质量开始下降
- cache TTL 暴露时间过长，等待成本高于继续维持高 effort 的收益
- 配额或预算紧张
- 已跨多轮仍未收敛

## 最短口令

- 写文档、做方案、整理长上下文：先用 Claude。
- 改代码、跑命令、做 grounded review：先用 Codex。
- effort 默认 `medium`。
- 首轮深审 / 高风险设计 / 高歧义任务：再升 `high`。
- `xhigh` 只在一轮 `high` 后仍出现高代价盲点时使用。
- 资源、上下文、TTL、预算开始主导成本时，优先降档。
