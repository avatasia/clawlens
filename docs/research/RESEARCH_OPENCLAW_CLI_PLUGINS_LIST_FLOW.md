# Research: OpenClaw CLI `plugins list` Execution Flow

> [!IMPORTANT]
> Current Authority: This is the active master version for the research on how OpenClaw executes its own CLI commands as tools.

## 1. 概述

分析当 LLM 触发 `openclaw plugins list` 工具调用（通常通过 `exec` 工具）时，系统的底层执行路径。

## 2. 核心执行链路

| 阶段 | 关键文件 | 核心逻辑 |
|---|---|---|
| **工具分发** | `pi-embedded-subscribe.handlers.tools.ts` | 识别 `exec` 调用，触发插件 Hook。 |
| **进程派生** | `bash-tools.exec.ts` | 通过 `node:child_process` 启动 `openclaw.mjs` 进程。 |
| **CLI 路由** | `cli/plugins-cli.ts` | 解析 `plugins list` 命令，调用注册表。 |
| **状态快照** | `plugins/status.ts` | 扫描配置与目录，生成已安装插件的快照。 |
| **结果返回** | `bash-tools.exec-runtime.ts` | 捕获 `stdout` 输出，通过 Hook 返回给 Agent。 |

## 3. 详细执行步骤

### 3.1 工具入口 (Agent 视角)
Agent 发出 `exec(command="openclaw plugins list")`。该请求首先被 `bash-tools.exec.ts` 拦截，并进行权限与路径校验。

### 3.2 命令解析 (CLI 视角)
系统通过 `openclaw.mjs` 进入 CLI 逻辑。`plugins list` 命令触发 `src/cli/plugins-cli.ts` 中的 action：
```typescript
plugins.command("list").action((opts) => {
  const report = buildPluginSnapshotReport();
  // ... 格式化输出 ...
});
```

### 3.3 插件状态扫描
`buildPluginSnapshotReport` 是核心。它会执行：
- **配置读取**：从 `plugins.installs` 中获取所有显式安装的插件。
- **目录扫描**：检查各插件的 `source` 路径是否存在。
- **加载测试**：对于标记为 `enabled` 的插件，检查其 `manifest` 文件的有效性，判定其最终状态（`loaded` 或 `error`）。

### 3.4 结果反馈
查询结果通过 `renderTable` 转换为 ASCII 表格并输出到 `stdout`。`exec` 工具捕获此输出，并将其作为工具执行结果返回给 LLM。

## 4. 结论
`openclaw plugins list` 在工具模式下并不是一个内置的高性能 API，而是一个**完整的子进程调用**。这意味着它的执行受限于 `exec` 工具的权限策略，且其输出会经过标准 `stdout` 捕获链路返回给审计插件。
