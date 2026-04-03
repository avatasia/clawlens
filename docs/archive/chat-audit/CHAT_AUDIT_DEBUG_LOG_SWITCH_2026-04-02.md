# Chat Audit Debug Log Switch

## 目的

记录本轮排障中使用的临时日志，并将其收敛为可控开关，避免长期污染 `openclaw-gateway` 日志。

## 开关设计

ClawLens 调试日志支持两种开启方式，优先级如下：

1. 插件配置：`collector.debugLogs`
2. 环境变量：`CLAWLENS_DEBUG=1`

默认关闭。

## 当前覆盖的日志前缀

- `clawlens-debug`
  适用于 Collector 事件链路排查：
  - `lifecycle:start/end/error`
  - `llm_input`
  - `llm_output`
  - `after_tool_call`
  - `transcript_update`
  - `agent_end`

- `clawlens-store`
  适用于 Store 写库/聚合排查：
  - `insertLlmCall`
  - `insertToolExecution`
  - `completeRun:aggregate`

## 推荐开启方式

### 方式 A：插件配置

在 ClawLens 插件配置中临时加入：

```json
{
  "collector": {
    "debugLogs": true
  }
}
```

适合短期排障，且配置可被版本化管理。

### 方式 B：环境变量

在启动 `openclaw-gateway` 的进程环境中临时加入：

```bash
CLAWLENS_DEBUG=1
```

适合远端临时排障，且无需改插件配置文件。

## 远端 systemd 使用建议

若通过 `systemd --user` 启动，可使用临时 override：

```ini
[Service]
Environment=CLAWLENS_DEBUG=1
```

排障结束后应移除该 override，并重启网关。

## 使用原则

- 默认关闭
- 只在 run 绑定、hook 时序、写库丢失这类问题复现时开启
- 排障完成后立即关闭

## 本轮经验

本轮正是依靠这组日志确认了：

- `llm_output` / `after_tool_call` 事件本身由 OpenClaw 正常发出
- 问题不在 hook 缺失，而在 ClawLens 后置写库路径
- 将 `recordLlmOutput()` / `recordToolCall()` 改为同步写库后，`llm_calls` 与 `tool_executions` 恢复正常
