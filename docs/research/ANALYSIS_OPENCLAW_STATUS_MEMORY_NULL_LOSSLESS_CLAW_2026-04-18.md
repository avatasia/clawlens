# ANALYSIS — openclaw status `"memory": null` & `lossless-claw` plugin interaction (2026-04-18)

## 0. 背景与目标

用户反馈在启用 `lossless-claw` 插件后，运行 `openclaw doctor` 出现异常提示：

```
Memory artifact repair could not be completed: Cannot read properties of undefined (reading 'clear')
TypeError: Cannot read properties of undefined (reading 'clear')
```

同时，`openclaw status --json` 输出中出现：

```json
"memory": null,
"memoryPlugin": {
  "enabled": true,
  "slot": "memory-core"
}
```

目标：

1. 不修改 OpenClaw（上游 `openclaw`）代码，只研究并修复 `lossless-claw` 插件侧问题。
2. 解释 `openclaw status --json` 里 `"memory": null` 的真实含义与触发条件。
3. 结合文档中“远程连接/远程访问”的部分，给出在远程部署/联调场景下稳定复现与验证的路径。

## 1. 文档要点（远程连接/访问）

本仓库 docs 中与远程访问相关的要点（用于解释为何 status/doctor 会出现 `gateway unreachable` 从而影响 status 字段）：

- 远程 Gateway 默认绑定 `127.0.0.1:<port>` 时，外部机器无法直连，需要通过 SSH 端口转发把远端的 loopback 端口映射到本地。
- 典型用法（示例端口 18789）：
  - `ssh -N -L 18789:127.0.0.1:18789 user@remote-host`
- 若未建立 tunnel（或远端 gateway 未运行），本地执行 `openclaw status/doctor` 会显示 `gateway.reachable=false`，并导致依赖网关 RPC 的 status 字段无法填充，出现 `null`。

参考文档：

- `docs/CLAWLENS_REMOTE_DEPLOYMENT.md`
- `docs/clawlens-usage.md`（远程访问问题章节）

## 2. 关键结论（先给答案）

### 2.1 `"memory": null` 不是“memory 坏了”

在本次本机隔离环境复现中，`openclaw status --json` 里的：

- `"memoryPlugin": { "enabled": true, "slot": "memory-core" }`

表示配置与插件槽位选择是生效的（control-plane 视角）。

但同时：

- `"memory": null`

通常表示 **当前 CLI 没有从正在运行的 Gateway 获取到 memory 子系统的运行时快照**（runtime-plane 视角）。

最常见触发条件：Gateway 未运行或不可达（同一次 status 输出里会伴随 `gateway.reachable: false` / `gateway.error`）。

因此，`memory: null` 与 `lossless-claw` 本身不是一一对应关系；它更多受 Gateway 连接状态影响。

### 2.2 `lossless-claw` 的“默认 context engine 劫持”风险

`lossless-claw` 之前的实现同时注册了两个 context engine id：

- `"lossless-claw"`
- `"default"`

这会覆盖 OpenClaw 内建的 `"default"` context engine，从而改变**全局**行为：即使某些流程（例如 doctor / memory 相关流程）并没有显式选择 `lossless-claw`，也可能走到被插件覆盖后的链路。

这类“覆盖 default”在上游生态中属于高风险行为：会让非 LCM 目标路径进入不兼容状态，出现类似 `Cannot read properties of undefined (reading 'clear')` 的异常（下游拿到未初始化/未符合预期形状的对象后调用 `.clear()`）。

本次修复策略：**插件只注册 `"lossless-claw"`，不注册/不覆盖 `"default"`**。

## 3. 复现与观测过程（本机隔离环境）

说明：为了不依赖系统全局安装，本次使用 `projects-ref/openclaw/openclaw.mjs` 直接运行 CLI。

### 3.1 构造隔离 state/config

建立隔离目录（示例）：

- state：`/tmp/openclaw-lossless-test/state`
- config：`/tmp/openclaw-lossless-test/openclaw.json`

配置要点：

- `plugins.load.paths` 指向本地 `lossless-claw` 工作区（例如 `projects-ref/lossless-claw`）。
- `plugins.slots.contextEngine = "lossless-claw"`
- `plugins.slots.memory = "memory-core"`

### 3.2 运行 status，确认 `"memory": null` 的同时出现 gateway 不可达

