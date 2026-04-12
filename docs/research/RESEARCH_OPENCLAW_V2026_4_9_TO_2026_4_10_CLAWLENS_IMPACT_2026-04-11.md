# OpenClaw v2026.4.9 -> v2026.4.10 对 ClawLens 影响分析

日期：2026-04-11  
范围：`openclaw` tag `v2026.4.9 (60db001)` 到 `v2026.4.10 (34a56d9)`

## 结论摘要

1. 对 ClawLens 当前使用的 hook/runtime 接口，未发现破坏性变更。
2. `unknown session` 现象在 v2026.4.10 仍可能出现，但 Discord 重绑能力有增强，整体会话连续性变好。
3. QA 报错 `qa scenario pack not found` 属于 QA 场景包打包/部署完整性问题，不是 ClawLens hook 兼容问题。

## ClawLens 直接依赖接口核对

ClawLens 当前依赖：

- `api.runtime.events.onAgentEvent`
- `api.runtime.events.onSessionTranscriptUpdate`
- `api.on("llm_input" | "llm_output" | "after_tool_call" | "agent_end")`

在本次 tag 对比中，以上接口未观察到签名级破坏。

## 高相关上游变更与影响

### 1) Discord 重绑增强（正向）

代表提交：

- `a3b047b5fc` Preserve Discord lifecycle windows on rebind
- `b2475884fd` Preserve Discord binding metadata on rebind

关键文件：

- `extensions/discord/src/monitor/thread-bindings.manager.ts`

影响：

- 重绑后保留更多 lifecycle window / metadata（如 timeout、metadata、webhook/agent 信息继承）。
- 对 ClawLens 来说，run 与会话键的关联稳定性提升，但不能保证完全无 `unknown`。

### 2) 网关 run context TTL 清理（稳定性）

代表提交：

- `820dc38525` fix(gateway): add TTL cleanup for 3 Maps that grow unbounded causing OOM

关键文件：

- `src/infra/agent-events.ts`
- `src/gateway/server-maintenance.ts`

影响：

- 长运行稳定性更好，避免 run context map 无界增长。
- 若存在生命周期尾事件缺失，旧 run context 会被扫掉；ClawLens 需保持 transcript 侧补绑能力（当前已具备兜底）。

### 3) Hook system event trust 归一化（安全向）

代表提交：

- `e3a845bde5` Normalize agent hook system event trust handling

关键文件：

- `src/gateway/server/hooks.ts`

影响：

- hook 名称做 sanitize，system event 以 `trusted:false` 入队，属于安全语义增强。
- 对 ClawLens 的采集主链路无明显负面影响。

### 4) 插件日志路由调整（可观测性）

代表提交：

- `569751898f` fix: route gateway plugin logs through plugins

关键文件：

- `src/gateway/server-plugins.ts`
- `src/gateway/server-plugin-bootstrap.ts`

影响：

- 插件日志注册路径调整，可改善排查体验。
- 不改变 ClawLens 核心数据采集契约。

## QA-Lab 相关说明（与本次故障直接相关）

在 `v2026.4.10` 中，`qa/scenarios/*` 明显扩展；若安装工件缺少 `qa/` 目录，会触发：

- `qa scenario pack not found: qa/scenarios/index.md`

该问题与 ClawLens hook 接口无关，属于发布包内容完整性问题。

## 兼容性判定

- 结论：`v2026.4.10` 对 ClawLens **兼容**，并含若干有利于会话连续性的改进。
- 建议：
  - 保留 ClawLens 当前 transcript/run 绑定兜底逻辑。
  - 上游继续推进 source 侧尽早绑定准确 sessionKey，以进一步减少 `unknown`。

