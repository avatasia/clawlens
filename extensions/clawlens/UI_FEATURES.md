# ClawLens UI 功能说明

## 一、Overview 面板

注入在 OpenClaw 控制台左侧边栏，始终可见。

```
┌─────────────────────────────────────────────┐
│ CLAWLENS                          ● Audit → │
├─────────────┬───────────────────────────────┤
│      1      │              60               │
│ Active Runs │           Runs (24h)          │
├─────────────┼───────────────────────────────┤
│    1.38M    │              $0               │
│ Tokens (24h)│           Cost (24h)          │
└─────────────┴───────────────────────────────┘
```

| 元素 | 说明 |
|------|------|
| `●` SSE 指示灯 | 绿色=实时连接正常，橙色=断开 |
| Active Runs | 当前正在运行的 agent 数 |
| Runs (24h) | 过去 24 小时总运行次数 |
| Tokens (24h) | 过去 24 小时累计 token 数（输入+输出） |
| Cost (24h) | 过去 24 小时累计费用 |
| `Audit →` 按钮 | 打开审计抽屉（见下节） |

数据每 30 秒轮询刷新，SSE 有事件时立即刷新。

---

## 二、Audit 抽屉（Overview 入口）

点击 `Audit →` 按钮从右侧滑入，覆盖全屏高度。

```
┌──────────────────────────────────────────────────────────┐
│ 🔍 ClawLens Audit    [最近 7 天 ▼] [Channel 筛选] [↻] [✕]│
├──────────────┬───────────────────────────────────────────┤
│ Session 列表 │  Session 详情                             │
│              │                                           │
│ ─ (unknown)  │  unknown · 60 runs · 1.38M tok · avg 12s │
│  50 runs     │  ┌─────────────────────────────────────┐  │
│  0 tok  $0   │  │ ▸ 2026-03-24 13:46:48  ✓ completed  │  │
│  22h ago     │  │   0 tok  $0  💬1  🔧2  31s          │  │
│              │  ├─────────────────────────────────────┤  │
│ agent:main:  │  │ ▸ 2026-03-24 13:44:14  ✓ completed  │  │
│  7 runs      │  │   ...                               │  │
│  ...         │  └─────────────────────────────────────┘  │
└──────────────┴───────────────────────────────────────────┘
```

### 左栏：Session 列表

- 按最后活跃时间降序排列
- 每条显示：session key、channel/model 标签、运行次数/token 数/费用、相对时间
- 点击选中，右栏加载该 session 的 run 详情
- 支持按天数（今天 / 7 天 / 30 天 / 全部）和 channel 名称筛选

### 右栏：Run 时间线

每个 run 显示为可展开卡片：

**收起状态**
```
▸  2026-03-24 13:46:48   ✓ completed   MiniMax-M2.7   31s   174.2K tok   $0   💬1  🔧2
```

**展开后**
```
▾  2026-03-24 13:46:48   ✓ completed   ...
   ↑ 107K in  ↓ 0.5K out  ⚡ 31K cached  $0

   💬 LLM Calls (1)                        ▾
   ─────────────────────────────────────────────
   #0  MiniMax-M2.7   —    ↑107K ↓597   $0   tool_use

   🔧 Tool Calls (2)
   ─────────────────────────────────────────────
   exec      ×1   123ms/call
   gateway   ×1   314ms/call
```

| 字段 | 含义 |
|------|------|
| `↑` input / `↓` output | LLM 输入/输出 token |
| `⚡` cached | Cache read token 数（节省费用） |
| 💬N | 该 run 的 LLM 调用次数 |
| 🔧N | 该 run 的 tool 调用次数 |
| 红色卡片边框 | 该 run 状态为 error |

---

## 三、Chat 审计侧栏（Chat 视图入口）

进入 `/chat` 页面后，右上角自动出现 **Audit** 按钮。点击在聊天区域右侧展开 320px 侧栏。

```
┌────────────────────────────────────────────────────────────────┐
│ Chat 主区域                              │ ClawLens Audit   [✕] │
│                                          │──────────────────────│
│ [消息列表]                               │ #1 Run        31.3s  │
│                                          │ (no prompt)          │
│                                          │ 1 LLM  2 tool  ...   │
│                                          │──────────────────────│
│                                          │ Timeline             │
│                                          │ ████░░░░░░░░░░░░░░   │
│                                          │ LLM  Tool            │
│                                          │──────────────────────│
│                                          │ Turns                │
│                                          │  user │ hello...     │
│                                          │  asst │ 你好...      │
└────────────────────────────────────────────────────────────────┘
```

### Run 卡片

每个对话 run 显示为可折叠卡片，默认展开第一个：

| 区域 | 内容 |
|------|------|
| 标题行 | `#N Run`、耗时、用户 prompt 预览（前 200 字符） |
| 统计行 | LLM 次数、tool 次数、token 数、费用 |

### Timeline 甘特条

```
[████ LLM ████░░░░░░░░░░░░████░░░░░░░░░░░░ Tool ██]
```

- 蓝色块 = LLM 调用，绿色块 = Tool 执行
- 宽度按占总耗时的比例渲染
- Hover 显示具体耗时标签

### Turns 对话轮次

```
   user │ 帮我查一下当前 openclaw 配置里的 plugin...
   asst │ 好的，我来帮你查看...
   tool │ {"content": [{"type": "text"...
```

> **注**：Turns 数据仅在插件部署后发生的新对话中有效；历史 run 的 Turns 为空，Timeline 则取决于当时是否有 LLM/tool 调用记录。

### 会话自动跟踪

- 从 URL 参数 `?session=` 或 DOM 中的 session select 自动获取当前 session key
- 每 10 秒轮询检测 session 是否切换，切换后自动重新拉取数据
- SSE 收到 `run_started` / `run_ended` / `llm_call` 事件时自动刷新

---

## 数据流总览

```
OpenClaw Agent 运行
       │
       ├─ llm_input hook  →  记录 user prompt、sessionId→runId 映射
       ├─ llm_output hook →  记录 LLM call（tokens、cost、model）
       ├─ after_tool_call →  记录 tool 执行（name、耗时、是否报错）
       ├─ lifecycle end   →  800ms 后聚合写 run 统计（等 llm_output 先到）
       └─ agent_end hook  →  写入完整 conversation turns
                                        │
                                   SQLite DB
                                        │
              ┌─────────────────────────┼──────────────────────┐
              │                         │                      │
        /api/overview            /api/audit           /api/audit/run
        (4 个聚合指标)        /session/:key           /:runId
                             (timeline + turns)    (单 run 详情)
                                        │
                                   inject.js 渲染
                              Overview 面板 / Audit 抽屉 / Chat 侧栏
```
