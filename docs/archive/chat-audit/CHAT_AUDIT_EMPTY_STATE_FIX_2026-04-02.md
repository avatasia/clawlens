# Chat Audit 空白侧栏修复记录

日期：2026-04-02

## 问题现象

截图：`test/ScreenShot_2026-04-02_145448_107.png`

在 Chat 页面打开右侧 `ClawLens Audit` 时，面板标题存在，但主体区域接近空白，看起来像：

- 前端脚本没有渲染内容
- 或渲染失败后只留下背景

实际排查后，这次不是 UI 挂载失败，而是 **当前 chat session key 和 ClawLens 存库使用的 session_key 不一致**。

## 根因

当前 chat 页面取到的 session key 是：

- `heartbeat`

而线上 audit 数据接口返回的已有 session 主要是：

- `unknown`
- `agent:main:main`
- `agent:main:discord:channel:...`

实际接口结果：

- `GET /plugins/clawlens/api/audit/session/heartbeat`
- 返回：`{"sessionKey":"heartbeat","runs":[]}`

这说明：

1. 右侧侧栏不是“没加载”
2. 而是它确实拿到了一个合法 key
3. 只是这个 key 在后端没有对应 run 数据

## 触发链路

文件：[inject.js](../../../extensions/clawlens/ui/inject.js)

### 1. 当前 session key 直接取自 chat 页面

```js
function getCurrentSessionKey() {
  const url = new URL(location.href);
  const s = url.searchParams.get("session");
  if (s) return s;
  const sel = document.querySelector(".chat-session select");
  return sel?.value ?? null;
}
```

这会拿到用户可见的会话标识，例如 `heartbeat`。

### 2. refreshChatAudit 直接按该 key 查询

```js
let d = await apiFetch("/audit/session/" + encodeURIComponent(key));
```

原逻辑只对带 `:` 的 key 做逐级缩短 fallback：

- `a:b:c -> a:b -> a`

但 `heartbeat` 这种本地 chat 名称不包含 `:`

所以原逻辑不会命中任何有效 fallback。

### 3. 最终得到空 runs

原代码在 `d` 存在但 `runs` 为空时，没有给出足够明确的空状态说明，于是表现成接近“空白侧栏”。

## 本次修改

文件：[inject.js](../../../extensions/clawlens/ui/inject.js)

### A. 增加明确的空状态渲染

新增：

```js
function renderAuditEmptyState(sessionKey, resolvedFrom) { ... }
```

目的：

- 不再让空数据面板看起来像渲染失败
- 明确告诉用户当前 session 没有 audit 数据
- 若使用了 fallback，也显示 fallback 来源

### B. 保留原有冒号前缀 fallback，并补充来源记录

原本 fallback 只做数据替换，现在补充：

- `_resolvedFrom`

便于前端空状态和后续审计识别实际命中的 fallback key。

### C. 对本地 web chat 名称补充默认 fallback

新增逻辑：

```js
if (d && d.runs?.length === 0 && !key.includes(":")) {
  const fb = await apiFetch("/audit/session/" + encodeURIComponent("agent:main:main"));
  if (fb?.runs?.length) {
    d = {
      ...fb,
      sessionKey: key,
      _fallback: true,
      _resolvedFrom: "agent:main:main",
    };
  }
}
```

原理：

- OpenClaw 本地 web chat 常给出友好名称，如 `heartbeat`
- ClawLens collector 侧实际入库的常见 key 是 `agent:main:main`
- 在精确 key 查不到数据时，优先回退到本地默认 agent session

### D. 空数据时不再渲染空白主体

在 `updateAuditSidebarContent()` 中新增：

```js
if (!CHAT_STATE.data.runs?.length) {
  body.innerHTML = renderAuditEmptyState(CHAT_STATE.sessionKey, CHAT_STATE.data._resolvedFrom);
  return;
}
```

效果：

- 没有数据时明确显示原因
- 不再只留下空背景

## 本次改动解决的问题

解决了两类用户感知问题：

1. `heartbeat` 这类本地 chat session 名称无法直接映射到 audit 数据，导致侧栏看起来空白
2. 空数据时没有明确提示，用户误以为脚本挂掉或渲染异常

## 未改变的边界

本次修复没有改变后端存储模型：

- ClawLens 仍按 collector 侧的 `session_key` 入库
- 没有新增“chat 名称 <-> audit session_key”正式映射表

所以当前方案属于：

- **前端 fallback 修复**
- 不是存储层主键统一修复

## 后续建议

若后续要从根本上消除这类不匹配，建议考虑两条路线之一：

### 方案 1：collector / runtime 统一 session key 语义

让 web chat 可见 session 名和 audit session_key 尽量一致。

优点：

- 前端不需要猜测 fallback

缺点：

- 影响面较大
- 需要重新核查历史数据与兼容性

### 方案 2：后端提供 session 映射接口

例如新增：

- `GET /plugins/clawlens/api/audit/resolve-session?chatKey=heartbeat`

由后端基于运行时上下文或近似规则返回真实 audit session key。

优点：

- 前端逻辑更干净
- fallback 规则集中在服务端

缺点：

- 需要新增接口和映射策略

## 远端同步结果

已同步文件：

- [inject.js](../../../extensions/clawlens/ui/inject.js)

远端路径：

- `~/.openclaw/extensions/clawlens/ui/inject.js`

远端已确认包含以下新逻辑：

- `renderAuditEmptyState`
- `agent:main:main` fallback
- `_resolvedFrom`

## 审计结论

这次“ClawLens Audit 看起来空白”的根因不是前端挂载失败，而是：

- chat 页 session 名为 `heartbeat`
- 后端 audit 数据实际落在 `agent:main:main`
- 原前端没有针对这类本地 chat 名称做有效 fallback

本次修复采用了：

- 前端 fallback 补偿
- 明确空状态提示

属于低风险、可立即生效的修复。
