# ClawLens Transcript Binding Strategy + Rollback Playbook

## 目标

记录 transcript -> run 绑定逻辑的当前状态、待实现项与可回退路径，避免后续改动再次引入“queued 消息混 run”问题。

## 当前状态（2026-04-11）

已实现：

1. `A`：Queued 消息在缺少硬锚点时不再回落到 active/recent，改为 deferred pending。
2. `D`：`unknown` run 反查必须带 timestamp，并去掉无时间约束的宽匹配兜底。
3. `E`：active run 会话前缀匹配由双向收紧为单向，降低跨会话误绑。

待实现（仅在复现后再做）：

1. `B`：timeline 按 `run_kind` 过滤（可能隐藏真实事件，需谨慎）。
2. `C`：completion/backfill 额外 grace（建议优先考虑 store 级 backfill，而非延长 activeRuns 生命周期）。

## 策略开关

- 代码默认：`legacy_recent_window`
- 可选策略：`safe_message_anchor`
- 运行时环境变量（优先级最高）：
  - `CLAWLENS_TRANSCRIPT_BINDING_STRATEGY=safe`
  - `CLAWLENS_TRANSCRIPT_BINDING_STRATEGY=legacy`

说明：当前远端 `openclaw.json` schema 可能拒绝 `plugins.entries.clawlens.config.collector.transcriptBindingStrategy`，优先使用环境变量切换。

## 回退索引 + 文档索引

索引以 `## Code Index` 章节为唯一事实来源（single source of truth）。
本节仅保留检索命令，避免与 `Code Index` 内容重复维护。

检索命令：

```bash
rg -n "ROLLBACK_INDEX: CLAWLENS_TRANSCRIPT_BINDING_STRATEGY|DOC_INDEX: CLAWLENS_TRANSCRIPT_BINDING_PLAYBOOK" \
  extensions/clawlens/index.ts \
  extensions/clawlens/src/{collector.ts,store.ts,types.ts}
```

## Code Index

CODE_INDEX: CLAWLENS_TRANSCRIPT_BINDING_PLAYBOOK
files:
- extensions/clawlens/src/collector.ts
- extensions/clawlens/src/store.ts
entry_points: resolveTranscriptRunId, findUnknownRunIdByPromptMessageId, findActiveRunIdForSessionKind

CODE_INDEX: CLAWLENS_TRANSCRIPT_BINDING_STRATEGY
files:
- extensions/clawlens/index.ts
- extensions/clawlens/src/types.ts
- extensions/clawlens/src/collector.ts
- extensions/clawlens/src/store.ts
entry_points: resolveTranscriptBindingStrategy, findRecentRunIdForSession

## 开发前必做检查（强制）

凡是修改以下任一逻辑，先阅读本文档再动代码：

1. `resolveTranscriptRunId`
2. `findActiveRunIdForSessionKind`
3. `findUnknownRunIdByPromptMessageId`
4. `findRecentRunIdForSession`
5. pending transcript turn 的 queue/drain

最小检查清单：

1. 是否引入 queued 消息在“无锚点”时回落到 active/recent 的路径？
2. 是否新增了无 timestamp 的 unknown-run 匹配？
3. 是否放宽了 session 前缀匹配？
4. 是否保留了可回退开关（legacy/safe）？
5. 是否完成了“连续两条 + queued”回归验证？

## 回归验证（推荐）

1. 快速发送两条 Discord 消息，触发 `[Queued messages while agent was busy]`。
2. 确认第二条不再混入第一条 run。
3. 对账三源：session jsonl / clawlens.db / llm-api logger。
4. 检查 `unknown` run：

```bash
ssh szhdy 'export PATH="/home/openclaw/.nvm/versions/node/v24.14.0/bin:/home/openclaw/.local/share/pnpm:$PATH" && node -e "
const fs = require(\"fs\");
const p = process.env.HOME + \"/.openclaw/state/plugins/clawlens/clawlens.db\";
console.log(\"db:\", p);
console.log(\"tip: use sqlite3/better-sqlite3 to inspect runs where session_key=unknown and turn_count=0\");
"'
```

## 快速回退

### 1) 策略回退（首选）

将环境变量切回 legacy（按你的网关启动方式设置），然后重启网关：

- `CLAWLENS_TRANSCRIPT_BINDING_STRATEGY=legacy`

### 2) 代码回退（兜底）

按回退索引定位并回退以下文件到稳定提交：

- `extensions/clawlens/src/types.ts`
- `extensions/clawlens/index.ts`
- `extensions/clawlens/src/collector.ts`
- `extensions/clawlens/src/store.ts`

## 环境说明

文档中的 `ssh szhdy`、`~/.openclaw/...` 与 Node/PATH 仅为当前环境示例。迁移到其他环境时请替换为对应主机、路径与 Node 安装位置。
