# Docs Audit Prompt

> [!IMPORTANT]
> Current Authority: This is the active master version for docs audit prompts.
>
当前主文档，用于执行 `docs/` 体系治理审计。

```md
你是一名高级代码、架构与文档治理审查员。你的任务不是简单阅读 `docs/`，而是把整个文档体系当作一个“可审计系统”来检查，确认它是否满足以下要求：

- 当前主文档是否权威、准确、可直接作为当前入口
- 历史文档是否被正确归档，没有污染顶层目录
- 每个主题是否都有清晰的主文档与对应 history 链路
- 每轮归档是否完整、可追溯、步骤明确
- README / docs / archive / history 之间是否存在断链、错链或语义冲突
- 文档链接是否完整有效，是否仍指向已移动或已归档旧路径
- 不同主题主文档之间是否存在事实口径冲突

请严格按以下步骤执行审计。

---

## 一、审计范围

必须覆盖以下范围：

1. 仓库根目录文档
   - `README.md`
   - 本提示词文件本身（如存在）
2. `docs/` 顶层全部文档
3. `docs/prompts/` 全部文档
4. `docs/archive/` 全部子目录
5. `docs/archive/history/` 全部 history 文档
6. 文档中引用的关键当前代码文件（只在需要核对技术声明时读取）

---

## 二、审计目标

本次审计必须回答以下问题：

1. 顶层 `docs/` 是否已经只保留“当前主入口文档”
2. 是否仍有应归档但未归档的带日期文档、过程稿、中间稿、旧复核稿
3. 每个主题是否实现了：
   - 一个无日期主文档
   - 一个对应主题的 history 文档
4. history 文档是否完整记录了该主题的重要历史文件
5. archive 中的文件是否被正确分类：
   - `reviews`
   - `analysis`
   - `prompts`
   - `chat-audit`
   - `history`
6. README 是否只引用当前主文档，而不是旧日期稿
7. 当前主文档中的技术内容是否与当前代码一致
8. 归档动作本身是否可追溯：
   - 能否分清每轮归档做了哪些步骤
   - 每轮归档后的结构是否被文档记录
9. 是否存在断链、错链、或仍把已归档旧稿当成当前入口的链接
10. 不同主题主文档之间是否对同一事实给出冲突口径
11. 文档命名是否符合治理规则：
   - 顶层主文档应为无日期文件
   - 带日期文档应采用 `TYPE_TOPIC[_DETAIL]_YYYY-MM-DD.md`
12. 是否仍存在本项目文件的绝对路径引用
    - 如 `/home/.../github/clawlens/...`

---

## 三、主题审计规则

对每个主题分别审计，至少覆盖以下主题：

1. Architecture
2. Chat Audit
3. Remaining Work
4. LLM API Logger Message Mapping
5. Implementation Prompt
6. Analysis Prompt Playbook
7. Engineering Lessons Playbook
8. Docs Governance

对每个主题都要检查：

### 1. 主文档审计

- 是否存在唯一的无日期主文档
- 主文档是否仍引用旧日期稿作为当前入口
- 主文档内容是否与当前代码/当前治理状态一致

### 2. History 审计

- 是否存在该主题对应的 history 文档
- history 是否列出了关键历史文件
- history 是否遗漏重要的版本化文档、旧复核稿、专项修复稿、提示词链
- history 是否错误地把当前主文档当成历史文档

### 3. Archive 完整性审计

- 该主题的旧稿是否真的进入了 archive
- archive 分类是否正确
- 是否还有旧稿散落在顶层

### 4. 跨主题一致性审计

- 该主题主文档与其他主题主文档是否对同一事实给出不同结论
- 该主题主文档是否错误引用了其他主题的历史稿作为当前依据

---

## 四、归档审计规则

你必须把“归档”本身当成一个可审计对象，而不是只看结果。

### 1. 归档完整性

检查：

- 是否存在“该归档但未归档”的文件
- 是否存在“已归档但未被任何 history 记录”的文件
- 是否存在“已归档但 archive 分类错误”的文件
- 是否存在“同一主题的历史文件分散在多个不合理目录”的情况
- 是否存在“归档后旧路径仍被 README / 主文档 / history 引用”的情况

### 2. 归档步骤可追溯性

你必须判断，是否能清楚区分每一轮归档做了什么。

至少检查：

- 是否存在治理主文档记录归档原则
- 是否存在 archive README 说明 archive 的用途和边界
- 是否存在主题级 history 说明某主题有哪些历史文件
- 是否能从现有文档中看出：
  - 第一轮归档归了什么
  - 后续继续归档又归了什么

如果不能清楚追溯，必须指出缺口：

- 缺少步骤日志
- 缺少主题 history
- 缺少归档说明
- 或缺少归档后链接修正

### 3. 归档步骤清单（审计基线）

每次归档理论上都应至少包含以下步骤。请据此审计当前体系是否满足：

1. 识别候选文件
   - 哪些文件属于当前主入口
   - 哪些文件属于历史材料
2. 做归类决策
   - `reviews` / `analysis` / `prompts` / `chat-audit` / `history`
3. 执行移动
4. 修复引用路径
   - README
   - 顶层主文档
   - archive README
   - 各主题 history
5. 更新治理文档
6. 更新对应主题的 history
7. 验证顶层是否仍有残留旧稿

如果当前体系不能反映这些步骤，也要指出来。

---

## 五、技术内容审计规则

不仅要审文档组织，还要抽查主题内容是否失真。

对以下主文档，必须对照当前代码抽查其核心技术声明是否仍然成立：

- `docs/architecture.md`
- `docs/ANALYSIS_CHAT_AUDIT.md`
- `docs/ANALYSIS_CHAT_AUDIT_ENHANCEMENTS.md`
- `docs/ANALYSIS_LLM_API_LOGGER_MESSAGE_MAPPING.md`
- `docs/PROMPT_IMPLEMENTATION.md`

必须对照的代码范围：

- `extensions/clawlens/index.ts`
- `extensions/clawlens/openclaw.plugin.json`
- `extensions/clawlens/src/collector.ts`
- `extensions/clawlens/src/store.ts`
- `extensions/clawlens/src/api-routes.ts`
- `extensions/clawlens/src/logger-import.ts`
- `extensions/clawlens/src/logger-message-mapper.ts`
- `extensions/clawlens/src/types.ts`
- `extensions/clawlens/ui/inject.js`
- `extensions/clawlens/ui/styles.css`

重点检查：

1. 文档是否把“当前已实现能力”和“未来计划能力”混淆
2. API 列表是否与当前代码一致
3. 配置项是否与 schema 一致
4. 架构主文档是否还残留已失效的旧设计假设
5. Chat Audit 主文档是否与当前 heartbeat/chat 分流逻辑一致
6. Remaining Work 是否错误地把已完成项写成未完成，或反之
7. Logger Mapping 主文档是否正确描述其“增强链而非主链”的定位

---

## 六、链接完整性与口径冲突审计

除了内容本身，还必须审计：

### 1. 链接完整性

检查：

- `README.md` 中的文档链接是否全部有效
- `docs/` 顶层主文档中的链接是否全部有效
- `docs/prompts/` 中的链接是否全部有效
- `docs/archive/README.md` 与各主题 history 中的链接是否全部有效
- 是否存在对本项目文件的绝对路径引用
- 是否存在链接仍指向：
  - 已移动旧路径
  - 已归档旧稿
  - 已不存在的文件

### 1.5 命名规则一致性

检查：

- 顶层 `docs/` 是否仍残留不应存在的带日期文档
- `docs/prompts/` 是否只保留当前分支提示词，而不是历史带日期稿
- `docs/archive/` 中的新历史文件命名是否符合：
  `TYPE_TOPIC[_DETAIL]_YYYY-MM-DD.md`
- 是否存在主题主文档和带日期快照混用、但未通过 history 说明关系的情况
- 是否仍存在项目内绝对路径，而不是仓库相对路径

### 2. 口径冲突

必须检查以下类型冲突：

- 同一能力在不同主文档里一个写“已完成”，另一个写“未完成”
- 同一 API 在不同主文档里列出不同路径或不同语义
- 同一配置项在不同主文档里写出不同 schema/默认值
- 同一架构结论在 `architecture.md` 与专题主文档中表述不一致
- 同一主题的主文档与其 history 总结相互矛盾

如果发现冲突，必须明确指出：

- 冲突双方
- 冲突事实
- 哪一份更接近当前代码
- 应如何收敛

---

## 七、README 审计规则

必须审计 `README.md` 是否满足：

1. 只引用当前主文档
2. 不再直接引用已归档的带日期稿
3. 对“current authority”标注清楚
4. 文档入口与当前目录结构一致
5. 不引用已移动或已失效路径

---

## 八、输出要求

输出必须按以下结构组织：

### 1. 总结结论

明确给出：

- 顶层文档体系是否已经收敛
- 归档是否完整
- history 体系是否完整
- 是否还存在阻塞性问题

### 2. Findings

按严重程度排序输出 findings。

每条 finding 必须包含：

- 严重级别
- 影响范围
- 证据文件路径
- 问题说明
- 建议动作

### 3. 主题级判断

对每个主题给出：

- 主文档：是否合格
- history：是否完整
- archive：是否干净

### 4. 归档步骤审计

单独回答：

- 当前是否能分清每轮归档做了哪些步骤
- 缺了哪些审计记录
- 后续若要继续归档，应补什么记录机制

### 5. 最终建议

把建议分成三类：

- 立即修复
- 可优化但不阻塞
- 长期治理建议

---

## 九、执行约束

- 不要只按文件名猜文档角色，必须结合内容和引用关系判断
- 不要把“已归档”误判为“可删除”
- 不要把“历史快照”误判为“当前主入口”
- 如果判断某主题仍存在多份主文档竞争，必须明确指出
- 如果某主题缺 history，必须明确指出
- 如果 README 与 docs 结构不一致，必须明确指出
- 如果技术内容与代码不一致，也必须指出，不能只审文档结构
```
