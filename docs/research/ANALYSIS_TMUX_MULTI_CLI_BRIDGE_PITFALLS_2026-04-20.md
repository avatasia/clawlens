# Tmux Multi-CLI Bridge Pitfalls

本文总结本轮在 `tmux` 驱动的多 CLI 协作链路里实际踩过的坑，覆盖：

- `scripts/gemini-tmux-control.mjs`
- `scripts/codex-tmux-control.mjs`
- `scripts/claude-tmux-control.mjs`
- `scripts/gemini-codex-dialogue.mjs`
- `scripts/claude-codex-dialogue.mjs`
- `scripts/tmux-session-lock.mjs`

目标不是写泛泛经验，而是记录已经出现过的真实故障模式、触发条件和当前处理办法。

## 1. 用“消息锚点”抽回复非常脆弱

最早的思路是：

1. 发送消息
2. 从 pane buffer 里找这条消息的前 60 到 80 个字符
3. 把它后面的内容当作新回复

这个方案实际会在三种情况下失效：

- 发送文本被终端换行，buffer 中根本不存在单行完整锚点
- 模型把用户问题复述一遍，锚点出现多次
- TUI 给输入行加前缀、边框或装饰，原始消息和 pane 展示文本不再同形

当前修正：

- Gemini 侧改成“输入 block -> 回复 block”提取，而不是单行 anchor
- Codex 侧同样支持 wrapped input block
- 两边都保留 baseline fingerprint fallback，找不到输入 block 时用发送前 pane 的尾部指纹定位分割点

结论：

不要把“用户消息的一段 substring 一定能在 pane 里原样出现”当作前提。

## 2. 只按单行前缀识别输入 block 也不够

即便从“单行 anchor”升级到“输入 block”，也踩过一个坑：

- 不能假设输入永远只占一行
- 也不能假设 continuation line 的缩进、分隔符、装饰线永远固定

这直接导致长消息在 Gemini / Codex pane 里被折行后，提取逻辑仍然会错过真正的输入边界。

当前修正：

- Gemini 侧识别 ` > ` 起始行，再向下吸收 continuation lines，直到遇到分隔线或回复前缀
- Codex 侧识别 `›` 起始输入块，再向下吸收 continuation lines，直到遇到回复、下一条输入、footer 或 divider

结论：

“输入块”应该按结构识别，不应该按单行匹配。

## 3. 忙闲状态不是统一协议

Claude、Codex、Gemini 三个 TUI 的忙闲信号完全不一样：

- Claude 常见的是 `❯` prompt，以及工作中的 spinner / `Esc to interrupt`
- Codex 常见的是 `• Working` 和 footer 里的 `·`
- Gemini 常见的是 `Thinking...`、`Defining the Task's Constraints`、`Considering Command Execution`，空闲时是 `Type your message or @path/to/file`

因此“写一个通用的 isIdle/isBusy regex”这条路不成立。

当前修正：

- 控制脚本按产品分别实现忙闲判定
- Gemini 额外加入 stable content polling，不再只靠固定字符串判 idle

结论：

忙闲检测必须按 CLI 定制，而且要接受 UI 文案未来还会继续变。

## 4. 只靠静态 regex 判 ready，容易误判

实际出现过两个问题：

- 某些状态文案会更新，旧 regex 直接失效
- “ready prompt” 文本本身有可能被模型输出引用，导致误判为已空闲

当前修正：

- Gemini 侧增加“连续多轮捕获完全一致”作为稳定性条件
- 正则只作为提示，不再是唯一结束条件

结论：

ready 判定更像“界面状态稳定”而不是“命中某句文案”。

## 5. 并发 send 会把同一 pane 打穿

这是本轮最明确的一次真实事故。

当两条消息几乎同时发往同一个 `tmux` session 时，输入内容会直接拼接在一起。真实出现过的 pane 文本是：

`... what would it beReply with exactly HEALTH_OK`

随后 Gemini 只回了：

`HEALTH_OK`

这说明不是提取逻辑错了，而是 pane 输入阶段已经互相污染。

当前修正：

- 新增 `scripts/tmux-session-lock.mjs`
- `gemini` / `codex` / `claude` 控制脚本的 `send` 都走 session 级串行锁
- `gemini-codex-dialogue.mjs` 的 `/clear` 也走同一把锁

结论：

只要底层还是 `tmux send-keys`，同一 session 的所有交互都必须串行化。

