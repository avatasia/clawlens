# Chat Audit Remaining Work Analysis

## 范围

本文件汇总当前 Chat Audit 主线修复完成后，仍然保留的后续工作项。

目标不是重复记录已经修复的问题，而是回答：

- 还剩什么没做
- 为什么它还没做
- 当前影响是否阻塞
- 后续应按什么顺序推进

## 当前已完成基线

截至本轮，以下主线能力已经可用：

- 当前消息到当前 run 的回查链路已可用
- `current-message-run` 能正确命中最新用户消息
- `llm_calls` / `tool_executions` / `timeline` 的写入缺口已修复
- 运行中的与完成后的 run 详情已能正常显示
- 临时排障日志已沉淀为开关式方案

同时，调试开关的代码接线也已经完成：

- `index.ts` 已调用 `store.setDebugEnabled(config.collector?.debugLogs)`
- `collector` 与 `store` 都已接入统一调试开关判断

因此，本文件中的项目都应被视为：

- 增强项
- 工程收尾项
- 后续精度提升项

而不是当前功能阻塞项。

## 运行环境要求

当前这套实现依赖 `node:sqlite`，对应的运行前提是：

- Node.js `22.5.0+`

这不是本轮新增的剩余项，而是现有实现已经隐含依赖的运行条件。  
若目标环境低于该版本，`Store` 无法正常初始化，相关能力将直接不可用。

## 剩余项一：llm-api-logger 自动导入链路未接入

### 当前状态

目前仓库里已经有关于 logger message mapping 的研究和实施方案：

- [LLM_API_LOGGER_MESSAGE_MAPPING_RESEARCH_2026-04-02.md](../../LLM_API_LOGGER_MESSAGE_MAPPING_RESEARCH_2026-04-02.md)
- [LLM_API_LOGGER_MESSAGE_MAPPING_IMPLEMENTATION_PLAN_2026-04-02.md](../../LLM_API_LOGGER_MESSAGE_MAPPING_IMPLEMENTATION_PLAN_2026-04-02.md)

同时本地代码中已经新增了 `logger-message-mapper.ts`。它已经具备本地可执行的解析逻辑，包括：

- prompt 分类
- 仅对 `user-entry` prompt 提取 `message_id`
- 从三段式 logger 记录中提取 `prompt`
- 生成 `message_id -> runId` 映射候选

但它还没有真正接进：

- 插件启动流程
- 周期性导入流程
- 手动触发的导入命令

### 为什么还没做

本轮的优先级一直放在：

1. 先让 `current-message-run` 基于 transcript 跑通
2. 先修复 `llm_calls/tool_executions` 明细丢失
3. 先确认运行中的 Audit 能稳定工作

在这条主线上，logger 自动导入并不是必要前置条件。

更具体地说：

- 没有 logger 自动导入，当前回查链路仍然能工作
- 只是精度和补强能力不足
- 尤其在 transcript 与 run 只靠 session 近似归属的边界场景下，logger 解析能进一步提高强绑定能力

### 当前影响

影响主要体现在“精度增强”而不是“可用性缺失”：

- 当前普通 web chat 已经可用
- 但 `llm_prompt_metadata` 这条更强的补强链路还没上线
- 某些边界 run 归属仍主要依赖 transcript 和 session 回查

### 风险

如果直接推进这条链路，仍要面对这些已知问题：

- `logger message_id` 与 `transcript messageId` 尚未在线对账验证
- `logger-message-mapper` 需要严格限制只识别 `user-entry` prompt
- 文件读取路径、权限和远端部署形态还需要最终确认

### 结论

这项属于中优先级增强项。  
建议在当前主线稳定后推进，但不应在没有完成第 0 步验证前直接实现上线。

## 剩余项二：双层设计中的前端实时层未接入

### 当前状态

当前消息关联实际上已经落地的是“后端回查优先”方案：

- 前端侧栏打开后，调用后端 `current-message-run`
- 后端根据当前 session 最近 user turn 回查 run
- 再回到 run 详情接口获取详情

这条链已经可用，但它不是最初双层设计里的最终形态。

双层设计文档在：

- [CHAT_AUDIT_MESSAGE_MAPPING_DUAL_LAYER_DESIGN_2026-04-02.md](../../CHAT_AUDIT_MESSAGE_MAPPING_DUAL_LAYER_DESIGN_2026-04-02.md)

### 原设计目标

双层设计的本意是：

- 前端当前会话流负责“快”
- 后端 transcript/logger 负责“准”

也就是说，理想状态下前端不必完全依赖后端回查，而是能够直接从 control-ui 当前消息流中拿到：

- 当前消息位置
- 当前消息 ID / 顺序信息
- 当前页面上下文中的真实“最新消息”

### 为什么还没做

这一层没有落地，核心原因不是“忘了做”，而是前置条件还不够稳：

