# LLM API Logger Message Mapping Implementation Plan 2026-04-02

## 背景

基于对 `projects-ref/openclaw-llm-api-logger/logs/2026-03-30.jsonl` 的复核，当前可以确认：

- 普通用户入口 run 的 llm request `prompt` 中，通常直接包含 `message_id`
- 同一段 `prompt` 里还包含用户原始消息文本
- 这比现有的 `sessionKey + active run + started_at` 推断强得多
- 但 subagent、announce、startup、cron、slug 等派生 run 不适合套同一条规则

因此后续实现应以“主入口消息强绑定，派生 run 保留现有规则”为原则。

## 当前代码缺口

这份方案描述的是推荐实现方向，不代表当前仓库已经具备以下能力。

基于对现有代码的复核，当前至少还有这些前置缺口：

- `conversation_turns` 目前还没有：
  - `source_kind`
  - `source_session_id`
  - `source_logger_ts`
- `api-routes.ts` 里还没有：
  - `GET /audit/message/:messageId`
  - `GET /audit/session/:sessionKey/current-message-run`
- `src/logger-message-mapper.ts` 目前不存在
- 前端 `inject.js` 目前没有读取当前 chat message `message_id` 或 `__openclaw.id` 的逻辑

因此这份文档不能被理解为“直接按现有代码调用这些接口”，而应被理解为：

- 先补前置能力
- 再接主消息绑定链路

## 再确认后的结论

这轮回顾后，有两个需要明确写进实现方案的边界：

1. 不能只在整个 request 文本里搜索 `message_id`
2. 必须先确认该 run 属于“普通用户入口模板”

原因是：

- 某些辅助 run 的 prompt 或上下文摘要里也可能提到别的 `message_id`
- 如果直接做全局正则匹配，会把非用户入口 run 误判成可直接绑定

所以正确判定顺序必须是：

1. 先识别 prompt 形态
2. 再在指定 prompt 模板内提取 `message_id`

## 已确认的 run 分类

针对 `2026-03-30.jsonl` 样本，按 `prompt` 形态复核后的结果是：

- `user-entry`: `40`，且 `40/40` 可提取 `message_id`
- `subagent-task`: `2`，`0/2` 可提取
- `subagent-announce`: `2`，`0/2` 可提取
- `startup`: `1`，`0/1` 可提取
- `cron`: `1`，`0/1` 可提取
- `slug`: `1`，不应纳入主绑定路径

这里的 `slug` 特别需要单独强调：

- 它可能在上下文摘要中出现别的 `message_id` 文本
- 但这不是“当前 run 的入口 message_id”
- 实现中必须排除这种误判

## 目标

为 ClawLens 增加一条新的主消息绑定链路：

- 优先从 llm api request `prompt` 提取 `message_id`
- 建立 `message_id -> runId` 映射
- 前端 chat audit 基于 `message_id` 精确回查当前消息对应的 run

这条链路只覆盖：

- 普通用户入口消息触发的主 run

不强行覆盖：

- subagent
- announce
- startup/reset
- cron/lobster
- 其他辅助 run

## 设计原则

### 1. 分层绑定，不搞单一路径

绑定优先级建议改成：

1. `message_id -> runId` 强绑定
2. transcript explicit run metadata
3. pending transcript turn queue
4. `sessionKey + active run + time window` 近似绑定

也就是说，llm logger 方案不是替代所有旧逻辑，而是插到最前面，优先解决主入口消息。

### 2. 严格识别 prompt 模板

只对下面这种 prompt 开头做 `message_id` 提取：

```text
Conversation info (untrusted metadata):
```json
{
  \"message_id\": \"...\",
  ...
}
```
```

不满足此模板的 run，一律不走这条主路径。

### 3. 不依赖整块 JSON.parse

参考 logger 的 request 正文不是合法 JSON。

因此实现不应假设：

- `JSON.parse(requestBody)` 必定成功

而应采用：

- 顶层边界定位
- 模板化正则提取
- 明确失败分支

## 建议实现方式

## 方案 A：在 ClawLens 内复刻“可绑定字段”

这是更稳的方向。

思路：

- 不直接依赖离线 logger 文件
- 在运行时，尽量在 hook/collector 侧拿到等价字段
- 至少保存：
  - `runId`
  - `sessionKey`
  - `messageId`
  - `userTextPreview`
  - `sourceKind`

优点：

- 不需要运行时读外部日志文件
- 结构化程度高
- 查询成本低

缺点：

- 需要在更靠近 llm request 生成的位置补采集
- 如果当前 ClawLens 拿不到 `prompt` 原文，就需要上游 OpenClaw 提供字段

## 方案 B：从 llm-api-logger 解析并回灌索引

