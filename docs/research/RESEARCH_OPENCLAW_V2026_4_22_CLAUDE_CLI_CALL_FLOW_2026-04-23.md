# OpenClaw v2026.4.22 Claude CLI 调用链研究

日期：2026-04-23

目标版本：

- `projects-ref/openclaw`
- tag: `v2026.4.22`
- commit: `00bd2cf7a376f1fba26291c6c4766f1f15cbdfa5`

## 结论摘要

OpenClaw 在 `v2026.4.22` 中不是简单地一次性执行 `claude` 命令，而是把 Claude Code 当作一个标准化的 `cli-backend` 来管理。

完整路径包括：

1. Anthropic 扩展注册 `claude-cli` backend。
2. 运行期解析 backend 配置与 override。
3. 构建工作目录、认证态、system prompt、MCP 配置和 session 复用条件。
4. 组装 Claude CLI 参数并清洗宿主环境变量。
5. 通过 supervisor 启动外部 `claude` 进程，优先走 Claude 专用 live session。
6. 解析 `stream-json/jsonl` 输出，提取文本、usage、session id。
7. 把 CLI session binding 写回 OpenClaw session；历史回填时再读取 `~/.claude/projects/.../<sessionId>.jsonl`。

## 1. Backend 注册

Anthropic 扩展在 setup/runtime 中注册 `claude-cli` backend，默认二进制就是 `claude`：

- `extensions/anthropic/setup-api.ts`
- `extensions/anthropic/register.runtime.ts`
- `extensions/anthropic/cli-backend.ts`

关键配置在 `extensions/anthropic/cli-backend.ts`：

- `command: "claude"`
- fresh args:
  - `-p`
  - `--output-format stream-json`
  - `--include-partial-messages`
  - `--verbose`
  - `--setting-sources user`
  - `--permission-mode bypassPermissions`
- resume args:
  - 上述参数
  - `--resume {sessionId}`
- `output: "jsonl"`
- `input: "stdin"`
- `liveSession: "claude-stdio"`
- `modelArg: "--model"`
- `sessionArg: "--session-id"`
- `systemPromptArg: "--append-system-prompt"`
- `bundleMcp: true`
- `bundleMcpMode: "claude-config-file"`

这说明 OpenClaw 明确按 Claude Code 的流式 JSON 输出模式来接管调用。

## 2. Anthropic CLI 认证如何接入

Claude CLI 的认证接入主要在：

- `extensions/anthropic/register.runtime.ts`
- `extensions/anthropic/cli-migration.ts`
- `extensions/anthropic/cli-auth-seam.ts`

行为分两层：

1. 配置/登录阶段

用户选择 Anthropic 的 `cli` 认证方式后，OpenClaw 读取本机 Claude CLI 已登录凭据，并生成 `anthropic:claude-cli` profile。

同时它会把默认模型选择从 `anthropic/claude-*` 重写为 `claude-cli/claude-*`，并补齐 Claude CLI allowlist。

2. 运行阶段

Provider 侧还实现了 `resolveSyntheticAuth()`。

当 provider 是 `claude-cli` 时，OpenClaw 会直接把本机 Claude CLI 的 oauth/token 读取出来，转成运行期可消费的 synthetic auth。

这意味着 OpenClaw 运行 Claude CLI 时，核心前提不是单独再让用户输入 API key，而是复用本机现成的 Claude CLI 登录态。

## 3. 运行期入口

实际运行入口在：

- `src/agents/cli-runner.ts`

核心路径：

- `runCliAgent()`
- `prepareCliRunContext()`
- `executePreparedCliRun()`

其中：

- `runCliAgent()` 只负责调度 prepare + execute。
- `runPreparedCliAgent()` 负责把 CLI 输出包装成 OpenClaw 的 `EmbeddedPiRunResult`。
- 成功执行后会把 `cliSessionBinding`、usage、最终文本等信息放进返回 meta。

## 4. prepare 阶段做了什么

`src/agents/cli-runner/prepare.ts` 是 Claude CLI 调用前最关键的上下文准备逻辑。

它会做这些事：

1. 解析实际 workspace

