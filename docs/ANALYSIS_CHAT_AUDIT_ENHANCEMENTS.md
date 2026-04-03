# Chat Audit Long-Term Enhancements

> [!IMPORTANT]
> Current Authority: This is the active master version for Chat Audit long-term enhancements.
>
> 当前主文档，记录 Chat Audit 在主链收口之后仍值得继续推进的长期增强方向。

## 使用方式

本文件不重复展开：

- 当前架构细节
- 已完成实现项
- 归档阶段记录

这些内容请看：

- [ANALYSIS_CHAT_AUDIT.md](ANALYSIS_CHAT_AUDIT.md)
- [architecture.md](architecture.md)
- [CHAT_AUDIT_HISTORY.md](archive/history/CHAT_AUDIT_HISTORY.md)
- [CHAT_AUDIT_REMAINING_WORK_HISTORY.md](archive/history/CHAT_AUDIT_REMAINING_WORK_HISTORY.md)

## 长期增强方向

### 1. Message-level 强绑定继续增强

后续增强方向包括：

- 更稳定地利用上游消息标识
- 继续降低 `sessionKey + 时序` 近似归属的占比
- 在不引入外部运行时硬依赖的前提下，提升 message/run 绑定确定性

相关信息来源：

- [ANALYSIS_CHAT_AUDIT.md](ANALYSIS_CHAT_AUDIT.md)
- [ANALYSIS_LLM_API_LOGGER_MESSAGE_MAPPING.md](ANALYSIS_LLM_API_LOGGER_MESSAGE_MAPPING.md)
- [CHAT_AUDIT_ENHANCEMENTS_HISTORY.md](archive/history/CHAT_AUDIT_ENHANCEMENTS_HISTORY.md)

### 2. 前端交互体验持续优化

- hover / click / refresh 的手感
- 更细粒度的局部更新
- 进一步降低非必要重绘

相关信息来源：

- [ANALYSIS_CHAT_AUDIT.md](ANALYSIS_CHAT_AUDIT.md)
- [architecture.md](architecture.md)
- [CHAT_AUDIT_HISTORY.md](archive/history/CHAT_AUDIT_HISTORY.md)

### 3. 历史元数据补强继续扩展

后续若继续推进，应继续坚持这条原则：

- 只做有限、证据充分的元数据补强
- 不做高风险的全量历史重建

相关信息来源：

- [architecture.md](architecture.md)
- [CHAT_AUDIT_REMAINING_WORK_HISTORY.md](archive/history/CHAT_AUDIT_REMAINING_WORK_HISTORY.md)
- [CHAT_AUDIT_HISTORY.md](archive/history/CHAT_AUDIT_HISTORY.md)