这是验证快、但工程依赖更重的方向。

思路：

- 定期扫描 logger 文件
- 识别 header + request block
- 仅对 `user-entry` prompt 提取：
  - `runId`
  - `sessionId`
  - `message_id`
  - 用户原文
- 写入一张本地索引表

优点：

- 不必等上游协议改动
- 可以快速验证“message_id 映射”是否足够稳定

缺点：

- 依赖日志文件存在且可访问
- 解析成本高
- 需要处理日志滚动、重复扫描、增量同步

## 方案建议

建议分两阶段推进：

### 第一阶段：先做可落地验证版

采用“解析 logger -> 回填现有 message 存储”的方式验证链路：

- 不新建平行索引表
- 优先复用已有 `conversation_turns.message_id`
- 为每条普通用户入口 run 回填 `message_id -> runId`
- 前端先只在 chat audit 中消费这条映射

这一步目标不是彻底替代现有逻辑，而是验证：

- 覆盖率是否足够高
- 查询速度是否可接受
- 用户侧是否能明显感知“当前消息对应的 run 更准了”

### 第二阶段：再决定是否上移到运行时结构化采集

如果验证结果成立，再考虑：

- 在 OpenClaw 或 ClawLens 更上游的位置直接采集 `message_id`
- 不再依赖解析 llm logger 文本

## 数据模型建议

当前仓库已经有一条现成的 message 存储链：

- `conversation_turns.message_id`
- `conversation_turns.run_id`
- `conversation_turns.session_key`

并且已有唯一索引与按 `message_id` 的 upsert 能力。

因此默认方案不应新建 `message_run_links`，而应优先复用 `conversation_turns`，只补当前缺的字段。

建议补充字段：

- `source_kind TEXT`
- `source_session_id TEXT`
- `source_logger_ts TEXT`

其中：

- `source_kind` 用来区分来源：
  - `llm_prompt_metadata`
  - `transcript_explicit`
  - `session_fallback`

如果后续证明确实需要脱离 `conversation_turns` 单独建索引表，再作为第二阶段重构处理，而不是默认第一步就双写两套真相源。

注意：

- 上述字段当前并不存在
- 必须先补 migration，再在代码和查询里使用

## 解析规则建议

### 1. 记录边界

按现有 logger 格式解析：

1. 单行 header JSON
2. `------`
3. request block
4. `------`
5. response block

### 2. 用户入口识别规则

只有满足下面条件才进入主提取流程：

- request 中可定位 `prompt`
- `prompt` 以 `Conversation info (untrusted metadata):` 开头

建议直接按下面伪代码实现，而不是口头理解：

```ts
function classifyPrompt(prompt: string): "user-entry" | "subagent-task" | "subagent-announce" | "startup" | "cron" | "slug" | "other" {
  if (prompt.startsWith("Conversation info (untrusted metadata):")) return "user-entry";
  if (prompt.includes("[Subagent Task]:")) return "subagent-task";
  if (prompt.includes("[Internal task completion event]")) return "subagent-announce";
  if (prompt.startsWith("A new session was started via /new or /reset.")) return "startup";
  if (prompt.startsWith("[cron:")) return "cron";
  if (prompt.startsWith("Based on this conversation, generate a short 1-2 word filename slug")) return "slug";
  return "other";
}

function shouldExtractMessageId(prompt: string): boolean {
  return classifyPrompt(prompt) === "user-entry";
}
```

拒绝规则必须写死：

- `subagent-task` 不提取
- `subagent-announce` 不提取
- `startup` 不提取
- `cron` 不提取
- `slug` 不提取
- `other` 不提取

第一版实现验收时，必须拿 `2026-03-30.jsonl` 回归这套分类结果，不能只看单条样本。

### 3. `message_id` 提取规则

只在该 prompt 模板内部提取：

- metadata code block 里的 `message_id`

不要在整个 request 全局搜索 `message_id`。

### 4. 用户消息文本提取规则

在 metadata block 之后，提取首段正文作为：

- `user_text_preview`

建议只保存短预览，例如前 `120` 到 `200` 字符。

### 5. 去重规则

同一 `message_id` 重复扫描时：

- 优先更新已有 `conversation_turns` 记录
- 不重复插入同一 `message_id`

同一 `runId` 如果没有 `message_id`：

- 不走 logger 主绑定路径
- 继续走旧逻辑

## 前端消费建议

chat audit 前端当前已有：

- `sessionKey` 级筛选
- active run / pending transcript 的近似归属

接入 `message_id -> runId` 后，建议新增一层，但必须先明确 `message_id` 来源。

当前前端代码里并没有现成的“当前 chat message `message_id`”读取逻辑，因此不能把实现写成“前端直接拿到 `message_id` 就查接口”，除非先补这个输入源。

