---
status: active
created: 2026-04-03
updated: 2026-04-14
---

# Docs Governance Plan

> [!IMPORTANT]
> Current Authority: This is the active master version for docs governance rules.
>
当前主文档，描述 `docs/` 目录的治理规则。

当前规则：

- 顶层 `docs/` 只保留当前主入口文档
- `docs/prompts/` 用于存放当前活跃的提示词分支文档
- `docs/plans/` 用于存放当前仍在讨论、待决或待实施的方案文档
- `docs/research/` 用于存放当前仍有参考价值的研究型文档
- 带日期的过程稿、研究稿、旧复核稿原则上不留在顶层
- 历史材料统一进入 `docs/archive/`
- 每个主题在顶层尽量只保留一个无日期主文档

## History 体系

`docs/archive/history/` 是主题历史索引的法定入口。

规则如下：

1. 每个重要主题应有对应的 `*_HISTORY.md`。
2. 只要某份主题文档被归档，就必须同步登记到对应主题的 history。
3. 仅把文件移动到 `docs/archive/` 而不更新 history，视为不完整归档。
4. 如果某份归档材料跨多个主题都有关联，应在主归属主题的 history 中登记，并在其他主题文档中做交叉引用说明。

## Archive 分类职责

`docs/archive/` 下的子目录按职责分工：

- `reviews/`
  架构复核、合规复核、旧审查稿。
- `analysis/`
  研究稿、分析稿、原始记录、中间稿、postmortem、rectification。
- `prompts/`
  历史 AI 提示词、修订提示词链、旧实现提示词。
- `chat-audit/`
  Chat Audit 专项修复记录、阶段性修复稿、专项排障稿。
- `history/`
  各主题历史索引，不存放普通过程稿。

分类原则：

1. 优先按业务主题和长期检索习惯归类，不按临时文件名随意投递。
2. 如果某主题已经有专门分类目录，相关归档材料优先放入该主题目录。
3. 若无法判断主题归属，才放入更通用的 `analysis/`。

## 子目录 README 覆盖规则

以下子目录必须维护 `README.md`，且 README 必须双向覆盖目录下所有 `.md` 文件：

- `docs/plans/`
- `docs/research/`
- `docs/prompts/`
- `docs/archive/history/`

双向覆盖含义：

1. 正向：目录内每个 `.md` 文件（不含 `README.md`）都被 README 链接。
2. 反向：README 中链接的每个文件都实际存在。

`docs/archive/` 下的其他子目录（`analysis/`、`chat-audit/`、`reviews/`、`prompts/`）不强制要求 README 覆盖。这些目录以批量归档为主，文件通过主题 history 索引检索，不依赖目录级 README。

## `docs/prompts/` 目录职责

`docs/prompts/` 用于存放**当前仍在使用的提示词分支文档**。

规则如下：

1. 顶层主索引仍放在 `docs/` 顶层，例如：
   `PLAYBOOK_ANALYSIS_PROMPT.md`
2. `docs/prompts/` 只放当前活跃的分支提示词，不放历史提示词。
3. 历史提示词、旧提示词链、带日期的提示词快照，应进入：
   `docs/archive/prompts/`
4. 若某分支提示词不再是当前活跃内容，应归档并在对应 history 中登记。

## `docs/plans/` 目录职责

`docs/plans/` 用于存放**当前仍在讨论、待决或待实施**的方案文档。

规则如下：

1. 该目录中的文件不属于历史归档，不应直接移入 `docs/archive/` 前视为“已完成”。
2. 若某方案已定稿并成为当前规则或当前主方案，应提升为 `docs/` 顶层主文档，或并入现有主文档。
3. 若某方案已失活、已被吸收或已完成其阶段性作用，应归档到 `docs/archive/` 并更新对应 history。
4. `docs/plans/` 适合放带日期的待决分析稿、迁移方案、协作方案等，不适合存放长期权威文档。

## `docs/research/` 目录职责

`docs/research/` 用于存放**当前仍有参考价值的研究型文档**。

规则如下：

