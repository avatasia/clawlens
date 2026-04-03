# OpenClaw Remote Debug Patch Workflow

本文件记录当前建议采用的实施路径：

- 基于本地参考代码修改
- 发布到远端运行环境验证
- 验证通过后导出 patch
- 最终在个人 OpenClaw fork 中整理提交并发起 PR

本文件只描述实施路径，不替代具体修复方案。

## 目标

为以下类型的问题提供一条可执行的实现与提交流程：

- 需要修改 OpenClaw 主链源码
- 需要在真实远端环境中验证
- 但当前 `clawlens` 仓库不应直接承载正式上游提交历史

当前典型场景：

- `stale toolResult replay pollution`

## 基本边界

当前仓库：

- `clawlens`

主要负责：

- 研究
- 方案
- 审计
- 验证记录

不负责：

- 承载 OpenClaw 正式修复提交历史

当前本地参考源码目录：

- `projects-ref/openclaw/`

定位是：

- 本地参考代码
- 实验改动目录
- 远端调试来源

不是：

- 最终 PR 的正式提交仓库

## 推荐实施顺序

### Step 1：在本地参考代码中实现最小改动

在：

- `projects-ref/openclaw/`

中完成最小可验证改动。

要求：

- 优先最小改动面
- 保留清晰改动清单
- 不在当前 `clawlens` 仓库中提交这些源码改动

### Step 2：同步到远端运行环境验证

如果远端运行的是源码形态，可直接同步源码并重启验证。

如果远端运行的是**编译部署形态**，则必须：

1. 先在本地完成构建
2. 找到对应的构建产物
3. 把编译结果同步到远端实际运行目录
4. 再重启对应运行进程验证

当前已知约束：

- 远端 OpenClaw 为编译部署形态
- 因此当前这条线不应采用“只发源码”方式验证

换句话说，本轮应采用：

- 本地改源码
- 本地 build
- 远端发构建产物
- 重启验证

补充约束：

- 对于全局安装的编译部署，不应只替换 `dist/`
- 2026-04-03 的一次验证已经证明：`dist` 单独替换会打断 bundled chat channel metadata 与 chunk 依赖关系
- 更安全的路径应是：
  - 发布完整包形态
  - 或在独立 staging 环境做完整安装验证
  - 而不是在 live 全局安装上直接做 `dist` 目录热切换

验证重点：

1. 问题是否复现收敛
2. 是否引入明显回归
3. 正常链路是否仍成立

### Step 3：记录验证结论

在当前仓库中保留：

- 研究文档
- 实施方案
- 审计结果
- 验证结果

但不要把 OpenClaw 正式源码改动提交到当前仓库。

### Step 4：导出 patch 或迁移改动

当远端验证通过后，应把改动整理为：

- 一份明确 patch
  或
- 一组可在正式 fork 中重放的变更

### Step 5：在个人 OpenClaw fork 中正式落地

正式代码提交应发生在：

- 你自己的 OpenClaw fork

建议流程：

1. fork 官方 OpenClaw
2. clone 自己的 fork
3. 新建修复分支
4. 应用已验证改动
5. 再跑一遍验证
6. 提交并发起 PR

## 为什么采用这条路径

这样做的好处是：

1. 当前仓库仍保持职责清晰
   - 研究与方案留在 `clawlens`
   - 上游正式代码历史留在 OpenClaw fork
2. 可以先在真实环境快速验证
3. 不会把参考目录误当成正式上游仓库
4. patch 更容易审查与搬运

## 当前适用范围

这条工作流适用于：

- OpenClaw 上游行为研究后的修复试点
- 需要真实环境验证的主链逻辑修复
- 不适合直接在插件层规避的问题

## 相关信息来源

- [IMPLEMENTATION_OPENCLAW_PR_WORKFLOW_2026-04-03.md](IMPLEMENTATION_OPENCLAW_PR_WORKFLOW_2026-04-03.md)
- [ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](ANALYSIS_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
- [IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md](IMPLEMENTATION_OPENCLAW_STALE_TOOL_RESULT_REPLAY_MITIGATION_REVISED_2026-04-03.md)