- 根据 `sessionKey` / `agentId` / config 解析真正执行目录。
- 如果调用方显式传了 `workspaceDir`，就直接使用。
- 如果没传，会回退到对应 agent 的 workspace：优先 `agent.workspace`，其次 `agents.defaults.workspace`；若都没配，非默认 agent 会落到 `stateDir/workspace-<agentId>`。
- 从 `sessions-spawn-tool` 相关测试也能看到，sub-agent 默认继承父 workspace，而不是在工具参数里随意覆盖一个新的 workspaceDir。
- 这里做的是“解析和回退”，不是“每轮自动创建一个全新的临时 workspace”。

2. 解析 backend

- 通过 `src/agents/cli-backends.ts` 调 `resolveCliBackendConfig()` 拿到 `claude-cli` 的最终配置。

3. 载入 auth profile

- 如果传入或默认存在 auth profile，会读取 auth store。

4. 生成 system prompt

- 拼 bootstrap files、skills prompt、heartbeat prompt、docs path、extra system prompt 等。

5. 准备 MCP 配置

- 因为 Claude backend 开启了 `bundleMcp`，prepare 阶段会准备 loopback MCP server config，并把 token、agent id、session key 等环境变量注入子进程。

6. 计算 auth epoch

- 用于判断旧 session 是否还能安全复用。

7. 判断 session 是否复用

- 使用 `src/agents/cli-session.ts` 的 `resolveCliSessionReuse()`。
- 不仅比较 `sessionId`，还比较：
  - `authProfileId`
  - `authEpoch`
  - `extraSystemPromptHash`
  - `mcpConfigHash`
  - `mcpResumeHash`

这些任何一个变化，都可能导致旧 Claude session 被判定失效。

## 5. 参数是怎么组装的

参数拼装在：

- `src/agents/cli-runner/helpers.ts`

关键函数：

- `resolveSessionIdToSend()`
- `resolvePromptInput()`
- `prepareCliPromptImagePayload()`
- `writeCliSystemPromptFile()`
- `buildCliArgs()`

行为要点：

1. session id

- `sessionMode` 默认是 `always`
- 有旧 session 就复用
- 没有就生成新的 UUID

2. prompt 输入

- Claude backend 配置的是 `input: "stdin"`
- 所以 prompt 主要通过 stdin 发送，而不是命令行参数

3. system prompt

- 新 session 时才附加 system prompt
- Claude backend 使用 `--append-system-prompt`
- resume 时默认不重复发送 system prompt

4. 图片

- 图片会先写到临时目录或 workspace 目录
- 再根据 backend 的 image 规则决定是命令行传参还是拼进 prompt

5. 启动形态示意

- fresh run 的默认形态就是 `claude -p --output-format stream-json ...`
- OpenClaw 会继续追加 `--model`、新 session 的 `--session-id`、首次会话的 `--append-system-prompt`
- 但 prompt 正文默认不走命令行参数，而是通过 stdin 发送

## 6. 真正执行 `claude` 之前做了哪些保护

执行逻辑在：

- `src/agents/cli-runner/execute.ts`
- `extensions/anthropic/cli-shared.ts`

最重要的一层是环境变量清洗。

Claude backend 明确声明要清掉一批宿主环境变量，例如：

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_OAUTH_TOKEN`
- `ANTHROPIC_BASE_URL`
- `CLAUDE_CONFIG_DIR`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `CLAUDE_CODE_REMOTE`
- 多个明确列出的 `OTEL_*` 相关变量

从 `extensions/anthropic/cli-shared.ts` 对这批变量的注释和清理名单来看，可以推断 Claude Code 在读取本地登录态前，会先看 provider-routing、auth、config-root、telemetry 相关 env。

如果不清理，OpenClaw 的 Claude 进程可能被宿主 shell 的环境“带偏”，跑到错误的 endpoint、错误的 token source、错误的插件目录或错误的遥测模式。

另外，执行阶段还会显式删除：

- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`

这里不是我的推测，`src/agents/cli-runner/execute.ts` 里有直接注释：保留它会把 Claude CLI 请求路由到 Anthropic 的另一套 host-managed usage tier，而不是普通 CLI subscription 行为。

## 7. 真正的进程是怎么起的

常规路径下，`executePreparedCliRun()` 会：

1. 构造最终 argv。
2. 构造清洗后的 env。
3. 通过 process supervisor 启动子进程。
4. 把 stdout 交给 streaming parser。
5. 等待进程退出并解析结果。

这不是直接 `child_process.spawn()` 裸调，而是挂在 OpenClaw 自己的 supervisor 体系上，带：

- `timeoutMs`
- `noOutputTimeoutMs`
- scopeKey
- session 级别替换
- 手动 cancel

