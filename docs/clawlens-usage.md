# ClawLens 使用说明

> [!IMPORTANT]
> Current Authority: This is the active master version for end-user usage guidance.
>
## 目录

1. [安装确认](#1-安装确认)
2. [Overview 监控面板](#2-overview-监控面板)
3. [Chat 审计侧栏](#3-chat-审计侧栏)
4. [瀑布图解读](#4-瀑布图解读)
5. [对话轮次列表](#5-对话轮次列表)
6. [API 接口](#6-api-接口)
7. [配置选项](#7-配置选项)
8. [故障排查](#8-故障排查)

---

## 1. 安装确认

ClawLens 安装后，有三种方式确认插件已正常加载：

**方式 A：检查 Gateway 日志**

重启 gateway 后，日志中应出现：
```
[plugins] ClawLens plugin started
```

**方式 B：访问 API**

打开浏览器或使用 curl：
```
http://localhost:18789/plugins/clawlens/api/overview
```
如果返回 JSON 数据（如 `{"activeRuns":0,"totalRuns24h":0,...}`），说明插件已加载。

**方式 C：查看 Dashboard**

打开 OpenClaw Control UI（`openclaw dashboard`），进入 Overview 页面，页面底部应出现 ClawLens 监控面板。

---

## 2. Overview 监控面板

**位置**：Overview 页面 → 现有卡片区域下方

面板显示四个核心指标：

| 指标 | 含义 |
|------|------|
| **Active Runs** | 当前正在执行的 agent 运行数量（实时） |
| **Runs (24h)** | 过去 24 小时内完成的 agent 运行总数 |
| **Tokens (24h)** | 过去 24 小时内消耗的 token 总量（输入+输出） |
| **Cost (24h)** | 过去 24 小时的估算费用（基于配置中的 cost-per-token 费率） |

面板每 5 秒自动刷新。当有新的 agent 运行开始或结束时，通过 SSE 实时推送立即更新。

**Cost 的计算说明**：费用根据 `openclaw.yaml` 中各 model provider 的 `cost` 配置计算。如果配置中没有 cost 信息，该字段显示 `—`。

---

## 3. Chat 审计侧栏

**位置**：Chat 页面 → 聊天区域右侧

### 3.1 打开方式

进入 Chat 视图后，聊天区域顶部（或 header 区域）会出现一个 **Audit** 按钮（青色）。点击打开审计侧栏，再次点击关闭。

### 3.2 侧栏内容

审计侧栏宽 320px，显示当前 session 的所有 agent 运行记录。每条记录对应一次用户消息触发的完整 agent 执行。

每个 Run 卡片包含：

```
┌──────────────────────────────────┐
│ #1 Run                     6.8s  │ ← 序号 + 总耗时
│ 帮我搜索今天的新闻并写个摘要     │ ← 用户 prompt 预览
│ 4.8K tok OFFICIAL               │ ← token（和官方 Usage 同源）
│ $0.0150 OFFICIAL                │ ← pi-ai 返回的 cost
│ $0.0148 CALCULATED  ≈ ✓        │ ← ClawLens 独立重算的 cost
│ 2 LLM · 1 tool                  │
├──────────────────────────────────┤
│ TIMELINE  EXCLUSIVE             │ ← 瀑布图（官方没有）
│ ■■■LLM■■■  ■■■■tool■■■■  ■■LLM■ │
│                                  │
│ TURNS                            │ ← 对话轮次（展开后可见）
│   user  帮我搜索今天的新闻...     │
│   asst  我来帮你搜索最新的...     │
│   tool  web_search → 5 results   │
│   asst  以下是今天的新闻摘要...   │
└──────────────────────────────────┘
```

### 3.3 数据来源标签

审计侧栏中，每个数据点旁边有小标签标注数据来源：

| 标签 | 颜色 | 含义 |
|------|------|------|
| **OFFICIAL** | 灰色 | 和官方 Usage 视图相同的数据源（同一个 message.usage 对象） |
| **CALCULATED** | 蓝色 | ClawLens 用 OpenClaw 的 cost 配置独立重算的数据 |
| **EXCLUSIVE** | 青色 | 官方 Usage 视图完全没有的数据（瀑布图、tool 详情等） |
| **≈ ✓** | 绿色 | OFFICIAL 和 CALCULATED 的 cost 差异在 0.1% 以内 |
| **⚠ DIFF** | 黄色 | 两个 cost 值差异超过 0.1%，悬停可查看差异原因 |

**差异原因示例**：
- pi-ai 内置定价和用户 config 中的自定义定价不同
- Provider 没有返回 cost，ClawLens 使用 fallback 计算
- models.json 定价已更新，旧数据使用了旧定价

### 3.4 交互

- **点击 Run 卡片头部**：展开/折叠该 run 的详情（瀑布图 + 对话轮次）
- **第一个 Run 默认展开**，其余折叠
- **切换 session**：当在 Chat 视图中切换到不同 session 时，审计侧栏自动刷新为新 session 的数据
- **侧栏关闭后数据保留**：重新打开不需要重新加载

### 3.5 汇总统计字段说明

| 字段 | 含义 |
|------|------|
| `N LLM` | 这次运行中调用了几次大语言模型（包括因 tool call 循环导致的多次调用） |
| `N tool` | 执行了几次 tool（如 web_search、bash 等） |
| `N tok` | 总 token 消耗（输入+输出，用 K/M 缩写） |
| `$N.NNN` | 估算费用（黄色高亮） |
| `N.Ns` | 总耗时（从 run 开始到结束） |

---

## 4. 瀑布图解读

瀑布图是一个水平时间线，展示一个 Run 内部每个步骤的执行顺序和耗时。

```
|■■■LLM■■■|          |■■■web_search■■■|          |■■■LLM■■■|
0s         1.2s       1.2s              4.7s       4.7s      6.8s
```

### 颜色编码

| 颜色 | 含义 |
|------|------|
| 蓝色（■） | LLM 调用 — 模型推理时间 |
| 绿色（■） | Tool 执行 — 工具运行时间 |

### 如何读

- **横轴**是时间，从左到右，左边缘是 run 开始，右边缘是 run 结束
- **每个色块的宽度**代表该步骤的耗时占总时间的比例
- **色块上的文字**是该步骤的耗时（如 `1.2s`、`3.5s`）
- **悬停色块**（hover）显示详细信息：步骤类型 + 耗时

### 典型模式

**简单问答**（无 tool call）：
```
|████████████████████████ LLM 2.3s ████████████████████████|
```
只有一个 LLM 调用块，占满整个时间线。

**搜索+回复**：
```
|■LLM 0.5s■|   |████ web_search 3.2s ████|   |■■■LLM 1.8s■■■|
```
三步：LLM 决定搜索 → tool 执行搜索 → LLM 生成回复。

**多 tool 并行**：
```
|■LLM■|  |█bash█|  |■LLM■|  |█bash█|  |█bash█|  |■LLM■|
```
多轮 LLM ↔ tool 交互，可能出现连续多个 tool。

---

## 5. 对话轮次列表

瀑布图下方是对话轮次列表，展示这个 Run 中完整的消息链。

### 角色颜色

| 颜色 | 角色 | 含义 |
|------|------|------|
| 灰色 | `user` | 用户发送的消息 |
| 红色 | `assistant` | 模型的回复（含 tool call 指令） |
| 绿色 | `tool` | tool 的返回结果 |

### 内容预览

每条轮次显示前 120 个字符的预览。完整内容可以在 Chat 主视图中查看对应的消息。

### 典型对话流

```
user       帮我搜索今天的新闻并写个摘要
assistant  我来帮你搜索最新的新闻。[tool_call: web_search]
tool       web_search → 5 results: 1. AI 领域...
assistant  以下是今天的新闻摘要：1. AI 领域最新进展...
```

这对应了一次 Run 的完整执行：用户提问 → 模型决定调用搜索 → 搜索返回结果 → 模型生成摘要。

---

## 6. API 接口

ClawLens 提供以下 HTTP API，可用于自动化监控或集成到其他工具。

所有 API 路径前缀：`/plugins/clawlens/api`

### 6.1 监控 API

| 端点 | 说明 |
|------|------|
| `GET /overview` | 全局汇总：活跃 run 数、24h 统计 |
| `GET /sessions?channel=&model=&since=&limit=` | Session 列表 + 每个 session 的汇总指标 |
| `GET /run/:runId` | 单个 run 的详细数据（含 llm_calls + tool_executions） |

### 6.2 审计 API

| 端点 | 说明 |
|------|------|
| `GET /audit/session/:sessionKey` | 某 session 的完整审计数据：所有 run + 每个 run 的瀑布图 + 对话轮次 |
| `GET /audit/run/:runId` | 单个 run 的审计详情 |

### 6.3 实时推送

| 端点 | 说明 |
|------|------|
| `GET /events?token=xxx` | SSE 连接，实时推送 run 开始/结束等事件 |

SSE 需要 gateway token 认证（通过 URL query 参数传递）。

### 6.4 响应示例

**`GET /overview`**

```json
{
  "activeRuns": 1,
  "totalRuns24h": 42,
  "totalTokens24h": 158000,
  "totalCost24h": 0.4523
}
```

**`GET /audit/session/telegram:user123`**

```json
{
  "sessionKey": "telegram:user123",
  "runs": [
    {
      "runId": "run-abc123",
      "startedAt": 1711234567890,
      "duration": 6800,
      "status": "completed",
      "userPrompt": "帮我搜索今天的新闻",
      "summary": {
        "llmCalls": 2,
        "toolCalls": 1,
        "totalInputTokens": 4000,
        "totalOutputTokens": 750,
        "totalCost": 0.015
      },
      "timeline": [
        { "type": "llm_call", "startedAt": 0, "duration": 1200, "inputTokens": 1200, "outputTokens": 150, "cost": 0.0042 },
        { "type": "tool_execution", "toolName": "web_search", "startedAt": 1200, "duration": 3500 },
        { "type": "llm_call", "startedAt": 4700, "duration": 2100, "inputTokens": 2800, "outputTokens": 600, "cost": 0.0108 }
      ],
      "turns": [
        { "role": "user", "preview": "帮我搜索今天的新闻", "length": 12 },
        { "role": "assistant", "preview": "我来帮你搜索...", "length": 45 },
        { "role": "tool", "preview": "web_search → 5 results", "length": 1200 },
        { "role": "assistant", "preview": "以下是今天的新闻摘要...", "length": 800 }
      ]
    }
  ]
}
```

---

## 7. 配置选项

在 `openclaw.yaml` 中配置 ClawLens：

```yaml
# 插件安装
plugins:
  installs:
    clawlens:
      source: path
      spec: ~/.openclaw/extensions/clawlens

# 插件配置（可选）
clawlens:
  # 全局监控（默认开启）
  collector:
    enabled: true              # 是否启用数据采集
    snapshotIntervalMs: 60000  # Session 快照同步间隔（毫秒）
    retentionDays: 30          # 数据保留天数，超过后自动清理

  # 并发多模型对比（默认关闭，开启后会产生额外 token 费用）
  compare:
    enabled: false
    models:                    # 对比模型列表
      - provider: anthropic
        model: claude-sonnet-4-20250514
      - provider: openai
        model: gpt-4o
      - provider: google
        model: gemini-2.5-flash
    channels: ["telegram"]     # 只在指定 channel 生效
    timeoutMs: 300000          # 对比运行超时时间（5 分钟）
    maxConcurrent: 3           # 最多同时几个对比运行
```

### 配置说明

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `collector.enabled` | `true` | 关闭后不采集任何数据，Overview 面板和审计侧栏将为空 |
| `collector.retentionDays` | `30` | SQLite 数据库自动清理策略，Gateway 停止时执行 |
| `compare.enabled` | `false` | **注意**：开启后每条用户消息会额外触发 N 个模型运行，费用翻倍 |
| `compare.channels` | `[]` | 空数组 = 不限制，所有 channel 都触发对比 |

### 数据存储位置

ClawLens 的 SQLite 数据库文件位于：
```
~/.openclaw/clawlens/clawlens.db
```

如果设置了 `OPENCLAW_STATE_DIR` 环境变量，则在 `$OPENCLAW_STATE_DIR/clawlens/clawlens.db`。

---

## 8. 故障排查

### 8.1 Overview 面板不显示

**症状**：Overview 页面没有 ClawLens 面板。

**排查步骤**：

1. **确认插件已加载**：检查 gateway 日志是否有 `ClawLens plugin started`
2. **确认 inject.js 已注入**：检查 `dist/control-ui/index.html` 是否包含 `<script src="/plugins/clawlens/ui/inject.js">`
3. **确认 inject.js 可访问**：浏览器访问 `http://localhost:18789/plugins/clawlens/ui/inject.js`，应返回 JS 代码而非 404
4. **检查浏览器控制台**：打开开发者工具（F12），Console 标签页，查看是否有报错

### 8.2 审计侧栏不显示

**症状**：Chat 页面没有 Audit 按钮或侧栏。

**排查步骤**：

1. **确认 inject.js 已加载**（同 8.1 步骤 2-4）
2. **确认有审计数据**：在浏览器地址栏访问 `http://localhost:18789/plugins/clawlens/api/audit/session/<当前sessionKey>`，检查是否返回数据
3. **确认 sessionKey 获取正确**：在浏览器控制台执行 `document.querySelector(".chat-session select")?.value`，应返回当前 session key

### 8.3 数据为空（Tokens/Cost 显示 0）

**症状**：面板显示但所有数字都是 0。

**排查步骤**：

1. **确认有 agent 运行**：在任意 channel 发送一条消息，等待 agent 完成
2. **检查 API 数据**：`curl http://localhost:18789/plugins/clawlens/api/overview`
3. **检查 hook 注册**：gateway 日志中搜索 `hook` 或 `clawlens`，看是否有注册失败的警告
4. **Cost 为 0 但 Tokens 有值**：说明 `openclaw.yaml` 中没有配置模型的 cost 费率

### 8.4 SSE 连接失败

**症状**：面板数据不自动刷新。

**排查步骤**：

1. 浏览器控制台查看是否有 EventSource 相关错误
2. 检查 SSE endpoint：`curl -N "http://localhost:18789/plugins/clawlens/api/events?token=<gateway-token>"`，应看到 `data: {"type":"connected"}` 输出
3. Token 不正确：SSE 需要 gateway token 认证，从 `sessionStorage` 的 `openclaw.control.token.v1:*` key 获取

### 8.5 远程访问问题

**症状**：本地浏览器无法访问远程部署的 ClawLens。

**解决**：Gateway 默认绑定 `127.0.0.1`，需要通过 SSH 隧道访问：

```bash
ssh -L 18789:127.0.0.1:18789 user@remote-host
```

然后在本地浏览器打开 `openclaw dashboard --no-open` 输出的 URL。
