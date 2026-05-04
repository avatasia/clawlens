# Permission Wait Notification — Implementation

## 目标

当 Claude 因权限审批而停住时，显示一条类似现有 `Stop says` 的简洁提示，包含"首次进入等待的时间"或"已等待多久"；不破坏、污染、遮挡现有 CLI 交互显示。

## 设计概述

两阶段方案：

1. **Hook 侧 (轻量通知)** — 利用 `Notification(permission_prompt)` 事件触发一个 `systemMessage` 输出，显示首次等待时间戳。
2. **Watcher 侧 (可选附属)** — 一个独立的 Node.js 脚本读取 hook 写入的状态文件，输出已等待时长，可用于 tmux statusline 或手动检查。

## 依赖的 Hook 事件

| 事件 | Matcher | 职责 |
|---|---|---|
| `Notification` | `permission_prompt` | 记录等待开始时间，输出 `systemMessage` |
| `Stop` | (无限制) | 清理等待状态文件 |

### 为什么不用 `PermissionRequest`？

`PermissionRequest` 是 blocking hook，exit code 2 会拒绝权限。我们的目标只是提示等待时长，不是自动审批。`Notification` 是只读的、不会干扰权限流程。

## 状态文件

### 路径

```
/tmp/claude-permission-wait-<sanitized_session_id>.json
```

### 格式

```json
{
  "session_id": "abc123",
  "first_seen_at": "2026-05-02T10:30:00+00:00",
  "updated_at": "2026-05-02T10:30:00+00:00",
  "notified": true
}
```

### 生命周期

1. `Notification(permission_prompt)` 首次触发 → 创建文件，写入 `first_seen_at`，设 `notified=true`
2. 同一等待周期内再次触发 → 跳过 (`notified` 防重复)
3. `Stop` 触发 → 删除文件
4. 下一轮权限等待 → 重新从步骤 1 开始

### 残留状态

- Claude 异常退出时，状态文件残留在 `/tmp/`，不会影响后续使用
- 下次 `Stop` 不会清理（没有新 Stop 事件），但下次 `Notification` 会重新创建状态
- 手动清理：`rm -f /tmp/claude-permission-wait-*.json`

## 文件清单

### `~/.claude/hooks/permission-wait.py`

Python 脚本，处理两个事件：
- `Notification(permission_prompt)` → 输出 `{"systemMessage":"⌛ Permission wait started at HH:MM:SS"}`
- `Stop` → 清理状态文件

脚本行为由 stdin JSON 的 `hook_event_name` 区分。

### `~/.claude/settings.json`

在 `hooks` 中添加：

```json
{
  "Notification": [
    {
      "matcher": "permission_prompt",
      "hooks": [
        { "type": "command", "command": "python3 ~/.claude/hooks/permission-wait.py" }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        // ... 原 stop says 和 cache-alert 保持不动 ...
        { "type": "command", "command": "python3 ~/.claude/hooks/permission-wait.py" }
      ]
    }
  ]
}
```

### `scripts/claude-permission-wait-watcher.mjs`

可选附属脚本。读取状态文件，计算已等待时长。

```bash
node scripts/claude-permission-wait-watcher.mjs --all
# → ⏳ waiting 3m 12s (since 2026-05-02T10:30:00+00:00)

node scripts/claude-permission-wait-watcher.mjs --json
# → {"waiting":true,"sessions":[...]}
```

可集成到 tmux status-right：
```
set -g status-right "#(node $PROJECT/scripts/claude-permission-wait-watcher.mjs --all)"
```

使用 `--json` 输出可通过 `jq` 进一步处理。

## 如何启用

1. 确保 `~/.claude/hooks/permission-wait.py` 可执行：`chmod +x ~/.claude/hooks/permission-wait.py`
2. 确认 `~/.claude/settings.json` 包含 Notification 和 Stop 的事件配置
3. （可选）使用 `scripts/claude-permission-wait-watcher.mjs` 查看等待时长

## 如何验证

```bash
# 1. 验证脚本语法
python3 -m py_compile ~/.claude/hooks/permission-wait.py

# 2. 模拟 Notification(permission_prompt) 输入
echo '{"hook_event_name":"Notification","session_id":"test123","notification_type":"permission_prompt","tool_name":"Bash"}' | python3 ~/.claude/hooks/permission-wait.py
# 应输出: {"systemMessage": "⌛ Permission wait started at ..."}
# 应创建: /tmp/claude-permission-wait-test123.json

# 3. 验证二次触发不会重复输出
echo '{"hook_event_name":"Notification","session_id":"test123","notification_type":"permission_prompt"}' | python3 ~/.claude/hooks/permission-wait.py
# 应无输出 (exit 0)

# 4. 验证 Stop 清理
echo '{"hook_event_name":"Stop","session_id":"test123"}' | python3 ~/.claude/hooks/permission-wait.py
# 状态文件应被删除

# 5. 验证状态文件内容
cat /tmp/claude-permission-wait-test123.json  # 步骤 2 后应有

# 6. 验证 watcher 脚本
node scripts/claude-permission-wait-watcher.mjs --session test123  # 等待状态
node scripts/claude-permission-wait-watcher.mjs --all

# 7. 验证与现有 hooks 共存（检查 settings.json 格式）
python3 -c "import json; json.load(open('$HOME/.claude/settings.json'))"
```

## 如何回滚

1. 从 `~/.claude/settings.json` 中删除 `Notification` 和 `Stop` 中对应的 `permission-wait.py` 条目
2. 删除 `~/.claude/hooks/permission-wait.py`
3. 清理残留状态：`rm -f /tmp/claude-permission-wait-*.json`
4. 恢复启动一个新的 Claude 会话

## 已知限制

1. **`systemMessage` 渲染不确定性**: Notification hook 输出的 `systemMessage` 是否与 Stop hook 一样在 UI 中以 `ℹ` 前缀立即可见，取决于 Claude Code 的前端处理逻辑。如果渲染不可见，fallback 是 `scripts/claude-permission-wait-watcher.mjs` 的独立检查。
2. **只记录首次等待**: 同一等待周期内的多次权限弹窗不重复打点。这是有意设计，避免刷屏。
3. **不处理已等待时长更新**: 当前方案只在首次弹窗时输出一条消息，不随时间推移刷新提示（因为 hook 只在事件触发时运行）。如需实时更新，可结合 watcher 脚本 + tmux statusline。
4. **多 session 并发**: 每个 session 有独立状态文件，互不干扰。
5. **session_id 长度**: sanitize 处理确保文件名安全，但极端长的 session_id 会产生很长的文件名（实际无害）。

## 后续可选增强

- 在 `Stop` 清理时输出总等待时长（需在停止时计算 `now - first_seen_at`）
- 在 `Notification` 第二次触发时（不是第一次之后）输出间隔更新
- 集成到 tmux status bar 做自动刷新等待时长
