# Chat Audit 增量加载与渲染修复计划

日期：2026-04-02

## 背景

当前 Chat 页面右侧 `ClawLens Audit` 已暴露出两类问题：

1. `heartbeat` 这类友好会话名与审计侧真实 `session_key` 不一致。
2. `/audit/session/...` 一次返回过多 run，响应可达数 MB，导致：
   - 前端首屏解析慢
   - 轮询和首屏加载互相打架
   - 界面长时间停在 `Loading…`

此外，前端静态资源存在浏览器缓存问题，导致：

- 页面刷新后仍可能执行旧版 `inject.js`
- 首屏请求形态与当前代码预期不一致

## 当前已确认事实

### 1. 会话名映射

- Chat UI 当前可见会话名可能是 `heartbeat`
- ClawLens 实际审计数据更多落在 `agent:main:main`
- `unknown` 里也有大量纯生命周期空 run

### 2. 大响应问题

旧版 `/audit/session/<key>` 会一次返回整个 session 的全部 run 详情，包括：

- timeline
- turns
- summary

对 `agent:main:main` 这类本地主会话，响应体会迅速膨胀到 MB 级。

### 3. 前端状态机冲突

原问题链路包含：

- 首屏请求尚未完成
- 轮询已发起 `since=...`
- MutationObserver / route handler 可能再次触发刷新
- 加载态和数据态相互覆盖

### 4. 静态资源缓存

即使代码已经更新，若浏览器仍命中旧版 `inject.js`，会出现：

- 页面刷新后首个请求不符合当前逻辑
- 旧状态机仍在发错请求

### 5. 后端改动生效条件

本轮排查确认了一条关键经验：

- 修改 `store.ts`、`api-routes.ts`、`static-server.ts`、`index.ts` 这类后端/插件入口文件后
- **必须重启 `openclaw-gateway`**

否则会出现：

- 前端代码看起来已经对了
- 远端插件文件也已经同步
- 但实际运行进程仍在执行旧逻辑

这会把问题伪装成：

- 前端状态机异常
- 浏览器缓存异常
- 或接口没有按预期返回

实际只是运行中的 gateway 还没加载新代码。

## 目标

把 Chat Audit 的加载链路收敛为可预测的三段式：

1. 首屏：只拉少量最新 runs
2. 增量：定时只拉比当前最新更晚的 runs
3. 旧分页：滚动到底或点击“加载更多”时再拉更旧 runs

同时满足：

- 首屏成功前不启动轮询
- 不依赖持久化缓存也能稳定工作
- 若未来加缓存，必须带 TTL 和容量上限

## 设计方案

### A. 会话映射

前端先做“显示名 -> 审计 key”解析：

- 若当前会话名已是 `agent:...` 形式，直接使用
- 若是 `heartbeat` 这类本地友好名，先映射到 `agent:main:main`

这一步在发请求前完成，不依赖“查空后再 fallback”。

### B. 接口协议

`GET /plugins/clawlens/api/audit/session/<sessionKey>`

增加参数：

- `limit`
- `since`
- `before`

语义：

- `limit=N`：首屏或分页只取 N 条
- `since=T`：只返回 `started_at > T` 的新 runs
- `before=T`：只返回 `started_at < T` 的旧 runs

返回值增加：

- `hasMore`
- `latestStartedAt`
- `oldestStartedAt`

### C. 服务端筛选

`getAuditSession()` 调整为：

- 默认按 `started_at DESC`
- 过滤掉没有 `llm_calls`、`tool_executions`、`conversation_turns` 的纯空壳 run

这样前端首屏不会先拿到一串生命周期空记录。

### D. 前端状态机

前端 `CHAT_STATE` 需要明确区分：

- `loading`：首屏加载中
- `refreshing`：增量刷新中
- `loadingMore`：旧分页加载中
- `loadError`：首屏失败

关键约束：

- `refreshing === true` 时不允许再次进入 `refreshChatAudit()`
- `loading === true` 时不启动 polling
- `latestStartedAt` 未建立前，不允许发送 `since=...`

### E. 轮询启动时机

轮询仅在以下条件全部满足时启动：

- 当前在 Chat 页面
- 右侧 Audit 侧栏已打开
- 首屏成功拿到数据
- 已建立 `latestStartedAt`

### F. 静态资源缓存

当前仅靠 `?v=...` 还不够稳，需要同时控制插件静态资源响应头。

建议对 `/plugins/clawlens/ui/*` 增加：

- `Cache-Control: no-store`

目标：

- 避免浏览器继续执行旧版 `inject.js`
- 减少“刷新后首个请求仍走旧逻辑”的问题

## 本轮执行顺序

### 第 1 步：接口增量化

实施：

- `store.ts` 支持 `limit/before/since`
- `api-routes.ts` 透传这些参数

目标：

- 把单次响应压缩到小体积

### 第 2 步：前端状态机收敛

实施：

- `inject.js` 改为：
  - 首屏 `limit`
  - 轮询 `since`
  - 底部分页 `before`

目标：

- 消除首屏与轮询打架

### 第 3 步：静态资源缓存治理

实施：

- `static-server.ts` 返回 `Cache-Control: no-store`
- 必要时继续 bump 资源版本号

目标：

- 保证浏览器真正执行最新脚本

### 第 4 步：必要时再引入轻量缓存

前提：

- 无缓存版本先稳定

若后续加缓存，约束如下：

- 只缓存最近少量 run
- 不缓存完整大正文
- TTL 10 到 30 分钟
- 每个 session 限制条数
- 全局限制 session 数
- 版本变化时清空

## 当前执行状态

已完成：

- 基本会话映射：友好名优先映射到 `agent:main:main`
- 后端支持 `limit/since/before`
- 前端已引入首屏 / 增量 / 旧分页三种请求语义
- 首屏成功前不再主动启动轮询
- 插件静态资源已改为 `Cache-Control: no-store`
- 已确认“后端文件修改后重启 gateway”是必要步骤

待继续完成：

- 再次验证浏览器是否仍执行旧 `inject.js`
- 若页面仍异常，继续对“首屏响应 -> DOM 渲染结果”做定点排查

## 审计说明

本文件是“执行前与执行中规划文档”，用于：

- 记录当前问题链路
- 说明为什么需要接口增量化
- 记录缓存策略约束
- 作为后续修复结果对照基线
