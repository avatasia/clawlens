# OpenClaw PR Workflow

本文件记录后续若要把 `stale toolResult replay mitigation` 正式提交给 OpenClaw 官方时，建议采用的工作流。

本文件不描述具体修复逻辑，只描述提交流程与边界。

## 基本原则

当前仓库：

- `clawlens`

作用是：

- 保存研究
- 保存方案
- 保存审计与验证记录

不是：

- OpenClaw 上游源码的正式提交仓库

因此，如果后续要把方案正式贡献给 OpenClaw，应在 OpenClaw 自己的仓库链上完成实现与提交。

## 推荐流程

### Step 1：Fork 官方 OpenClaw 仓库

在 GitHub 上 fork 一份官方 OpenClaw 仓库到你自己的账号。

### Step 2：本地 clone 你的 fork

单独 clone 该 fork，作为正式开发目录。

不要直接把：

- `projects-ref/openclaw/`

当成长期正式开发仓库。

它更适合作为：

- 本地参考源码
- 快速验证副本

### Step 3：创建专用分支

建议使用清晰分支名，例如：

- `fix/stale-tool-result-replay`
- `fix/replay-diagnostic-toolresult-expire`

### Step 4：按照当前方案实现

以当前主方案为准：

- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)

重点是：

- 在 OpenClaw 主链实现
- 不把插件侧临时绕行当正式修复

### Step 5：在 fork 内完成验证

至少验证：

1. 旧诊断型 `toolResult` 不再持续污染后续回答
2. 当前轮失败或空结果不会被旧成功结果语义覆盖
3. 正常多轮任务不出现明显回退
4. provider 协议未被破坏

### Step 6：整理 PR 说明

PR 说明应明确：

- 问题根因
- 为什么不是跨渠道读取
- 为什么不能依赖模型自己按时间判断
- 为什么采用 `Tag & Expire`
- 本轮明确不做哪些事

### Step 7：向官方仓库提 PR

把 fork 中的修复分支向官方 OpenClaw 仓库发起 PR。

## 当前仓库应保留什么

`clawlens` 仓库中建议保留：

- 研究文档
- 主方案文档
- 审计提示词
- PR 工作流说明

不建议在本仓库里长期承载：

- OpenClaw 正式修复代码提交

## 相关信息来源

- [RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md](./RESEARCH_OPENCLAW_SESSION_HISTORY_REPLAY_POLLUTION_2026-04-03.md)
- [RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md](./RESEARCH_OPENCLAW_TOOL_RESULT_TIMESTAMP_AND_REPLAY_2026-04-03.md)
- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
