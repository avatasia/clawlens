---
status: active
created: 2026-05-01
updated: 2026-05-05
---

# Quota Auto-Continue — 设计方案

## 问题

Codex / Claude Code 会话在 5 小时窗口额度耗尽后停止响应，需要手动等待重置并输入 `continue`。

## 核心方案

`scripts/schedule-tmux-continue-on-reset.mjs` 统一处理两种 CLI：

```
node scripts/schedule-tmux-continue-on-reset.mjs --session <tmux-session>
```

参数：
- `--session <name>`       tmux 会话名（默认 cc1）
- `--cli-type <claude|codex>`  CLI 类型，用于决定发哪条探测命令（默认从 session 名自动推断：含 "codex" → codex，否则 → claude）
- `--offset-minutes <n>`   重置后延迟 N 分钟再发 continue（默认 1）
- `--dry-run`              只解析打印目标时间，不实际调度
- `--force`                忽略已有的 pending metadata，重新调度

## 检测与调度流程

脚本在每次 cron 触发时执行以下步骤（**只有检测到中断信号才会发探测命令**）：

```
1. 捕获当前 pane 文本
2. 如果 pane 正忙（Working / Thinking...）→ 退出
3. 如果 metadata 已存在且 targetEpoch 在未来 → 退出（已调度）
4. 扫描 pane 文本，寻找任务中断信号：
     Claude Code：limit reached / Usage ⚠ / hit your limit
     Codex：hit your usage limit
   → 无中断信号则退出（不发探测命令）
5. 向 pane 发探测命令获取权威重置时间：
     Claude Code：/usage（两次独立 send-keys，先发命令再发 Enter）
     Codex：      /status（同上）
6. 解析探测输出：
     Claude /usage → "X% used" + "Resets H:MMam (TZ)"
     Codex /status → "5h limit: ... X% left (resets HH:MM)"
7. 如果探测到额度 > 0% → 退出（额度已恢复，无需调度）
8. 额度 = 0% + 中断信号 → 计算目标时间（reset_time + offset_minutes）
9. 生成 runner bash 脚本，通过 tmux run-shell -b 在后台 sleep-then-send
10. 写入 metadata 文件
```

> **关键设计**：探测命令（`/usage` / `/status`）只在确认有任务中断信号后才发送，避免对正常空闲 panel 产生干扰。`5h 0%` 状态栏但无中断信号（任务已正常完成）的情况在第 4 步就会退出。

## 额度耗尽检测

### Claude Code（cc1）

**pane 中断信号**（步骤 4）：
```
Usage ⚠ Limit reached (resets 12pm (Asia/Shanghai))
Usage ⚠ Limit reached (resets 2h 29m)
❯
```
触发词：`limit reached` / `hit your limit` / `Usage ⚠`

**探测命令**（步骤 5–6）：`/usage`
```
  Current session
  █████████████████████████████████████              74% used
  Resets 1:20am (Asia/Shanghai)
```
解析：`(\d+)% used` → percentLeft = 100 - X；`Resets (.+)` → 重置时间
额度耗尽时可能显示 `Limit reached` 而非百分比，同样识别为 percentLeft = 0。
发完命令后脚本自动发送 `Escape` 关闭 TUI overlay。

**提示符**：`❯` 或 `Type your message or @path/to/file`

### Codex

**pane 中断信号**（步骤 4）：
```
■ You've hit your usage limit. Upgrade to Pro (...), v
isit .../usage to purchase more credits or try again
at 5:20 PM.
```
触发词：`hit your usage limit`（跨行 join 后提取 `try again at H:MM AM/PM`）

**探测命令**（步骤 5–6）：`/status`
```
  5h limit:             [░░░░░░░░░░░░░░░░░░░░] 0% left (resets 22:28)
  Weekly limit:         [██████░░░░░░░░░░░░░░] 31% left (resets 13:40 on 5 May)
```
解析：`5h limit:.*?(\d+)% left \(resets ([^)]+)\)` → percentLeft, 重置时间（本地时区，24h）

