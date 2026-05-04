---
status: active
created: 2026-05-01
updated: 2026-05-02
---

# ClawLens Remote Validation Prep

目的：在全面代码验收通过后，按固定顺序推进远程验证准备，避免遗漏环境配置、真实集成验证和兼容性门禁。

## Gate

只有在外部全面验收达到以下任一结论后，才进入本文件的执行阶段：

- `VERDICT: READY`
- `VERDICT: READY-WITH-FIXES` 且所有 blocker 已关闭

当前状态：

- `cc1` comprehensive acceptance round 1: `VERDICT: READY-WITH-FIXES`
- `cc1` comprehensive acceptance round 2: `VERDICT: READY`
- 代码侧 blocker: none
- 代码侧 residual notes:
  - `ui/inject.js` 行为仍以人工验收为主，不属于当前本地代码缺陷

## Execution Order

1. 远程环境配置确认
   - `collector.structuredPreviews`
   - `collector.sourceLookupEnabled`
   - `collector.sourceLookupDirs`
   - source route 鉴权 token 配置
   - 注意：当前插件 auth token 只保护 source endpoints；如果未配置 token，overview/session/run detail/message detail 这类 preview-only audit endpoints 默认仍可访问

2. 真实运行环境端到端验证
   - 会话采集链路
   - Audit overview / run detail
   - structured preview 渲染
   - explicit message source load
   - explicit tool source load

3. 兼容性门禁
   - 在具备 OpenClaw CLI 的环境里执行：
     - `bash scripts/forward-compat.sh strict --use-local-ref`
   - 如目标环境有 stable baseline，再补一次对应安装/加载验证

4. 发布物检查
   - manifest / config schema 在目标环境可识别
   - source routes 的 auth 行为与部署方式一致
   - trusted roots 配置不越权

## Manual UI Acceptance Checklist

这部分是 `cc1` 在 round 2 明确保留的人工验证项。远程验证前至少过一轮：

1. preview-only 默认行为
   - hover message turn 时只打开 preview surface
   - hover 不触发 source 请求
   - hover 关闭后不残留 pinned 状态

2. structured preview 渲染
   - legacy plain preview 仍按原有文本方式展示
   - `structured-json-v1` preview 显示为可读树，而不是原始 wrapper JSON
   - 深层 object / array 可展开
   - long string / truncated / circular 节点有可见标识
   - redacted 字段不会泄露原值

3. pin / expand 行为
   - click preview surface 可 pin
   - pinned 状态可展开/折叠节点
   - keyboard 入口可 pin
   - unpin 后状态恢复正常

4. explicit source load only
   - message turn 的 `Source` 入口只在明确点击后加载
   - tool row 的 `Source` 入口只在明确点击后加载
   - source route miss / 403 / truncated payload 都有可理解反馈

5. source cache 行为
   - 重复加载同一 source 命中本地缓存
   - 切换 run / turn 后不会串数据
   - 大 payload / 多次加载不会让 UI 卡死

6. responsive / regression smoke
   - 桌面端 detail view 可正常展开 preview 和 source
   - 窄宽度下 preview/source 控件不遮挡主要信息

### Current execution status

截至 2026-05-02：

- 已完成的远端 UI / 资源级验证：
  - root dashboard `200 OK`
  - `/plugins/clawlens/api/overview` `200 OK`
  - `ui/inject.js` 与 `ui/styles.css` 已确认从远端页面注入并可访问
  - headless Chrome 已成功打开远端 Control UI，并生成截图
  - 真实 audit session payload 已确认包含：
    - `previewFormat`
    - `previewVersion`
    - `previewNode`
    - `hasSourceLookup`
- 已确认的行为事实：
  - hover surface 仍走 preview-only 设计
  - source load 仍需要显式点击 `Source`
  - tokenized `/chat#token=...` 登录后，Audit toggle 可稳定出现，Audit sidebar 可正常打开
  - 当前远端样本页已经观测到：
    - `runCount=8`
    - `turnCount=21`
    - `sourceButtonCount=21`
    - `runCopyCount=1`
  - `sourceLookupEnabled=false` 或无可用 trusted root 时，`hasSourceLookup=false`
  - source route live auth gate 已完成实测：
    - 不带 `Authorization` 请求 `GET /plugins/clawlens/api/audit/source/message/:messageId` 返回 `401 {"error":"unauthorized"}`
    - 带错误 Bearer token 返回 `401 {"error":"unauthorized"}`
    - 带远端 `gateway.auth.token` 的 Bearer token 返回 `200`，并成功拿到真实 source payload
  - browser-side UI 抓包验收已经完成一轮：
    - hover first turn 后 preview surface 以 `420px` 打开
    - 鼠标移出 turn 后，surface 保持可见，不会自动关闭
    - hover 不触发 `/plugins/clawlens/api/audit/source/*` 请求
    - 点击 `Source` 后，source request 数从 `0 -> 1`
    - 点击 turn `Copy` 与 run `Copy` 后，source request 计数保持不变
    - source click 后采样到的 surface width 序列恒定为 `560px`，未观察到“先变宽再变窄”的抖动
    - 点击空白区域后 preview surface 正常关闭
