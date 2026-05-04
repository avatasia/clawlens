# ClawLens Source Lookup Roots and Reset Behavior

本文记录 2026-05-01 远端验证过程中确认到的两类运行时事实：

1. 当前版本 OpenClaw 会话在 `reset` 后会清空 Chat 侧可见聊天记录，因此只依赖 Chat/API 视角的 transcript 读取并不稳妥。
2. `~/.openclaw/agents/` 下的 session 文件目录不应长期假设为单一固定根，例如 `agents/main/sessions`；已有 channel/plugin 行为表明动态 agent 目录是现实存在的。

这些结论当前主要用于指导 ClawLens 的 source lookup 配置和后续设计，不是对上游机制的最终权威定义。

## 已核实事实

### 1. reset 后 Chat/API 侧记录不稳

运行事实来源：

- 操作者口头确认：当前版本 OpenClaw 在会话 `reset` 后会清空聊天记录。
- 2026-05-01 远端已完成一次真实 RPC 序列实测：
  - `sessions.create`
  - `chat.send` 三轮短消息
  - `chat.history`
  - `chat.send('/reset')`
  - 再次 `chat.history`
  - 直接读取 `agents/main/sessions/*.jsonl*`
- ClawLens 本轮功能目标本身也已经把“default preview-only + explicit JSONL source lookup”作为主路径，而不是依赖 Chat 端完整回放。

实测结果：

- reset 前，`chat.history` 返回 6 条消息：
  - 3 条 user prompt
  - 3 条 assistant ack
- reset 后，同一 session key 的 `chat.history` 只剩 1 条 assistant 消息：
  - `✅ Session reset.`
- session store 中同一 session key 对应的：
  - `sessionId` 发生变化
  - `sessionFile` 发生变化
- 旧 transcript 没有丢失，而是被归档为：
  - `<oldSessionId>.jsonl.reset.<timestamp>`
- 归档文件仍包含 reset 前的全部 prompt / assistant ack 文本。

工程含义：

- 如果 source lookup 建立在“之后还能从 Chat/API 补回完整 transcript”的假设上，这个假设并不稳。
- 对于 audit / source replay 场景，直接读取 `agents/.../sessions/*.jsonl` 仍然是最稳妥的证据源。

与 ClawLens 插件侧的对应实测：

- 对同一 session key，OpenClaw `chat.history` reset 后只剩 reset 确认消息；
- 但 ClawLens `audit/session/:sessionKey` 仍可返回 reset 前的多个 chat runs；
- 这些 runs 的 turns 仍携带 reset 前 transcript 的 `sessionFile`，并且 `hasSourceLookup=true`。

因此，当前实现里“preview 负责默认展示，full source lookup 负责回到旧 JSONL”这条分工，在 reset 场景下是被远端实测支持的。

### 2. 当前远端已经确认存在 `agents/main/sessions`

远端实际目录（本轮验证）：

- `~/.openclaw/agents/main/sessions`

远端实际 JSONL 文件样本（本轮验证）包括：

- `<sessionId>.jsonl`
- `<sessionId>.trajectory.jsonl`
- `<sessionId>.checkpoint.<uuid>.jsonl`

这说明就算只看 `main`，session 存储形态也不是单一文件名。

### 3. wecom 插件存在“动态 agent 目录”风险

操作者补充说明：

- wecom 插件会在 `agents/` 目录下建立多个动态目录。
- 不排除其他 channel/plugin 也采用同类模式。

本轮远端验证没有直接枚举出 wecom 的动态 `agents/*/sessions` 树。当前这台远端机器上，实际枚举到的 agent 目录只有：

- `~/.openclaw/agents/main/sessions`

但 `sessions.json` 中已经出现多种 channel 会话 key：

- `agent:main:openclaw-weixin:...`
- `agent:main:wecom:...`
- `agent:main:yuanbao:...`
- `agent:main:discord:...`
- `agent:main:qqbot:...`

因此，这个信息仍足以作为设计约束：

- 不能把 `agents/main/sessions` 当作长期充分条件；
- 它最多只是当前一台机器、当前一批会话的安全默认值。

## 与当前 ClawLens 实现的关系

相关代码：