建议把消费路径拆成两种：

### 路径 A：前端能直接拿到 `message_id`

例如未来如果 OpenClaw chat DOM 或前端状态里能稳定拿到 message metadata，则：

1. 当前 chat message 拿到 `message_id`
2. 调用查询接口
3. 若命中，优先展开对应 run
4. 未命中时，再回退到现有 session/run 推断逻辑

### 路径 B：前端拿不到 `message_id`

这是当前更现实的路径。

由后端按当前 session 做回查：

1. 前端只上传当前 `sessionKey`
2. 后端在现有 `conversation_turns` 中找最近的、`source_kind = llm_prompt_metadata` 的 user turn
3. 若命中对应 `run_id`，返回该 run
4. 未命中时，再回退到现有 session/run 推断逻辑

因此第一版实现不应把“前端直接拿 `message_id`”当成前提，而应优先提供后端回查接口。

补充约束：

- 当前前端还没有可靠的 `__openclaw.id` 接入点
- 如果后续证实 control-ui 前端无法稳定暴露该字段，则双层设计的第一版必须降级为“纯后端回查”，而不是强上前端实时层

## 后端实现步骤

### 第 0 步：补前置能力并做对账

正式实现前，必须先完成下面三项：

1. 在 `conversation_turns` 上补来源字段 migration
2. 验证 llm logger `prompt.message_id` 与 transcript `messageId` 是否同值
3. 确认前端是否有稳定的 `__openclaw.id` / 当前消息元数据读取路径

如果第 2 项失败，说明：

- logger `message_id` 与 transcript `messageId` 不是同一命名空间
- 则必须新增对账逻辑，不能直接把两者当同一键使用

如果第 3 项失败，说明：

- 第一版前端不能直接按消息 ID 查 run
- 必须退化为 session 级后端回查

第 0 步必须是可执行检查，不允许停留在口头判断。

建议执行方法：

1. 从 `2026-03-30.jsonl` 里抽取至少 `10` 条 `user-entry` 样本
2. 对每条样本记录：
   - 记下 `runId`
   - 记下 `prompt.message_id`
   - 记下 header `timestamp`
3. 去对应 session transcript 文件或 `onSessionTranscriptUpdate` 捕获结果里查同时间窗消息
4. 判断 transcript `messageId` 与 logger `prompt.message_id` 是否同值

判定标准：

- 若 `>= 8/10` 完全同值，可先按“同命名空间”推进，但仍保留风控日志
- 若 `< 8/10` 同值，第一版必须视为“不同命名空间”，增加对账层，不能直接共用主键

若判定为不同命名空间，决策流程必须改为：

1. logger `message_id` 单独存为 `source_logger_message_id`
2. transcript `messageId` 继续存为主 message key
3. 二者只允许通过 `sessionKey + textPreview + time window` 做弱对账，不允许互相覆盖

### 第一步：补字段而不是建平行表

在 `store.ts` 增加 schema migration：

- 优先复用 `conversation_turns`
- 增加 `source_kind`
- 增加 `source_session_id`
- 增加 `source_logger_ts`
- 视查询需要补辅助索引

### 第二步：增加解析器

建议新建独立模块，例如：

- `src/logger-message-mapper.ts`

职责：

- 扫描 logger 文件
- 解析记录边界
- 识别 `user-entry` prompt
- 提取 `message_id` / `user_text_preview`
- 回填到 `conversation_turns` 或等价的现有 message 存储层

约束：

- 解析器是待实现模块，不是当前已存在能力
- 必须显式实现 prompt 模板识别
- 严禁全 request 搜 `message_id`

不要把这部分杂糅进 `collector.ts`。

### 第三步：增加查询接口

在 `api-routes.ts` 增加轻量接口，例如：

- `GET /audit/message/:messageId`
- `GET /audit/session/:sessionKey/current-message-run`

返回：

- `messageId`
- `runId`
- `sourceKind`
- 简要 run summary

第二个接口用于当前第一版前端还拿不到 `message_id` 的情况。

`GET /audit/session/:sessionKey/current-message-run` 的最小返回契约必须固定下来：

```json
{
  "sessionKey": "agent:main:main",
  "status": "resolved",
  "lookupBasis": "latest-user-turn",
  "matchedTurn": {
    "role": "user",
    "messageId": "optional-transcript-message-id",
    "sourceKind": "llm_prompt_metadata",
    "textPreview": "再看下当前版本号",
    "timestamp": 1775121207120
  },
  "run": {
    "runId": "uuid-or-null",
    "status": "running",
    "startedAt": 1775121207200
  }
}
```

查找规则也必须固定：