同一个函数里还存在一个显式分流：

- 如果 `shouldUseClaudeLiveSession(context)` 为真，就走 `runClaudeLiveSessionTurn()`
- 否则走普通 supervisor child-process 路径

所以 live session 不是旁路机制，而是 `executePreparedCliRun()` 内部的正式执行分支。

在进程通讯层，OpenClaw 这里走的不是 HTTP、socket 或全局共享 daemon，而是子进程级别的 `stdio pipe`。普通 child 模式下，Claude 进程以 `stdin/stdout/stderr` pipe 启动，父进程把 prompt 写入 stdin，再读取 stdout/stderr；这些流都和当前子进程绑定，不是全局共享的公共流。

## 8. 为什么 Claude 还会走 live session

Claude 特有逻辑在：

- `src/agents/cli-runner/claude-live-session.ts`

当满足以下条件时：

- backend id 是 `claude-cli`
- `liveSession === "claude-stdio"`
- `output === "jsonl"`
- `input === "stdin"`

OpenClaw 不会每轮都起一个新的 `claude` 进程，而是尝试复用一个 Claude live process。

live session 模式会把参数改造成更适合持续对话的形式，例如：

- `--input-format stream-json`
- `--permission-prompt-tool stdio`
- `--replay-user-messages`

同时会去掉不应该在长期存活进程里反复变化的参数，比如：

- `--session-id`
- system prompt 相关参数
- 某些不稳定路径参数

它还会计算一个 fingerprint。

只有当 workspace、provider、model、system prompt、auth、MCP、skills 等关键上下文都匹配时，才允许复用旧 live process。

如果已有 live session 但 fingerprint 不匹配，源码做法不是继续复用旧进程，也不是退回“一次性普通 CLI 调用”，而是先 `closeLiveSession(..., "restart")` 关闭旧 session，再按同一条 live-session 路径重新创建一个新的 Claude live process。

这里还要区分两层并发控制：

1. 高层调度层

- Claude backend 默认 `serialize: true`
- 有 `cliSessionId` 时，队列键按 `claude-cli:session:<sessionId>` 串行
- 没有 `cliSessionId` 时，队列键按 `claude-cli:workspace:<workspaceDir>` 串行

2. live session 内部防护层

- live session 上限是 `16`，对应 `claude-live-session.ts` 里的 `CLAUDE_LIVE_MAX_SESSIONS`
- 单个 live session 一次只允许一个 turn
- 如果异常情况下两个 turn 仍然试图同时复用同一个 live session，`currentTurn` 检查会直接报错兜底

因此不能把它理解成“只靠一个 `currentTurn` 报错来处理并发”；更准确的说法是“高层默认串行，低层仍有 runtime guard”。

### 8.1 live session 中 stdin / stdout 跑的是什么

live session 模式下，OpenClaw 每轮都会向 Claude CLI 的 stdin 写入一行 JSON user message，大致形状是：

```json
{"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":"...prompt..."}}
```

Claude CLI 再从 stdout 回送结构化 JSON 行。OpenClaw 会缓冲 stdout chunk、按换行切分，再对每一整行做 `JSON.parse`。所以这里不是“一个大 JSON 文档在中途被打断”，而是 JSONL / NDJSON 形式：底层 chunk 可能切在半行中间，但逻辑上仍然是一行一个完整 JSON 对象。

## 9. Claude 输出是怎么解析的

解析逻辑在：

- `src/agents/cli-output.ts`

因为 provider 是 `claude-cli`，解析器默认按 Claude 的 `stream-json/jsonl` 方言处理。

它会：

- 扫描 JSON object 片段
- 提取 assistant 文本
- 提取 `session_id` / `conversation_id`
- 提取 usage
- 提取结构化错误

对 Claude live stdout，当前解析器至少明确消费两类关键记录：

