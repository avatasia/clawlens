# OpenClaw QA/Lab 远程状态研究（2026-04-11）

## 背景

本研究记录一次远程环境（`szhdy`）上的 QA/Lab 可用性核验与部署收敛，目标是回答：

1. `openclaw qa` 是否已可直接使用。
2. 当前 `v2026.4.10` 在该远程环境下的缺口是什么。
3. 对 ClawLens 的直接价值与后续研究入口是什么。

## 关键结论

1. 远程 `openclaw` 版本为 `2026.4.10 (44e5b62)`。
2. 在默认安装态下，`openclaw qa --help` 会失败：
   - `qa scenario pack not found: qa/scenarios/index.md`
3. 根因是安装目录缺失 `qa/` 场景包目录；并非 `qa-lab` 代码本体损坏。
4. 部署 `qa/scenarios` 后，`qa` 子命令恢复可用，且 `qa run` 自检通过（`Passed: 2, Failed: 0`）。

## 证据与验证

### 1) 版本与失败现象

- 命令：`openclaw --version`
- 结果：`OpenClaw 2026.4.10 (44e5b62)`

- 命令：`openclaw qa --help`
- 结果：启动失败，报错缺少 `qa/scenarios/index.md`。

### 2) 安装包结构复核

检查安装目录后确认：

- 存在：`dist/`、`docs/`、`skills/` 等。
- 缺失：`qa/` 目录。
- `dist/scenario-catalog-*.js` 内部硬编码读取路径：`qa/scenarios/index.md`。

这说明 `qa` 命令依赖运行时可读的场景包目录，而该目录在当前安装态没有随包落地。

### 3) 远程部署动作（已执行）

将仓库参考源中的场景包同步到远程安装目录：

- 来源：`projects-ref/openclaw/qa/`
- 目标：`/home/openclaw/.nvm/versions/node/v24.14.0/lib/node_modules/openclaw/qa/`

部署后回归：

- `openclaw qa --help`：成功显示完整子命令列表。
- `openclaw qa run --repo-root <openclaw-install-root> --output /tmp/openclaw-qa-selfcheck-2026-04-11.md`：成功。
- 报告结果：`Passed: 2`, `Failed: 0`。

## 对 ClawLens 的价值

1. 可作为稳定、可重复的回归流量发生器，覆盖 DM/thread/reaction/edit/delete 等通道行为。
2. 可输出结构化 QA 报告，作为 ClawLens 审计结果的对照样本。
3. 可用于后续验证 ClawLens 在不同模型/模式下的 run 采集完整性（结合 `qa suite`、`qa character-eval`）。

## 未完成项与风险

1. 当前远程仍有配置校验告警（`openclaw.json` 中部分键不兼容），虽然不阻断 `qa run`。
2. 当前部署是“补齐场景包”收敛方案；是否应由上游发布流程直接打包 `qa/`，需继续确认。
3. `qa suite`、`qa up`、`qa character-eval` 仍需单独做链路级验证（provider、docker、并发等）。

## 后续深入研究建议

1. 研究 `qa suite` 与 ClawLens 审计 API 的自动对账：
   - `run` 数量
   - tool 调用计数
   - turns 完整性
   - heartbeat 过滤有效性
2. 研究 `qa character-eval` 产物接入 ClawLens compare 视图的可行接口。
3. 研究上游发布链路中 `qa/` 目录是否应纳入安装包必带资产，并形成可回归的发布检查项。