## 6. `/clear` 不是总能执行

Codex 侧观察到一个很具体的限制：

- 任务进行中时，`/clear` 会被拒绝

如果 dialogue runner 把“清上下文”当作刚性前提，整条链路会直接卡住。

当前修正：

- `clearSession("codex", ...)` 采用 best-effort
- 如果遇到 `'/clear' is disabled while a task is in progress`，就跳过清理并继续

结论：

上下文清理要分 CLI 区分对待，不能假设所有工具都支持即时重置。

## 7. 操作员上下文会污染自动对话

早期直接拿现有 `gemini1` / `codex` 会话跑桥接，遇到过一个非技术性但非常真实的问题：

- pane 里残留了之前的人类对话和试验命令
- 自动对话会在旧上下文上继续生长
- 即便提取成功，内容也会被旧指令语义污染

当前处理：

- dialogue runner 支持 `--clear-first`
- 在不能安全 clear 的地方，至少保留 checkpoint 和日志，避免“既没清干净又丢现场”

结论：

用于桥接的 session 最好和操作者交互 session 分离；否则要把“上下文污染”当成默认风险。

## 8. 只有重试，没有恢复，仍然会丢整轮进度

重试能解决瞬时超时，但不能解决：

- 进程中断
- provider 限流
- 运行中人工终止

在没有恢复点时，一旦中途失败，前面已完成的 turn 也只能靠滚动日志回忆。

当前修正：

- `gemini-codex-dialogue.mjs` 加入 checkpoint
- 每轮持久化 `currentRole`、`currentMessage`、history、health、状态
- 支持 `--resume-from`

结论：

“多轮对话”本质上是长事务，没有 checkpoint 的话可靠性是不完整的。

## 9. JSON 默认回传整段 pane，体积太大

控制脚本一开始把 `baseline` 和 `output` 全都塞进 `send --json`。

这带来三个问题：

- 日志和调试输出非常吵
- 多轮对话时 stdout 体积暴涨
- 调用方如果只是想拿提取结果，也被迫处理巨大的 pane 快照

当前修正：

- `gemini` / `codex` / `claude` 控制脚本默认输出精简 JSON
- 只有显式带 `--include-pane-text` 时才返回原始 pane
- dialogue runner 只在确实需要 raw pane 的路径上打开这个开关

结论：

原始 pane 快照应该是调试级数据，不应该是默认 API 负载。

## 10. 没有可见进度时，看起来像“死了”

等待 TUI 回复时，如果中间完全静默，操作者无法判断是：

- 正常等待
- 卡在某个 poll
- `send` 子进程挂住
- provider 本身极慢

当前修正：

- `gemini-codex-dialogue.mjs` 在等待 `send` 子进程时输出进度
- 非 TTY 环境下退化成 `[wait role attempt/retries Ns]`

结论：

桥接脚本至少要告诉操作者“现在在等谁”和“已经等了多久”。

## 11. 只看单轮日志，不足以判断整段对话健康度

早期日志只能看到每轮提取结果，但无法快速回答：

- 整段桥接是否大体稳定
- 有多少轮走了 fallback
- 是否已经开始频繁 fray

当前修正：

- 每轮计算 `THREAD_STABLE` / `THREAD_STRETCHED` / `THREAD_FRAYED`
- checkpoint history 持久化 `health`
- dialogue 结束时打印 summary

结论：

如果桥接是长跑，不应该只给操作者单圈成绩，还要给整段健康汇总。

## 12. 额度耗尽不是普通失败

在 Claude 侧还遇到过一个和对话桥接不同、但同样关键的 operational pitfall：

- session 进入额度限制后，不是“再试一次”就能恢复
- 必须先发 `continue`，再根据 reset 时间做定时激活

当前处理：

- 通过 `scripts/schedule-tmux-continue-on-reset.mjs` 在 reset 之后自动补发 `continue`

结论：

限额恢复应该进入 SOP，但必须作为条件分支，而不是对所有 session 默认注入 `continue`。

## 当前最重要的经验

如果继续扩这套桥接，优先级应该是：

1. 把 pane 交互看成“结构化但不稳定”的 UI，而不是稳定文本协议
2. 把同一 session 的所有输入看成必须串行的临界区
3. 把多轮对话看成长事务，默认需要 checkpoint 和 health
4. 把原始 pane 快照视为调试数据，而不是默认接口返回

这四条如果不先站稳，后面加再多功能，链路都还是脆的。
