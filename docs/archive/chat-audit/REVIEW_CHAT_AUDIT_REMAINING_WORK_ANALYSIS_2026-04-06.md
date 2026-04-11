# Chat Audit Remaining Work Analysis Review

## 范围

本文件复核：

- `docs/archive/chat-audit/CHAT_AUDIT_REMAINING_WORK_ANALYSIS_2026-04-02.md`

目标不是重复总结原文，而是核对其中对“剩余工作”的判断是否与当前代码状态一致。

## 复核结论

原文存在 1 项严重错误和 3 项能力遗漏 / 描述偏差。

其中最严重的问题是：把已经实现并已注册触发入口的 logger import 链路误判为“尚未接入”。

## F1：把已完成的 logger import 手动触发链路写成未完成

原文在“剩余项一：llm-api-logger 自动导入链路未接入”中声称：

- 已有解析逻辑
- 但还没有真正接进插件启动流程、周期性导入流程、手动触发导入命令

代码复核结果与此不一致：

- `extensions/clawlens/src/logger-import.ts` 已实现 `importLoggerMappings()`，包含：
  - 基于 `mtime/size` 的幂等跳过
  - 文件大小上限保护
  - 基于 `basename + resolve` 的路径遍历防护
  - `messageId` 映射与 session preview 映射的双路径写入
- `extensions/clawlens/src/api-routes.ts` 已注册 `POST /audit/logger/import`
- `extensions/clawlens/src/api-routes.ts` 已注册 `GET /audit/logger/status`
- `POST /audit/logger/import` 已支持：
  - `file` 参数
  - `force=1`
  - 413 文件过大错误
  - 400 一般导入错误

结论：

- “手动触发的导入命令未接入”这一判断不成立
- 原文“为什么还没做”“当前影响”“风险”“结论”几段都建立在错误前提上

需要说明的是：

- 本结论仅证明“手动触发链路已实现并已注册”
- 不自动推出“启动自动导入”和“周期性导入”也都已经完整落地

因此，对原文最稳妥的修订方式应是：

- 删除“尚未接入任何触发链路”的表述
- 将剩余问题收窄为“自动触发策略是否全部接齐、真实环境命中率是否已验证”

## F2：调试开关并非两类，而是三类

原文在“剩余项三”中写到：

- 本轮排障日志已经收敛为两类开关：
  - `collector.debugLogs`
  - `CLAWLENS_DEBUG=1`

前端代码显示还有独立的 UI 调试开关：

- `extensions/clawlens/ui/inject.js` 中 `isDebugEnabled()` 会额外检查：
  - `window.__CLAWLENS_DEBUG__ === true`
  - `localStorage["clawlens.debug"]`
  - `localStorage["clawlens.audit.debug"]`

这组开关控制的是前端 `console.log` 输出，包括：

- SSE 事件调试
- pagination 状态
- run 展开相关日志

结论：

- “已经收敛为两类开关”的说法不准确
- 至少应补充说明：前端侧仍存在独立调试入口，不受 `CLAWLENS_DEBUG` 或 `collector.debugLogs` 统一控制

## F3：遗漏 heartbeat/chat run 分类已实现

原文“当前已完成基线”未提到 run kind 分类与 heartbeat 过滤。

代码复核结果：

- `extensions/clawlens/src/collector.ts` 中 `classifyPromptRunKind()` 已实现 heartbeat/chat 分类
- `extensions/clawlens/src/store.ts` 已持久化 `run_kind`
- `extensions/clawlens/src/store.ts` 的 `getCurrentMessageRun()` 已显式排除 `heartbeat`

这意味着当前“最近用户消息 -> run”回查，不是简单按 session 粗暴回查，而是已经做了 heartbeat run 排除。

结论：

- 原文对 message 级回查精度的评估偏保守
- 至少应补充：heartbeat/chat 分流已经是现有精度保障的一部分

## F4：遗漏来源优先级框架已落地

原文“剩余项五”把 message-level 强绑定描述为尚未形成完整来源升级逻辑。

代码复核结果：

- `extensions/clawlens/src/store.ts` 已定义：
  - `transcript_explicit: 3`
  - `llm_prompt_metadata: 2`
  - `session_fallback: 1`
- `extensions/clawlens/src/store.ts` 的 `applyLoggerSessionPreviewMapping()` 已按优先级阻止低优先级覆盖高优先级

结论：

- 多来源升级与防降级并不是纯设计阶段
- 已有可工作的优先级框架
- 更准确的表述应是：最终强绑定尚未完成，但核心来源优先级机制已经落地

## 综合判断

对原文各剩余项的复核如下：

- 剩余项一：判断错误，至少“手动触发导入链路未接入”这一结论必须撤回
- 剩余项二：前端实时层未完全落地，这一判断仍成立
- 剩余项三：调试开关描述不完整，遗漏前端独立调试入口
- 剩余项四：历史空明细不会自动修复，这一判断仍成立
- 剩余项五：方向判断基本成立，但对当前已实现能力描述偏保守

## 建议修订方向

如果后续要修正文档，建议至少做以下调整：

1. 重写“剩余项一”的当前状态与结论，避免继续把已实现 API 写成未完成。
2. 在调试开关章节补充前端独立开关说明。
3. 在“当前已完成基线”或“剩余项五”中补充：
   - heartbeat/chat 分类与 heartbeat 过滤
   - source priority 已实现
4. 将“尚未实现”与“已实现但尚未完成自动化闭环/上线验证”明确区分。

## 附注

后续规范命名的主文档 `docs/archive/chat-audit/ANALYSIS_CHAT_AUDIT_REMAINING_WORK_2026-04-03.md` 已吸收其中一部分更正，尤其是 logger import 已实现并完成真实命中验证这一点。  
本复核文件的价值主要在于：

- 为 `2026-04-02` 旧分析稿建立明确的偏差记录
- 补齐该旧稿未显式承认的现有能力边界