- `extensions/clawlens/src/source-resolver.ts`
- `extensions/clawlens/src/store.ts`
- `extensions/clawlens/src/api-routes.ts`

### 1. 当前实现并不只依赖 `sourceLookupDirs`

`source-resolver.ts` 的 `collectTrustedRoots()` 逻辑当前会同时信任：

- `sessionFile` 的实际父目录
- `collector.sourceLookupDirs` 中配置的显式根目录

这意味着：

- 只要 store 里已经记录了准确的 `sessionFile` 绝对路径，即使该路径不在 `sourceLookupDirs` 的“预设单一根”里，resolver 仍然可以工作。
- `sourceLookupDirs` 当前更像“额外显式允许的根”与“无 `sessionFile` 时的全局能力提示”，不是唯一来源。

### 2. 当前实现对“多动态目录”并非完全脆弱

对于 audit detail / source route 当前主路径：

- turn/tool anchor 会把 `sessionFile` 存进 store；
- route 层 `hasSourceLookup` 会基于 `hasTrustedSourceRoots(turn.sessionFile, sourceLookupDirs)` 判断；
- resolver 最终仍会把 `dirname(sessionFile)` 纳入 trusted roots。

所以：

- 如果某条会话记录已经带有真实 `sessionFile`，哪怕它来自 `agents/<dynamic>/sessions/...`，当前 source lookup 仍有机会正常工作。

### 3. 当前配置仍存在“运营层误导”风险

虽然代码不只依赖 `sourceLookupDirs`，但运维/配置层仍可能被误导：

- 如果把 `collector.sourceLookupDirs` 固定写成 `~/.openclaw/agents/main/sessions`
- 容易让人误以为 source lookup 的世界只有这一棵树

这在以下场景里会变成隐患：

1. 某些 channel/plugin 的 transcript 不落在 `main/sessions`
2. 某些旧记录没有稳定写入 `sessionFile`
3. 后续若加入“按 roots 主动发现 session 文件”的路径，过窄的默认根会直接漏数据

## 设计结论

### 结论 A

对于 transcript/source replay，`agents/.../sessions/*.jsonl` 仍应被视为主证据源。

原因：

- Chat/API 视角会受 reset 后记录清空影响；
- reset archive `.jsonl.reset.*` 中仍保存旧对话；
- JSONL 文件是更稳定的持久化来源。

### 结论 B

`agents/main/sessions` 只能当作当前远端验证中的“临时安全默认值”，不能升级为长期产品假设。

### 结论 C

后续如果要把 source lookup 做成更稳的默认能力，方向应该是：

1. 保持 `sessionFile` 精确落库优先
2. 在配置层允许多个 roots，而不是单一路径
3. 明确文档说明：
   `sourceLookupDirs` 是“显式允许的补充根”，不是 transcript 世界的唯一真相
4. 对动态 agent 目录保留发现/扩展空间

## 对当前远端配置的建议

本轮远端验证里，为了把 source lookup 能力先打开，使用了：

- `collector.sourceLookupEnabled=true`
- `collector.sourceLookupDirs=["/home/openclaw/.openclaw/agents/main/sessions"]`

这对当前远端已有 `main` 会话足够，但它只是验证配置，不应被误读为长期最佳实践。

如果远端后续确认存在多条 `agents/<dynamic>/sessions` 路径，建议：

1. 把这些真实根目录显式加入 `sourceLookupDirs`
2. 同时继续依赖 store 中记录的 `sessionFile`
3. 把“动态 agent roots”补进运维/SOP 文档，而不是只留在一次性验证记录里

## 当前建议的文档态度

短期：

- 在远程验证/部署类文档里，把 `agents/main/sessions` 表述成“当前验证样例路径”
- 不把它写成长期唯一根目录

中期：

- 若 wecom 或其他 channel 的动态 `agents/*/sessions` 结构被进一步确认，单独补一份 channel/root mapping 研究或在远端部署 SOP 中加入多 root 配置示例

## files

- `extensions/clawlens/src/source-resolver.ts`
- `extensions/clawlens/src/store.ts`
- `extensions/clawlens/src/api-routes.ts`
- `docs/plans/IMPLEMENTATION_CLAWLENS_REMOTE_VALIDATION_PREP_2026-05-01.md`
