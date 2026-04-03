# Analysis: OpenClaw CLI `plugins list` Phantom Read

> [!IMPORTANT]
> Current Authority: This is the active master version for analyzing data inconsistency (phantom reads) in OpenClaw plugin commands.

## 1. 现象描述
用户通过 Agent 调用 `openclaw plugins list` 时，返回的插件状态或列表与实际预期不符（例如：刚安装的插件未显示，或已启用的插件显示为禁用）。

## 2. 核心原因排查

### 2.1 内存与磁盘状态脱节 (High Probability)
OpenClaw Gateway 在运行时会将配置缓存于 `runtimeConfigSnapshot`。
- **机制**：Gateway 对插件状态的某些修改可能仅停留在内存中，尚未通过 `writeConfigFile` 刷入磁盘。
- **结果**：`exec` 工具启动的 `plugins list` 是一个**独立进程**，它直接读取物理磁盘上的 `config.json`。由于读取不到 Gateway 的内存状态，导致呈现了“旧”的插件列表。

### 2.2 环境变量导致的配置路径偏移 (Medium Probability)
`loadConfig()` 的路径解析高度依赖 `process.env.HOME` 和 `OPENCLAW_STATE_DIR`。
- **机制**：`exec` 工具在构建子进程环境时，若未正确传递 Gateway 的 `STATE_DIR` 环境变量，子进程可能解析到默认路径下的空配置或旧配置。
- **验证点**：检查 `bash-tools.exec.ts` 中 `params.env` 的来源。

### 2.3 进程级缓存 (Confirmed)
代码 `src/config/io.ts` 中的 `loadConfig` 函数实现了单例模式：
```typescript
if (runtimeConfigSnapshot) return runtimeConfigSnapshot;
```
虽然子进程启动时该快照初始为空，但这意味着在**同一个进程生命周期内**，一旦读取了配置，后续修改物理文件将无法通过该函数感知（除非调用 `resetConfigRuntimeState`）。但对于外部调用的 CLI 而言，主要矛盾点在于它无法感知 **Gateway 进程** 的内存修改。

## 3. 建议修复/优化方向

1. **显式同步**：在执行任何可能影响插件状态的内部操作后，显式调用 `writeConfigFile` 以确保磁盘是真相源。
2. **环境对齐**：确保 `exec` 工具执行 `openclaw` 自家命令时，强制透传当前进程的 `OPENCLAW_STATE_DIR`。
3. **API 优先**：建议 Agent 优先调用 Gateway 暴露的 `/plugins/list` API（如果存在），而不是通过 `exec` 调用 CLI，以获取包含内存补丁的最准确状态。

## 4. 结论
`plugins list` 的“幻读”本质上是 **分布式系统状态不一致** 问题的微型体现：Gateway 进程作为“服务者”拥有最新的内存状态，而 CLI 子进程作为“观测者”只能看到磁盘上的静态投影。