1. 只在当前 `sessionKey` 范围内查
2. 只考虑 `role = user` 的 turn
3. 取最近一条 user turn 作为“当前消息”
4. 若该 turn 已有强绑定 run，返回 `resolved`
5. 若只有 fallback run，返回 `fallback`
6. 若找到了 user turn 但还没绑定 run，返回 `pending`
7. 若连 user turn 都没有，返回 `none`

### 第四步：前端接入

在 `inject.js` 中：

- 第一版优先调用 `GET /audit/session/:sessionKey/current-message-run`
- 如果未来前端能直接拿到 `message_id`，再升级为优先调用 `GET /audit/message/:messageId`
- 命中则直接定位 run
- 未命中再回退原逻辑

## 验证要点

### 功能验证

至少验证以下场景：

1. 普通用户消息触发主 run
2. 同一 session 连续多条普通消息
3. subagent task
4. subagent announce
5. startup/reset
6. cron/lobster
7. 前端无法直接拿到 `message_id` 时的 session 回查

预期：

- 前两类命中 `message_id -> runId`
- 后四类不误命中主路径

### 误判验证

重点验证：

- slug / summary / compaction 文本中提到别的 `message_id` 时，不应误绑定
- logger 重扫时，不应重复写入
- 缺少 logger 文件时，系统仍能回退到现有逻辑
- 已有 transcript turn 与 logger 回填同一 `message_id` 时，不应出现双记录或互相覆盖错 run

## 每步完成判据

### 第 0 步完成判据

- 有一份对账记录，至少覆盖 `10` 条 `user-entry` 样本
- 明确结论是“同命名空间”或“不同命名空间”
- 结论已写回实施记录，不允许口头带过

### 第 1 步完成判据

- `conversation_turns` 新字段已实际存在
- 通过 SQL 或代码查询确认字段可读写

### 第 2 步完成判据

- `logger-message-mapper.ts` 能在 `2026-03-30.jsonl` 上稳定跑完
- `user-entry` 识别结果与研究文档中的分类一致
- 不应命中 `subagent/startup/cron/slug`

### 第 3 步完成判据

- `/audit/session/:sessionKey/current-message-run` 返回契约与文档一致
- 无结果、pending、fallback、resolved 四种状态都可复现

### 第 4 步完成判据

- 前端在拿不到 `message_id` 时，仍能靠 session 回查定位当前 run
- 未命中时能稳定回退，不会卡住 Loading

### 第 5 步完成判据

- logger 补强不会把较强来源降级成较弱来源
- 重复导入同一日志不会产生重复或倒序覆盖

## 风险

### 1. 日志可达性风险

如果生产环境没有同等 logger 文件，方案 B 无法直接落地。

### 2. 格式漂移风险

如果未来 llm logger 调整了 prompt 模板：

- `Conversation info (untrusted metadata)` 可能变化
- 正则提取可能失效

因此实现时应把模板版本和失败日志打出来。

### 2.5 `messageId` 命名空间不一致风险

当前尚未证明：

- logger `prompt.message_id`
- transcript update `messageId`

二者一定是同一个值。

如果不一致，则需要：

- 增加映射/对账层
- 或改为“各自独立存储 + 会话内匹配”

### 3. 只覆盖主入口 run

这套方案的价值很高，但它不是“全覆盖 run 绑定方案”。

必须在文档和代码里写清：

- 它优先解决普通用户消息
- 不是统一解决所有派生 run

## 推荐执行顺序

建议按下面顺序推进：

0. 补 migration，并验证 logger `message_id` 与 transcript `messageId` 是否同值
1. 确认前端能否稳定读取当前消息元数据；若不能，则锁定“纯后端回查”第一版
2. 在 `conversation_turns` 上补来源字段
3. 实现 logger 解析器，先离线导入样本验证
4. 增加 `/audit/message/:messageId` 与 session 回查接口
5. 前端第一版优先消费 session 回查，后续再升级到直接 `message_id -> runId`
6. 稳定后再评估是否把这条能力上移到运行时结构化采集

## 最终结论

这次回顾后，可以确认之前的研究结论没有方向性问题，但实现上必须补一条约束：

- 不能“全 request 搜 `message_id`”
- 必须“先识别普通用户入口 prompt，再在该 prompt 内提取 `message_id`”

在这个约束下，`llm-api-logger` 可以成为 ClawLens 主消息绑定的强信源。

因此下一步最合理的工程路径是：

- 先做一版基于 logger 的 message 绑定增强，但优先复用现有 `conversation_turns`
- 第一版不要假设前端已经能直接读到 `message_id`
- 让普通 chat 消息优先命中强绑定，派生 run 继续保留现有多规则回退