1. 该目录中的文档不是当前权威主文档，也不是当前待决实施方案。
2. 若研究稿仍对后续增强、排障或上游机制理解有现实参考价值，可保留在此目录。
3. 若研究结论已完全被主文档吸收，且后续不再需要直接阅读，应归档到 `docs/archive/analysis/`。
4. 若研究稿转化为当前待实施方案，应移动到 `docs/plans/` 或并入现有主文档。

## 文件命名规则

新建带日期文档时，统一采用：

`TYPE_TOPIC[_DETAIL]_YYYY-MM-DD.md`

其中：

- `TYPE`：文档类型，必须放在最前面
- `TOPIC`：主题
- `DETAIL`：可选，表示更细的范围
- `YYYY-MM-DD`：日期

### 类型前缀

当前统一使用以下首单词：

- `ANALYSIS`：分析文档
- `RESEARCH`：研究文档
- `IMPLEMENTATION`：实施方案
- `PROMPT`：提示词
- `REVIEW`：审查 / 复核
- `FIX`：缺陷修复
- `CHANGELOG`：变更记录
- `POSTMORTEM`：事后复盘
- `GOVERNANCE`：治理规则
- `PLAYBOOK`：方法论文档 / 操作手册
- `HISTORY`：历史索引

### 命名示例

- `ANALYSIS_CHAT_AUDIT_2026-04-02.md`
- `RESEARCH_LLM_API_LOGGER_MESSAGE_MAPPING_2026-04-02.md`
- `IMPLEMENTATION_CHAT_AUDIT_REMAINING_WORK_2026-04-02.md`
- `PROMPT_DOCS_AUDIT_2026-04-03.md`
- `FIX_CHAT_AUDIT_DETAIL_CAPTURE_2026-04-02.md`

## 顶层与归档规则

1. 无日期文件只保留给当前主文档。
2. 带日期文件默认视为快照、过程稿或历史材料。
3. 带日期文件完成其阶段性作用后，应进入 `docs/archive/` 或写入对应 `history`。
4. 若某主题已有无日期主文档，不再把新的带日期稿长期保留在顶层。

## 文档生命周期元数据

适用范围：`docs/` 顶层无日期主文档、`docs/plans/` 方案文档。

上述范围内**新建**的文档必须在文件开头加 YAML frontmatter。本规则生效前已存在的文档不强制补填，但鼓励在下次实质修改时补上。带日期的过程稿、研究快照、`docs/prompts/` 提示词文档不要求 frontmatter。

```yaml
---
status: active
created: 2026-01-15
updated: 2026-04-01
---
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `status` | 是 | `active` / `deprecated` / `merged` |
| `superseded_by` | 仅 deprecated/merged 时 | 替代文档的仓库相对路径 |
| `created` | 推荐 | 初始创建日期 |
| `updated` | 推荐 | 最近一次实质更新日期 |

### 状态定义

| 状态 | 含义 | 行为 |
|------|------|------|
| `active` | 当前有效，正常使用 | 正常引用 |
| `deprecated` | 已废弃但未删除 | 仍可阅读；若有 `DOC_INDEX` / `ROLLBACK_INDEX` 指向该文档，治理脚本应报警 |
| `merged` | 内容已合并到其他文档 | `superseded_by` 指向目标文档；同上报警规则 |

### 规则

1. 适用范围内新建的文档必须填写 frontmatter。已有文档不强制补填，鼓励在下次实质修改时补上。
2. 归档前，先将 `status` 标为 `deprecated` 或 `merged` 并填写 `superseded_by`（如适用），再执行归档 SOP。
3. `deprecated`/`merged` 状态的文档若仍有代码端 `DOC_INDEX` / `ROLLBACK_INDEX` 指向它，视为治理缺陷。
4. 带日期的过程稿、研究快照不要求 frontmatter。

### 自动化推进

治理脚本对 frontmatter 的检查分两阶段：

1. **当前阶段**：仅对适用范围内新增文件（未出现在 main 分支的文件）检查 frontmatter 存在性，缺失时 warn。
2. **后续阶段**：存量文档补填完成后，切换为对所有适用范围文件做 warn（或 `--strict` 下 fail）。

## 路径引用规则

1. 文档中**绝对不要使用本项目文件的绝对路径**。
2. 本规则适用于仓库内文件与目录，例如：
   - `docs/...`
   - `extensions/clawlens/...`
   - `projects-ref/...`
3. 文档中的项目内引用应统一使用仓库相对路径。
4. 如果引用的是外部运行环境、系统路径、运行库路径，且与当前仓库的 `home` 目录无关，可以按需要保留。
5. 归档、重命名、重构目录后，必须同步检查并修复旧的项目内绝对路径引用。

## Doc-Code 双向索引规则

适用范围：策略开关、回退点、复杂绑定逻辑等高风险代码路径。

代码端必须使用：

- `DOC_INDEX: <ID> -> <repo-relative-doc-path>`
- `ROLLBACK_INDEX: <ID> -> <repo-relative-doc-path>`

文档端必须使用：

- `CODE_INDEX: <ID>`
- `files:`（至少 1 个仓库相对路径）

推荐项（弱校验，不阻断）：

- `entry_points:`（关键函数名；脚本会做 warn 级别存在性提示）

推荐项（纯约定，不做自动检查，不影响 CI）：

- 代码端标记旁加一行 `// Why:` 说明该代码路径存在的原因，降低接手成本。
  这是人工约定，治理脚本不会检查其存在性或格式。

