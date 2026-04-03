# Review Prompt: OpenClaw Stale Tool Result Replay

```md
你是一名高级架构与实现审查员。请对以下两份文档进行严格审查，目标不是复述内容，而是识别：

- 是否仍有关键事实判断错误
- 方案是否把“当前轮结果”和“历史 replay 结果”混淆
- 是否错误假设模型能直接看到 `timestamp`
- 过滤策略是否会误伤正常多轮任务链
- 是否遗漏了 replay 与 compaction 的差异
- 是否存在不可执行、过度设计或回退路径不清的问题

被审查文档：

- `docs/research/RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md`
- `docs/plans/IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md`

必须对照的代码信源：

- `projects-ref/openclaw/src/agents/bash-tools.exec.ts`
- `projects-ref/openclaw/src/agents/tools/common.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-subscribe.tools.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-subscribe.handlers.tools.ts`
- `projects-ref/openclaw/src/agents/openai-ws-message-conversion.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/google.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/compact.ts`
- `projects-ref/openclaw/src/gateway/session-utils.fs.ts`

同时对照已有研究与方案：

- `docs/research/RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md`
- `docs/archive/analysis/ANALYSIS_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md`
- `docs/archive/analysis/IMPLEMENTATION_OPENCLAW_TOOL_RESULT_REPLAY_FILTERING_2026-04-03.md`

审查重点：

1. 研究文档是否准确描述了：
   - `toolResult` 有 timestamp
   - 但当前 provider payload 不携带 timestamp
2. 方案文档是否明确区分：
   - 当前轮工具结果
   - 历史 replay 结果
3. 方案是否错误地把“空结果”当作“应回退到旧结果”
4. 过滤对象是否被正确定义为：
   - 旧的
   - 诊断型 / 环境型
   - replay 阶段的 `toolResult`
5. 方案是否过早扩展到 compaction，还是保持了最小试点
6. 验证标准是否足够判断误伤正常多轮任务
7. 是否遗漏了回退机制和观察指标

输出要求：

- 先给 findings，按严重程度排序
- 每条 finding 必须带文件引用
- 如果没有阻塞性问题，明确写：
  `未发现阻塞性问题`
- 即使没有阻塞性问题，也要指出剩余风险和验证缺口
- 不要泛泛而谈，不要只做总结
```