**提示符**：`›`（U+203A）

## continue 发送方式

runner 触发时，发送方式为**三条独立 send-keys**，不合并：

```
tmux send-keys -t pane "continue"  → 输入文字
sleep 0.1
tmux send-keys -t pane "Enter"     → 第一次回车（提交）
sleep 0.3
tmux send-keys -t pane "Enter"     → 第二次回车（触发任务恢复）
```

runner 触发前还会检查：会话是否存在？pane 是否仍在 busy？提示符是否就绪？

## 调度机制

1. 脚本生成 runner bash 脚本（`/tmp/clawlens-auto-continue/<session>-<epoch>.sh`）
2. 通过 `tmux run-shell -b bash <runner>` 在 tmux 后台启动 sleep-then-send
3. runner sleep 到目标时间后发送 continue（含 2x Enter）
4. runner 清理 metadata 文件

metadata 文件路径：`/tmp/clawlens-auto-continue/<session>.json`

重置时间来源优先级：
1. **探测命令输出**（`/status` / `/usage`）— 首选，权威
2. **pane 文本中的 resets 信息**（中断信号行内）— 探测失败时回退

## 系统级 Cron 监听器

### codex 会话
```
*/3 * * * * PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/node \
  ./scripts/schedule-tmux-continue-on-reset.mjs \
  --session codex >> /tmp/clawlens-auto-continue/codex-watcher.log 2>&1
```
（自动推断 `--cli-type codex`）

### cc1 会话
```bash
(crontab -l; echo "*/3 * * * * PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/node \
  ./scripts/schedule-tmux-continue-on-reset.mjs \
  --session cc1 >> /tmp/clawlens-auto-continue/cc1-watcher.log 2>&1 # cc1-quota-watcher") | crontab -
```
（自动推断 `--cli-type claude`）

### gemini1 会话
```bash
(crontab -l; echo "*/3 * * * * PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/node \
  ./scripts/schedule-tmux-continue-on-reset.mjs \
  --session gemini1 >> /tmp/clawlens-auto-continue/gemini1-watcher.log 2>&1 # gemini1-quota-watcher") | crontab -
```
（自动推断 `--cli-type gemini`，探测命令 `/stats`，Escape 关闭 TUI overlay）

**注意**：Gemini `/stats` 不含重置时间，probe 仅用于检测 `percentLeft`。重置时间依赖 pane 文本中的中断消息（格式待补充——触发后记录实际错误文本）。

注意：tmux 在 `/usr/local/bin`，cron 环境 PATH 必须包含此路径。

## 关键文件

| 文件 | 用途 |
|------|------|
| `scripts/schedule-tmux-continue-on-reset.mjs` | 主脚本（检测+探测+调度） |
| `scripts/schedule-tmux-continue-on-reset.test.mjs` | 单元测试（22 个用例） |
| `scripts/tmux-session-lock.mjs` | 并发锁，防止多个 runner 同时发送 |
| `/tmp/clawlens-auto-continue/<session>.json` | 调度 metadata（运行时） |
| `/tmp/clawlens-auto-continue/<session>-watcher.log` | watcher 日志 |
| `/tmp/clawlens-auto-continue/<session>-<epoch>.log` | runner 执行日志 |

## 手动操作

```bash
# 查看当前调度状态
cat /tmp/clawlens-auto-continue/codex.json

# 手动触发检测（dry-run）
node scripts/schedule-tmux-continue-on-reset.mjs --session codex --dry-run

# 强制重新调度
node scripts/schedule-tmux-continue-on-reset.mjs --session codex --force

# 取消（删除 metadata，下次 watcher 跳过调度）
rm /tmp/clawlens-auto-continue/codex.json

# 查看 watcher 日志
tail -f /tmp/clawlens-auto-continue/codex-watcher.log

# 查看 runner 执行日志
tail -f /tmp/clawlens-auto-continue/codex-*.log
```
