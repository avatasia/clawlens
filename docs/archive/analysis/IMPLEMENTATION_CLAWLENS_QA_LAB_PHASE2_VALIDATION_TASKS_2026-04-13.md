---
status: active
created: 2026-04-13
updated: 2026-04-13
---

# ClawLens QA Lab Phase 2 验证任务单（待纳入项）

## 目标

将当前 SOP 中“待验证后纳入”的能力拆成可执行任务，逐项验证后再并入主 SOP。

## 执行原则

- 每个任务必须先产出证据，再讨论纳入。
- 未通过验收的任务不得写入主流程。
- 失败结论也要沉淀（避免重复踩坑）。

## 任务列表

## 当前状态（2026-04-13）

| 任务 | 状态 | 备注 |
|---|---|---|
| T1 `qa up` Docker lane | completed | 网络与镜像链路已打通；新增自动脚本 `scripts/run-clawlens-qa-docker-smoke.sh`，可自动完成 `qa up` + ClawLens 注入 + `overview/sessions/audit` 验证 |
| T3 provider 矩阵 | completed | minimax lane、openai-codex lane、openai -> openai-codex fallback lane 已取证；本地默认模型已回滚 |
| T4 CI 轻量自动回归 | completed | 新增 smoke 脚本；已完成 2 次串行样例并通过 |

## 本轮范围重申（已确认）

- 本轮主目标：本地运行 QA Lab 验证 ClawLens（非远程部署）。
- 因此：
  - T1/T3/T4 的已完成结论可纳入本地 SOP。

## 剩余未完成项（本轮收口后）

- 无（本轮本地范围内项已完成）。

## T1. `qa up` Docker lane 可执行性验证

范围：

- 验证 `openclaw qa up` 在当前本地环境的最小可运行路径。
- 不要求覆盖所有 provider，仅验证 ClawLens 联调需要的最小链路。

前置：

- 本地 Docker 可用。
- `projects-ref/openclaw` 已构建。

步骤（建议）：

1. 使用 `qa up --use-prebuilt-image` 验证 image 模式。
2. 使用默认 build 模式验证 compose build 路径。
3. 对比启动耗时、失败点、恢复路径。

验收标准：

- 能稳定拉起 QA Lab + Gateway。
- ClawLens API 在 gateway 端口可访问。
- 至少一条 smoke run 成功并可在 audit 查询到。

证据产物：

- 命令与完整输出日志。
- 关键接口返回：`overview/sessions/audit`。
- 失败分支与恢复步骤（若存在）。

本轮证据：

- `docs/research/RESEARCH_CLAWLENS_QA_LAB_PHASE2_T1_LOCAL_DOCKER_VALIDATION_2026-04-13.md`
- `scripts/qa-docker-lane-precheck.sh`
- `scripts/run-clawlens-qa-docker-smoke.sh`

## T3. provider 多配置矩阵验证

范围：

- 在“非 minimax-cn 单一路径”下验证 SOP 兼容性。
- 重点验证 provider onboarding 与失败分流。

候选矩阵（最小）：

- minimax-cn-api
- openai-api-key 或 openai-codex
- 一条 fallback 组合

验收标准：

- 每种配置可跑通 1 条 smoke run。
- 错误信息可定位且分流步骤清晰。
- 审计端数据口径一致（run/session/audit）。

证据产物：

- 每种配置的命令、返回、失败样例。
- 对应修复动作与复测结果。

本轮证据：

- `docs/archive/analysis/RESEARCH_CLAWLENS_QA_LAB_PHASE2_T3_PROVIDER_MATRIX_PRECHECK_2026-04-13.md`

## T4. CI 轻量自动回归方案

范围：

- 设计并验证“最小自动化”而非一次性全自动。
- 目标是每日可跑、可定位、可回放。

步骤（建议）：

1. 固定 smoke 场景（单会话、含工具调用）。
2. 自动采集 `overview/sessions/audit` 三接口。
3. 输出结构化结果（pass/fail + 失败摘要）。

验收标准：

- 本地可脚本化重复执行。
- 失败时输出可直接用于排障。
- 不依赖人工 UI 点击。

证据产物：

- 自动化脚本与样例输出。
- 至少 2 次连续运行结果。

本轮证据：

- `scripts/run-clawlens-qa-smoke.sh`
- `docs/archive/analysis/RESEARCH_CLAWLENS_QA_LAB_PHASE2_T4_CI_SMOKE_AUTOMATION_2026-04-13.md`

## 建议顺序（本地目标）

1. T1（本地 Docker lane）
2. T3（provider 矩阵）
3. T4（CI 轻量化）

## 纳入门槛

任务完成后，满足以下条件才可并入主 SOP：

- 步骤可重复。
- 验收标准可量化。
- 失败分流有明确下一步。
- 证据产物可复核。
