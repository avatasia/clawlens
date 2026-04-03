# Research: OpenClaw Tool Call Flow (v2026.4.2)

> [!IMPORTANT]
> Current Authority: This is the active master version for the research on OpenClaw's tool call handling logic.

## 1. 概述

本文分析 OpenClaw v2026.4.2 版本中，消息进入 Session 后调用 LLM 并处理 Tool Call 的具体流程。该流程是插件系统（如 ClawLens）获取审计数据的核心链路。

## 2. 核心文件位置

| 职责 | 文件路径 |
|---|---|
| **API 请求入口** | `src/gateway/server-chat.ts` |
| **Agent 运行编排** | `src/agents/pi-embedded-runner/run.ts` |
| **LLM 交互尝试** | `src/agents/pi-embedded-runner/run/attempt.ts` |
| **事件流订阅** | `src/agents/pi-embedded-subscribe.ts` |
| **事件分发枢纽** | `src/agents/pi-embedded-subscribe.handlers.ts` |
| **Tool Call 处理** | `src/agents/pi-embedded-subscribe.handlers.tools.ts` |
| **核心工具集定义** | `src/agents/pi-tools.ts` |

## 3. 流程详解

### 3.1 消息路由与 Session 启动
用户消息通过 Gateway 进入。系统识别 `sessionKey` 后，调用 `runEmbeddedPiAgent`。此阶段负责：
- 解析工作目录 (`workspaceDir`)。
- 确定使用的模型 (`provider`/`modelId`)。
- 注入初始系统提示词 (`systemPrompt`)。

### 3.2 运行环境准备
在 `runEmbeddedAttempt` 中，系统初始化 `SessionManager`。
关键动作是调用 `subscribeEmbeddedPiSession`。它建立了一个状态机，用于监听流式响应中的各种标记。

### 3.3 工具识别与插件钩子触发
OpenClaw 并不直接由插件拦截 LLM 原始文本，而是通过**事件处理器**进行解耦：
1. **识别**：底层 `AgentSession` 解析到 `tool_use`。
2. **Start 事件**：发出 `tool_execution_start`。
   - `handlers.tools.ts` 捕获该事件。
   - 触发 `before_tool_call` 全局钩子。
3. **执行**：底层执行具体工具（如 `read_file`）。
4. **End 事件**：发出 `tool_execution_end`。
   - `handlers.tools.ts` 捕获该事件。
   - 触发 `after_tool_call` 全局钩子。

### 3.4 插件感知（以 ClawLens 为例）
ClawLens 通过在 `index.ts` 中注册 `api.on("after_tool_call", ...)`，在此流程的第 4 步同步获取到工具名称、参数、耗时及执行结果，并将其写入 `tool_executions` 表。

## 4. 核心机制深度解析

OpenClaw 的插件机制遵循 **“异步流式识别、同步 Hook 分发”** 的核心哲学。

### 4.1 异步流式识别 (Asynchronous Streaming)
*   **机制**：由于 LLM 的响应是逐 Token 生成的，OpenClaw 无法预知工具调用的时机。底层 `AgentSession` 使用类似雷达的状态机，在接收文本流的同时，异步扫描 `tool_use` 标记。
*   **特性**：此过程不阻塞主线程，其节奏取决于网络包到达的速度。

### 4.2 同步 Hook 分发 (Synchronous Hook Dispatch)
*   **转折点**：一旦“雷达”识别到完整的工具指令（名称与参数），系统会立刻将“流”转为“事件”。
*   **特性**：此时系统会**按顺序、阻塞式**地调用所有已注册的 Hook（如 `before_tool_call`）。
*   **必要性**：同步分发确保了审计的原子性。如果 Hook 是异步且非阻塞的，工具可能在插件还没来得及记录其“开始”时就已经执行完毕，导致审计日志时序错乱或丢失。

### 4.3 `handlers.tools.ts` 的关键作用
该文件扮演着 **“翻译官”** 的角色。它将底层 Session 产生的原始事件数据，提取并转换为插件可理解的上下文（如 `runId`、耗时统计等）。若此处的事件转换逻辑与底层状态不同步，插件获取到的数据将出现残缺或偏移。

## 5. 结论
OpenClaw 通过“流式识别”保持了交互的灵活性，通过“同步分发”保障了插件系统的确定性。对于 ClawLens 开发者而言，理解 `pi-embedded-subscribe.handlers.tools.ts` 中的状态同步逻辑是确保审计数据高精度的前提。