1. 增量事件

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "delta": {
      "type": "text_delta",
      "text": "..."
    }
  }
}
```

2. 本轮结束结果

```json
{
  "type": "result",
  "result": "..."
}
```

所以 OpenClaw 并不是只盯着 stdout 最后一行文本，而是专门理解 Claude CLI 的流式结构化输出。

另外，前端不是“看不到 Claude 输出”，而是看不到 Claude CLI 自带的终端 UI。真实链路是：Claude CLI 在后台通过 stdout 返回 JSONL 事件，OpenClaw 解析增量文本，再把 assistant delta 重新发成自己的前端事件。因此 Claude CLI 在 OpenClaw 里更像一个 headless backend process，而不是直接面向用户的终端界面。

## 10. session 绑定如何回写

session 绑定逻辑在：

- `src/agents/cli-runner.ts`
- `src/agents/cli-session.ts`

执行成功后，返回结果 meta 里会包含：

- `cliSessionBinding.sessionId`
- `authProfileId`
- `authEpoch`
- `authEpochVersion`
- `extraSystemPromptHash`
- `mcpConfigHash`
- `mcpResumeHash`

这些字段用于下一轮判断 Claude session 能否继续复用，而不是只靠一个裸 `sessionId`。

其中 `authEpochVersion` 不是 Claude CLI 透传字段，而是 OpenClaw 自己维护的版本号；`prepare.ts` 会把 `CLI_AUTH_EPOCH_VERSION` 写入 binding，在这个 tag 上该常量值是 `3`。

## 11. 历史消息如何回填

Claude 历史回填逻辑在：

- `src/gateway/cli-session-history.claude.ts`

OpenClaw 会直接读取：

- `~/.claude/projects/<project-dir>/<cliSessionId>.jsonl`

然后把里面的 Claude message 记录转成 OpenClaw transcript。

这里要和上面的 stdout 流式解析区分开：OpenClaw 实时消费的是父进程与 Claude 子进程之间的 stdout JSONL 事件流；历史回填读的是 Claude CLI 自己落盘在 `~/.claude/projects/...` 下的本地会话 jsonl。两者都可能是 JSONL，但不要求行结构相同。

这里的 `<project-dir>` 需要再拆开看：

1. 预测 Claude project 目录时，`src/commands/doctor-claude-cli.ts` 里的 `resolveClaudeCliProjectDirForWorkspace()` 会先对 workspace 做 canonicalize，再把非字母数字字符替换为 `-`；如果结果过长，再追加一个 `simpleHash36(workspaceDir)` 后缀。
2. 真正做历史回填时，`src/gateway/cli-session-history.claude.ts` 并不会先重建这个 key；它是遍历 `~/.claude/projects/` 下的所有子目录，查找哪个目录里存在 `<cliSessionId>.jsonl`。

所以这里更准确的表述是：“Claude projects 目录下由 canonical workspace path 派生出的目录名”，而不是一个必须由 OpenClaw 在回填路径里先精确反推出来的固定 key。

其中还专门处理了：

- `tool_use`
- `tool_result`
- usage
- assistant stop reason
- timestamps

这说明 OpenClaw 在 Claude backend 上不仅接管“调用”，还接管“后续历史恢复”。

## 12. doctor 命令怎么检查 Claude CLI

健康检查逻辑在：

- `src/commands/doctor-claude-cli.ts`

它会检查：

- `claude` 二进制是否在 PATH 上
- 本机 Claude CLI 凭据是否存在
- OpenClaw auth store 中是否存在 `anthropic:claude-cli`
- workspace 是否可读写
- 对应 `~/.claude/projects/...` 目录是否存在、可读写

这套 doctor 逻辑和上面的运行链是对齐的，不只是简单检查“命令是否存在”。

## 13. 一句话总结

在 `v2026.4.22` 中，OpenClaw 对 Claude CLI 的使用方式是：

“把 Claude Code 当作一个可复用、带认证迁移、带环境隔离、带 MCP 注入、带 session 生命周期管理、带历史回填能力的专用 CLI backend 来运行。”

它不是裸调用，而是一整套 adapter。更具体地说，这是一个通过 `stdio/jsonl` 驱动的 headless backend；它负责会话复用和输出转发，但并不等于“自动为每个 Claude 任务提供独立 workspace 隔离器”。

## 关键源码入口

- `extensions/anthropic/cli-backend.ts`
- `extensions/anthropic/cli-migration.ts`
- `extensions/anthropic/register.runtime.ts`
- `extensions/anthropic/cli-shared.ts`
- `src/agents/cli-backends.ts`
- `src/agents/cli-runner.ts`
- `src/agents/cli-runner/prepare.ts`
- `src/agents/cli-runner/execute.ts`
- `src/agents/cli-runner/helpers.ts`
- `src/agents/cli-runner/claude-live-session.ts`
- `src/agents/cli-output.ts`
- `src/agents/cli-session.ts`
- `src/gateway/cli-session-history.claude.ts`
- `src/commands/doctor-claude-cli.ts`
