---
status: active
created: 2026-04-20
updated: 2026-05-06
---

# Claude Tmux Control Playbook

> 当前主文档，定义如何通过 `tmux` 驱动 Claude Code 会话，并对模型 / effort 切换结果做可重复监控。

## 目标

`scripts/claude-tmux-control.mjs` 是一个面向 Claude Code TUI 的本地 CLI。

它解决两类问题：

1. 通过 `tmux send-keys` 向 Claude 会话发送 `/model`、`/effort` 这类 slash command。
2. 通过 `tmux capture-pane` 轮询 pane 内容，确认切换是否真的成功，而不是只做盲打。

当前把“切模型”视为基础操作；“切 effort”和“组合切换”是同一套监控逻辑上的增量命令。

## Session Naming

本文中的 `cc1` 不是固定保留名，只是“当前 Claude CLI 所在 tmux session”的示例值。

使用规则：

- 把目标统一理解为“Claude CLI tmux session”，不要把 `cc1` 当成硬编码约定。
- 具体 session 名以操作者当前环境为准，例如 `cc1`、`claude-main`、`review-claude`。
- 所有控制命令在执行前都应先确认目标 session 名，不要默认当前机器一定存在 `cc1`。
- 文档中的 `--session cc1` 均表示示例写法，不表示仓库级固定命名要求。

## 脚本位置

- CLI: `scripts/claude-tmux-control.mjs`
- Tests: `scripts/claude-tmux-control.test.mjs`

## 命令

```bash
node scripts/claude-tmux-control.mjs status --session cc1
node scripts/claude-tmux-control.mjs set-model --session cc1 --model opus
node scripts/claude-tmux-control.mjs set-effort --session cc1 --effort medium
node scripts/claude-tmux-control.mjs set-combo --session cc1 --model sonnet --effort high
```

若需要把示例值改成当前环境中的实际 session，可直接替换为：

```bash
node scripts/claude-tmux-control.mjs status --session <claude-session>
```

通用参数：

- `--session <name>`
  目标 `tmux` session，默认 `cc1`
- `--buffer-lines <n>`
  每轮抓取的 pane 行数，默认 `120`
- `--timeout-ms <n>`
  轮询超时，默认 `15000`
- `--poll-ms <n>`
  轮询间隔，默认 `250`
- `--settle-ms <n>`
  发命令后第一次轮询前的短暂等待，默认 `400`
- `--json`
  输出机器可读 JSON

## 监控语义

脚本不是只看当前 footer，也不是只看最近一条输出，而是同时做三层判断：

1. **命令确实发出**
   通过统计新出现的 `❯ /model ...` 或 `❯ /effort ...` 行，避免把旧成功信息误当作本轮结果。
2. **成功信号**
   观察新的确认回显：
   - `Set model to ...`
   - `Set effort level to ...`
3. **footer 状态**
   若 pane footer 同步更新，则把 footer 一并纳入验证。

返回值里的 `Verification` 表示本轮用了哪些证据：

- `ack`
  命令回显确认成功
- `footer`
  footer 也已经更新到期望状态

## 当前已验证行为

在本仓库当前环境里，脚本已对 `cc1` 做过真实验证：

- `set-model --model sonnet`
  返回 `ack, footer`
- `set-effort --effort high`
  在 `Sonnet 4.6` 下返回 `ack, footer`
- `set-combo --model haiku --effort medium`
  模型切换返回 `ack, footer`，effort 切换返回 `ack`

### Haiku 特例

当前观察到：

- `Haiku 4.5` 接受 `/effort medium`
- 但 footer 不显示 `· /effort` 状态徽标

因此在 Haiku 上，脚本默认把 **命令回显 `ack`** 视为足够证据，不强求 footer 二次确认。

## 适用边界

该脚本目前面向：

- 单个 Claude Code TUI pane
- `tmux` 可读写的本地会话
- slash command 驱动的模型 / effort 切换

它不是一个通用的 TUI 自动化框架；如果后续要扩展 `/clear`、`continue`、批量组合编排，可以继续复用同一套 pane 解析和轮询骨架。

## Multi-round Review Control

当 Claude CLI tmux session 正在执行多轮评审时，操作者消息要区分“正式评审任务”与“轮中纠偏”两类动作。

推荐规则：

- 正式评审任务本体：作为正常消息发送。
- 轮中追加操作者指令：优先使用 `/btw`，用于纠偏、催收敛、补约束、要求输出最终 verdict。
- 不要把 `/btw` 类操作者插话和正式评审任务本体混写在同一条消息里。
- 如果 pane 中已经出现 queued message，要先判断是继续提交、撤回，还是先清理当前队列；不要继续叠加额外控制输入。

禁止规则：

- 不要为了“推动评审继续”而发送会终止前台 Claude CLI 的中断式控制。
- 不要把 tmux session 当成后台 subagent；它是一个有前台交互状态的真实 Claude CLI，会受到 `/clear`、queued message、busy/idle 状态和控制字符的影响。
- 不要在未确认 pane 当前状态时盲发 `submit`、额外回车或中断键。

最小安全顺序：

1. 先确认目标 session 名。
2. 检查 pane 当前是否处于可安全交互状态。
3. 正式任务用正常消息发送。
4. 多轮追问或纠偏优先用 `/btw`。
5. 若要继续 queued message，先显式确认当前 queued 内容就是要发送的那条。

## 自查方式

```bash
node --test scripts/claude-tmux-control.test.mjs
node scripts/claude-tmux-control.mjs status --session cc1
```

若要做真实链路验证，直接对目标 session 运行：

```bash
node scripts/claude-tmux-control.mjs set-model --session cc1 --model sonnet
node scripts/claude-tmux-control.mjs set-effort --session cc1 --effort high
node scripts/claude-tmux-control.mjs set-combo --session cc1 --model haiku --effort medium
```