- 尚未正式记为“完整人工验收已完成”的条目：
  - pinned / expand 的人工交互核对
  - source cache 命中体验的人工核对
  - source success payload 场景下的底部留白人工核对
  - 窄宽度 responsive smoke 的人工核对

因此当前状态应记为：

- remote validation: `in progress`
- manual UI acceptance checklist: `substantially executed, not yet fully signed off`

## Remote Validation Commands

在目标环境中按顺序执行：

```bash
cd extensions/clawlens && npm run typecheck
cd extensions/clawlens && npm test
node scripts/check-clawlens-manifest.mjs
node scripts/check-docs-governance.mjs
bash scripts/stable-gate.sh
bash scripts/forward-compat.sh strict --use-local-ref
```

如果目标环境没有 OpenClaw CLI，则记录该限制，并至少完成插件真实加载、真实会话采集、API/source route、UI manual checklist。

## Confirmed Findings

### 1. Gateway auth: shared token alone is not enough for scoped operator RPC

远端实测确认：

- 直接用 shared token 以普通 `operator` 客户端身份连接 gateway WebSocket 时，连接本身可以成功；
- 但如果客户端没有 device identity，gateway 会清空自报 scopes；
- 结果是 `status`、`sessions.list` 这类需要 `operator.read` 的 RPC 会返回 `missing scope`。

同轮实测中，改为“本机 loopback + backend gateway client”后，`operator.admin` scopes 被保留，`sessions.list`、`chat.history`、`sessions.create`、`chat.send`、`sessions.reset` 可正常调用。

工程含义：

- 远程验证脚本如果要直接走 RPC，不要默认使用“token-only operator client”；
- 对自动化验证，优先使用 direct-local backend gateway client 形态；
- 如果未来需要从浏览器/普通 operator 客户端复现实验，则必须把 device identity 也纳入验证前提。

### 2. `/reset` 已完成远端实测，不只是口头事实

2026-05-01 远端用独立 dashboard session 跑了完整序列：

1. `sessions.create`
2. `chat.send` 三轮短消息，均等待 `agent.wait -> ok`
3. `chat.history`
4. `chat.send('/reset')`
5. 再次 `chat.history`
6. 直接读取 `agents/main/sessions` 下的 session store 与归档文件

实测结果：

- reset 前 `chat.history` 可见 6 条消息：
  - 3 条 user prompt
  - 3 条 assistant ack
- reset 后同一 session key 的 `chat.history` 只剩 1 条 assistant 消息：
  - `✅ Session reset.`
- session store 中该 session key 的 `sessionId` 和 `sessionFile` 都发生了切换；
- 旧 transcript 被归档为：
  - `<oldSessionId>.jsonl.reset.<timestamp>`
- 归档文件中仍然包含 reset 前的全部 prompt/ack 文本。

工程含义：

- Chat/API 视角下，`/reset` 后当前 session 历史基本等价于“被清空并进入新 transcript”；
- 旧对话内容并没有消失，而是转移到了 reset archive JSONL；
- ClawLens 的 full source lookup 继续以 JSONL 为主证据源是正确方向。

补充插件侧实测：

- 同一 session key 的 OpenClaw `chat.history` 在 reset 后只剩 reset 确认消息；
- 但 ClawLens `GET /plugins/clawlens/api/audit/session/:sessionKey` 仍能返回 reset 前 3 个 chat runs；
- 这些 runs 的 turn 上：
  - `sessionFile` 仍指向 reset 前的旧 transcript
  - `hasSourceLookup=true`
  - `previewFormat=structured-json-v1`
- `GET /plugins/clawlens/api/audit/session/:sessionKey/current-message-run` 在 reset 后会按“latest-user-turn”继续解析到 reset 前最后一条 user turn 对应的 run。

这说明：

- ClawLens 当前实现并不依赖 OpenClaw reset 后仍能从 Chat/API 取回旧历史；
- 以 store 中记录的 `sessionFile` 和 source lookup 去追旧 transcript，方向正确。

### 3. 当前远端 `agents/` 目录形态

本轮枚举到的远端目录形态是：

- `~/.openclaw/agents/main/sessions`

本轮没有直接枚举到 `agents/<dynamic>/sessions` 子树，但当前 `sessions.json` 已经出现多种 channel 会话 key：

- `agent:main:openclaw-weixin:...`
- `agent:main:wecom:...`
- `agent:main:yuanbao:...`
- `agent:main:discord:...`
- `agent:main:qqbot:...`

这说明“channel 多样性”和“session key 多样性”已经是远端现实。即使当前这台机器上文件仍集中在 `agents/main/sessions`，部署文档也不应把它升级为长期唯一根目录假设。

### 4. `sessions.delete` 与 manual `sessions.compact` 的真实文件产物

2026-05-02 远端继续用独立 dashboard session 跑了两条最小链路：

1. `chat.send` 一轮后执行 `sessions.delete`
2. `chat.send` 两轮后执行 manual `sessions.compact`

实测结果：

