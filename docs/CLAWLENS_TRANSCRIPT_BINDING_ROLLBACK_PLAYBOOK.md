# ClawLens Transcript Binding Strategy + Rollback Playbook

## 目标

为 transcript 到 run 的绑定逻辑提供可切换策略，并确保在异常场景下可以快速回退到历史行为。

## 策略开关

- 配置键：`collector.transcriptBindingStrategy`
- 可选值：
  - `legacy_recent_window`（默认）
  - `safe_message_anchor`（收紧回退窗口 + ended run 保护）

默认保持 `legacy_recent_window`，保证当前线上行为不变。

## 当前实现位置（回退索引）

使用以下索引标记快速定位本次改动：

- `ROLLBACK_INDEX: CLAWLENS_TRANSCRIPT_BINDING_STRATEGY`

推荐命令：

```bash
rg -n "ROLLBACK_INDEX: CLAWLENS_TRANSCRIPT_BINDING_STRATEGY" \
  extensions/clawlens/index.ts \
  extensions/clawlens/src/{collector.ts,store.ts,types.ts}
```

涉及文件：

- `extensions/clawlens/src/types.ts`
- `extensions/clawlens/index.ts`
- `extensions/clawlens/src/collector.ts`
- `extensions/clawlens/src/store.ts`

## 行为差异

### 1) `legacy_recent_window`（默认，历史行为）

- 优先级：`explicitRunId -> active run -> recent run`
- recent run 默认窗口：5 分钟
- 不限制 run 是否已结束

### 2) `safe_message_anchor`（实验策略）

- 优先级：`explicitRunId -> active run -> recent run`
- recent run 回退窗口：90 秒
- 仅允许绑定到 running 或刚结束 20 秒内的 run

注意：该判断以 transcript message 的 `timestamp` 为准；若消息缺失 timestamp，
会回退使用当前时间（`Date.now()`），这会让 delayed/queued 消息看起来“超出 grace 窗口”。

## 验证步骤

1. 发送连续消息（含忙时排队场景），观察是否出现跨轮混 run。
2. 发送第二条独立消息，确认会生成独立 run 并出现在 audit。
3. 检查 `unknown` run 是否下降：

```bash
ssh szhdy 'export PATH="/home/openclaw/.nvm/versions/node/v24.14.0/bin:/home/openclaw/.local/share/pnpm:$PATH" && node -e "
const { DatabaseSync } = require(\"node:sqlite\");
const db = new DatabaseSync(process.env.HOME + \"/.openclaw/clawlens/clawlens.db\");
const rows = db.prepare(\"select run_id, started_at, session_key, (select count(*) from conversation_turns t where t.run_id=runs.run_id) as turn_count from runs where session_key=? order by started_at desc limit 20\").all(\"unknown\");
console.log(JSON.stringify(rows, null, 2));
"'
```

## 一键回退步骤（推荐）

将策略强制切回 `legacy_recent_window`，然后重启网关：

```bash
ssh szhdy 'export PATH="/home/openclaw/.nvm/versions/node/v24.14.0/bin:/home/openclaw/.local/share/pnpm:$PATH" && node -e "
const fs = require(\"fs\");
const p = process.env.HOME + \"/.openclaw/openclaw.json\";
const cfg = JSON.parse(fs.readFileSync(p, \"utf8\"));
cfg.plugins = cfg.plugins || {};
cfg.plugins.entries = cfg.plugins.entries || {};
cfg.plugins.entries.clawlens = cfg.plugins.entries.clawlens || {};
cfg.plugins.entries.clawlens.config = cfg.plugins.entries.clawlens.config || {};
cfg.plugins.entries.clawlens.config.collector = cfg.plugins.entries.clawlens.config.collector || {};
cfg.plugins.entries.clawlens.config.collector.transcriptBindingStrategy = \"legacy_recent_window\";
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + \"\\n\");
console.log(\"set transcriptBindingStrategy=legacy_recent_window\");
" && openclaw gateway restart'
```

## 完整代码回退（可选）

若需回退本次策略开关代码本身：

1. 用回退索引定位改动点。
2. 恢复以下文件到上一个稳定提交版本：
   - `extensions/clawlens/src/types.ts`
   - `extensions/clawlens/index.ts`
   - `extensions/clawlens/src/collector.ts`
   - `extensions/clawlens/src/store.ts`

建议优先使用“策略回退”而不是“代码回退”，风险更低。

## 环境说明

文档中的 `ssh szhdy`、`~/.openclaw/...` 与 Node/PATH 仅为当前环境示例。
迁移到其他环境时，请替换为对应主机、路径与 Node 安装位置。