运行：

- `OPENCLAW_STATE_DIR=/tmp/openclaw-lossless-test/state OPENCLAW_CONFIG_PATH=/tmp/openclaw-lossless-test/openclaw.json node projects-ref/openclaw/openclaw.mjs status --json`

观测到：

- `"memory": null`
- `memoryPlugin.slot` 仍然为 `memory-core`
- `gateway.reachable=false`（或 `gateway.error` 显示 closed/unreachable）

结论：`memory: null` 与 gateway 不可达强相关；并不等价于“memory 插件没加载/没启用”。

### 3.3 运行 doctor（非交互修复模式），确认 Memory search 的输出与 provider 状态

运行：

- `... node projects-ref/openclaw/openclaw.mjs doctor --fix --yes --non-interactive`

观测到 `Memory search` 的提示主要围绕 “embedding provider 不可用/缺少 API key”，与 `lossless-claw` 无直接耦合。

另外用：

- `... node projects-ref/openclaw/openclaw.mjs memory status --json --deep`

可得到 memory 子系统的详细状态（包括 workspaceDir、dbPath、fts/vector 使能等），这条命令不依赖 gateway running 的同一方式填充 status 字段。

## 4. 插件侧代码审查要点

### 4.1 `.clear()` 相关调用点

在 `lossless-claw` 内检索 `.clear(`，主要落在内部 Map/Set 的清理与测试辅助路径中，例如：

- `projects-ref/lossless-claw/src/plugin/shared-init.ts`（`getStore().clear()`）
- `projects-ref/lossless-claw/src/startup-banner-log.ts`（`emitted.clear()`）

这些位置本身是正常的（Map/Set always have clear），更可疑的是**被覆盖的 default engine**导致上游期望的对象形状变化，进而在上游或其他 runtime 内部触发 `.clear` on undefined。

### 4.2 高风险行为：注册 `"default"` context engine

在插件 wiring 阶段（`wirePluginHandlers(...)`）：

- 之前实现：同时 `api.registerContextEngine("lossless-claw", ...)` 与 `api.registerContextEngine("default", ...)`
- 风险：覆盖 OpenClaw 内建 `"default"` engine，改变 doctor/memory 等非 LCM 路径行为。

## 5. 修复方案（只改 lossless-claw，不改 openclaw）

### 5.1 代码修改

1. 不再注册/覆盖 `"default"` context engine：
   - `projects-ref/lossless-claw/src/plugin/index.ts`
2. `lcm` 命令的“selected”判定只在显式 slot 选择时为 true：
   - `projects-ref/lossless-claw/src/plugin/lcm-command.ts`
3. 同步更新对应单测：
   - `projects-ref/lossless-claw/test/lcm-command.test.ts`

### 5.2 构建与测试

在 `projects-ref/lossless-claw` 下：

- `npm run build`（生成 `dist/index.js`）
- `npm test`（vitest 全量通过）

## 6. 对用户问题的直接回答

### 6.1 为什么 `openclaw status --json` 里 `"memory": null`？

因为 status 输出中的 `memory` 字段是 runtime-plane 信息，通常需要从**运行中的 Gateway**获得状态快照；当 gateway 未运行/不可达时，该字段会是 `null`。

这与：

```json
"memoryPlugin": { "enabled": true, "slot": "memory-core" }
```

并不矛盾：后者是 control-plane（配置/槽位选择）信息，仍然可以显示。

### 6.2 为什么“装了 lossless-claw 之后 doctor 报 clear undefined”？

插件此前覆盖了 `"default"` context engine，属于全局行为变更点，会把非 LCM 路径带入不兼容链路，最终表现为某处拿到 `undefined` 后调用 `.clear()`。

修复是移除该覆盖：仅注册 `"lossless-claw"`，通过 `plugins.slots.contextEngine` 显式选择启用，不影响 default 行为。

## 7. 后续建议（远程联调）

若问题发生在远程机：

1. 先确认远端 gateway 运行且绑定位置（通常 loopback）。
2. 用 SSH tunnel 将远端 `127.0.0.1:18789` 转发到本地同端口，再在本地跑 `openclaw status/doctor`。
3. 若本地不需要 gateway 连接，仅看 memory 子系统状态，优先使用 `openclaw memory status --json --deep` 进行诊断。