```ts
// DOC_INDEX: CLAWLENS_TRANSCRIPT_BINDING_PLAYBOOK -> docs/CLAWLENS_TRANSCRIPT_BINDING_ROLLBACK_PLAYBOOK.md
// Why: 处理 session 中途断开后的 unknown runId 恢复
```

规则：

1. `ID` 使用 `UPPER_SNAKE_CASE`，全仓库唯一。
2. 同一 `ID` 可在多个代码文件出现，但必须指向同一文档路径。
3. 每个代码端 `ID` 必须在目标文档中存在同名 `CODE_INDEX`。
4. 每个文档端 `CODE_INDEX` 必须在代码中至少有一个匹配锚点。
5. 发生文件移动或重命名时，必须同步修复 `-> path` 与 `files:`。

自动检查由 `scripts/check-docs-governance.mjs` 执行。默认模式给出警告；`--strict` 模式对不一致项直接失败。

## 归档 SOP

每次归档至少执行以下步骤：

1. 识别候选文件
   区分当前主入口文档与历史材料。
2. 更新生命周期元数据
   若候选文件有 frontmatter，将 `status` 设为 `deprecated` 或 `merged`，并填写 `superseded_by`（如适用）。
3. 选择 archive 分类
   在 `reviews`、`analysis`、`prompts`、`chat-audit` 中确定目标目录。
4. 执行文件移动
   将历史材料移入 `docs/archive/` 对应目录。
5. 修复引用路径
   包括顶层主文档、`README.md`、`docs/archive/README.md`、其他索引文档。
6. 更新主题 history
   在对应 `docs/archive/history/*_HISTORY.md` 中登记被归档文件。
7. 验证顶层收敛
   确认 `docs/` 顶层是否仍残留不应存在的带日期旧稿。

推荐规则：

- 归档动作应尽量原子化。
- 文件移动、链接修复、history 更新，三者应在同一轮提交中完成。

## 归档后复核

每轮归档完成后，必须做一次最小复核。

至少检查：

1. 当前主入口索引是否已切换到新位置。
2. 对应主题 `history` 是否已登记本轮归档。
3. 是否仍存在断链、错链或旧路径残留。
4. 顶层当前目录是否仍残留应归档旧稿。
5. 是否引入新的项目内绝对路径。
6. 被归档文件的 frontmatter `status` 是否已标为 `deprecated` 或 `merged`；若有 `superseded_by`，目标路径是否有效。
7. 是否仍有代码端 `DOC_INDEX` / `ROLLBACK_INDEX` 指向已归档文件的旧路径。

如果上述任一项未通过，本轮归档不应视为完成。

历史日期版：

- [DOCS_GOVERNANCE_PLAN_2026-04-03.md](archive/analysis/DOCS_GOVERNANCE_PLAN_2026-04-03.md)
