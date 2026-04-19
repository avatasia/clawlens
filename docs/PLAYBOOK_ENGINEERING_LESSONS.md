# Engineering Lessons Playbook

> [!IMPORTANT]
> Current Authority: This is the active master version for engineering lessons and reusable practices.
>
当前主文档，汇总本仓库沉淀出的通用工程经验。

核心原则：

1. 先画时序，再写归属逻辑
2. 永远做三方对账：源数据 / 存储 / 接口与前端
3. 前端问题先分层：数据层、状态层、渲染层
4. 宿主页面注入优先依赖稳定骨架，不依赖模糊类名
5. 研究结论进入实施前，必须补工程约束
6. 调试能力要产品化，而不是临时插桩
7. 受控执行器中的后台任务要委托给宿主调度器，而不是依赖 `nohup`

## 受控执行器中的后台任务

在受控命令执行环境中，`nohup ... &` 只能避免会话挂断带来的 `SIGHUP`，不能保证后台子进程在工具调用结束后继续存活。若执行器会在调用结束时主动回收子进程或进程组，则这类“后台任务”会被提前清理。

实用规则：

- 一次性延时任务，优先委托给宿主环境自己的调度器，例如 `tmux run-shell -b`
- 周期性任务，优先使用 `cron`、`systemd` timer 等独立调度机制
- 需要向 `tmux` session 发送输入时，优先在触发时动态解析当前活动 pane，而不是绑定历史 pane 编号

在本仓库当前环境下，给 `tmux` session 做一次性延时发送时，`tmux run-shell -b "sleep N; tmux send-keys ..."` 比从 Codex 进程里直接 `nohup sleep N && tmux send-keys ... &` 更可靠

详细展开见历史记录：

- [ENGINEERING_LESSONS_PLAYBOOK_2026-04-03.md](archive/analysis/ENGINEERING_LESSONS_PLAYBOOK_2026-04-03.md)