- 当前前端没有稳定、明确、已验证的 `__openclaw.id` 接入路径
- control-ui 的 DOM / websocket 消息结构虽然已有研究，但还没形成可直接依赖的插件接入契约
- 如果仓促接入，会把当前已经可用的后端回查路径重新拉回不稳定状态

### 当前影响

不影响现有功能可用性，但影响上限：

- 当前页面里的“最新消息”定位速度仍偏后端回查
- 前端不具备真正的“消息刚进来即强感知”的实时层
- 在未来前端结构变化时，当前方案更偏审计型，而不是强 UI 同步型

### 风险

如果未来推进这条线，主要风险是：

- 过度耦合 control-ui 私有实现
- 依赖 DOM 结构而不是稳定 API
- 将“快”和“准”混成同一条链路，导致回归时更难排查

### 结论

这项也是中优先级增强项。  
建议在 logger 自动导入链路更稳之后再推进，避免同时改两条高不确定性链路。

## 剩余项三：默认关闭下的日志静默回归尚未单独验证

### 当前状态

本轮排障日志已经收敛为两类开关：

- `collector.debugLogs`
- `CLAWLENS_DEBUG=1`

说明文档在：

- [CHAT_AUDIT_DEBUG_LOG_SWITCH_2026-04-02.md](../../CHAT_AUDIT_DEBUG_LOG_SWITCH_2026-04-02.md)

代码层面也已经实现：

- `collector` 侧调试日志通过开关控制
- `store` 侧调试日志通过开关控制

### 为什么还算未完成

因为我还没有专门做一轮“默认关闭时无额外 debug 日志输出”的回归验证。

当前更准确的状态是：

- 开关方案已经落地
- 但未单独做一轮“关闭状态验证”

### 当前影响

这是低风险工程项，不影响功能本身，只影响：

- 日志洁净度
- 线上默认噪音水平
- 后续维护时对“哪些日志是默认行为”的判断成本

### 结论

低优先级收尾项。  
建议在功能稳定后补一轮最小回归，而不是现在继续在主线上投入过多时间。

## 剩余项四：历史空明细 run 不会自动修复

### 当前状态

本轮修复的是“从现在开始的新 run”：

- 新 run 的 `llm_calls`
- 新 run 的 `tool_executions`
- 新 run 的 `timeline`

都已恢复。

但在修复之前已经写入数据库的那些异常 run，仍然会保留旧状态：

- transcript 有
- run 基础行有
- 但 `llm_calls/tool_executions` 为空

### 为什么不会自动恢复

原因很直接：

- 这些历史 run 的 hook 事件当时已经过去了
- 如果没有额外的补偿数据源，就无法从当前数据库内部重新构建出完整 `llm_calls/tool_executions`

理论上只有两种方式能补：

1. 从 llm-api-logger 或其他外部日志重建
2. 接受历史数据保持不完整，不做补偿

### 当前影响

影响是可见但不阻塞：

- 用户查看旧 run 时，仍会看到部分 run 只有 transcript 没有细节
- 新 run 已正常，不影响当前功能体验

### 结论

低优先级项。  
只有在用户明确要求“历史数据回补”时，才值得单独开一条补偿方案。

## 剩余项五：message 级强绑定仍未达到最终形态

### 当前状态

虽然当前消息回查已经可用，但它仍不等于完整的 message-level trace。

当前更准确的状态是：

- 已能从当前 session 最近 user turn 回查 run
- 已能通过 transcript 显式消息记录增强绑定
- 已能在当前 chat 页面中定位“当前消息最相关 run”

但仍未做到：

- 所有普通用户消息都具备稳定的 `runId` 显式绑定
- transcript 与 logger message namespace 已完全统一
- 所有派生 run 都有严格、结构化的 message 关联

### 为什么还没做

因为这已经不是当前插件的小修小补能自然完成的事，而是要继续面对这些深层问题：

- logger `message_id` 与 transcript `messageId` 是否等值
- user-entry 与 subagent/startup/cron/announce 的边界识别
- 是否需要上游 OpenClaw 明确暴露更强的 run identity

### 当前影响

不影响当前 chat audit 主能力，但限制了长期上限：

- 更复杂的并发或派生 run 场景下，仍需要更强设计
- 当前方案偏“足够可用”，尚未到“理论最强绑定”

### 结论

这是中长期增强项，不建议混进当前收尾阶段。

## 优先级建议

若后续继续推进，建议顺序如下：

1. `logger-message-mapper` 自动导入链路
2. 双层设计中的前端实时层
3. 默认关闭下的日志静默回归
4. 历史空明细 run 的补偿策略
5. message-level 强绑定的上游协同设计

## 最终结论

当前没有阻塞 Chat Audit 正常使用的未完成项。

剩余工作主要分成三类：

- 精度增强：logger 自动导入、前端实时层、message-level 强绑定
- 工程收尾：日志静默回归
- 数据补偿：历史空明细 run 修复

因此，当前状态可以认为：

- 主线问题已经关闭
- 后续工作应转入增强阶段，而不是继续视为紧急修复