- `sessions.delete` 会把旧 transcript 归档成：
  - `<sessionId>.jsonl.deleted.<timestamp>`
- 删除后同目录中仍可见：
  - `.trajectory.jsonl`
  - `.trajectory-path.json`
- `.deleted.*` 归档里仍保留删除前的 prompt / assistant ack。

manual `sessions.compact` 的当前远端行为则是：

- session key 不变
- `sessionId` 不变
- 主 transcript 仍然是原来的 `<sessionId>.jsonl`
- 同目录额外生成：
  - `<sessionId>.checkpoint.<uuid>.jsonl`
  - 以及已有的 `.trajectory.jsonl` / `.trajectory-path.json`

当前这台远端在 manual compaction 后没有观察到“主 transcript 文件名切换为新 successor basename”的行为。

工程含义：

- `.deleted.*` 是确定存在、且应被 source lookup 识别的真实产物；
- `.checkpoint.<uuid>.jsonl` 是当前 upstream 明确存在的 compaction 相关快照；
- “compaction successor basename” 目前仍可保留为兼容性候选，但不能把它当作当前远端的主要现实路径。
- ClawLens shared resolver 应主动枚举 `.checkpoint.<uuid>.jsonl`，不能只在 `sessionFile` 已经直接指向 checkpoint 时才认得它。

### 5. 最新消息读取：file tail 明显快于 API

2026-05-02 远端在同一条临时 dashboard session 上做了 30 次对照：

- API 路径：
  - `chat.history(sessionKey, limit=1)`
- file 路径：
  - 直接读取 `sessionFile` 尾部最后一条 JSONL message

实测结果：

- API median: `22.79ms`
- file median: `0.27ms`
- file 比 API 的中位耗时快约：`22.51ms`
- 两者取到的最新消息文本一致：
  - `clawlens-latest-bench-...-ack`

工程建议：

### 6. Source route auth gate: live behavior after gateway-token fallback

2026-05-02 远端在完成 `api-routes.ts` 的 source token fallback 调整后，再次用真实 `messageId` 跑了三条 source route 分支：

- 无 `Authorization`：
  - 返回 `401`
  - body: `{"error":"unauthorized"}`
- 错误 Bearer token：
  - 返回 `401`
  - body: `{"error":"unauthorized"}`
- 正确的 `gateway.auth.token` Bearer token：
  - 返回 `200`
  - body 中 `ok=true`
  - `payload.id` 与请求的 `messageId` 一致

实测时命中的远端 transcript 来自：

- `sessionKey`: `agent:main:discord:direct:1113387681435623444`
- `sessionFile`: `~/.openclaw/agents/main/sessions/1cd25b5b-3950-48a7-b44b-ef9d7aa0b6d1.jsonl`

工程含义：

- 现有远端 OpenClaw 配置并没有单独的插件私有 `api.config.auth.token`；
- 仅依赖 `(api.config as any)?.auth?.token` 会让 source route 在真实远端上永远停留在“token 未配置”分支；
- 允许 source route 退回使用 `gateway.auth.token` 作为等价受保护边界后，live success path 才能被实际验证；
- preview-only audit endpoints 继续维持 open-by-default 行为，不受这次 source auth gate 收紧影响。

### 7. Control UI fresh-login token hydration must not rely on one-time token capture in `ui/inject.js`

2026-05-02 远端浏览器抓包又发现了一个真实前端集成问题：

- Control UI 用 tokenized `/chat#token=...` 进入后，会把 token 写入：
  - `sessionStorage["openclaw.control.token.v1:ws://127.0.0.1:18790"]`
- 但当时的 ClawLens `ui/inject.js` 只在 `main()` 启动时读一次 `sessionStorage`
- 结果是：
  - preview-only audit routes 仍可用
  - browser 点击 `Source` 会真实发起请求
  - 但 source route 返回 `401 {"error":"unauthorized"}`
  - UI 上表现为 `request_failed`

已修复：

- `authHeaders()` 现在在每次请求前都会重新读取一次 `getToken()`，而不是只依赖初始化时缓存的 `S.token`

修复后的远端复测结果：

- browser-side `Source` 请求不再返回 `401`
- 当前样本中命中的 tool source 返回：
  - `200 {"ok":false,"miss":"tool_call_not_found", ...}`
- 这说明：
  - 浏览器里的鉴权头已经正确附带
  - 之后看到的 source miss 已经是业务级 miss，而不是 auth 失效

1. 对“读取当前 session 的最新消息”这类能力，优先采用 file 路径。
2. API 路径保留为 fallback，并且建议显式开关化。
3. 若后续启用 API fallback，文档里必须明确说明启用原因，而不是默认把两条路径混为一谈。

推荐的 API fallback 启用条件：

- 当前记录没有可用 `sessionFile`
- 运行环境不允许直接访问 transcript 文件
- 需要 host 侧 projection / sanitization 语义，而不是原始 JSONL 最新 entry
- 文件路径已因生命周期切换失效，且需要先用 host 侧能力辅助定位

## Tracking

- Review status: `cc1` accepted for code-level readiness
- Remote validation status: in progress
- Release readiness status: pending
