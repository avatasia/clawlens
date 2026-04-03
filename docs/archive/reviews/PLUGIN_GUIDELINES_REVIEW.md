# ClawLens Plugin 准则复核

> 复核时间：2026-04-01
> 证据源：`extensions/clawlens/`、`projects-ref/openclaw/src/plugins/`

## 结论摘要

1. ClawLens 的 shape 应记为 `non-capability`，不是 `hook-only`。
2. `api.registerHttpRoute()`、`definePluginEntry()`、`register(api)` 这些主路径使用正确。
3. 当前最严重的合规问题不是 legacy hook，而是空 `configSchema` 直接封死了所有用户配置。
4. 另一个明确问题是大量 `any` 抹掉了本来可由 OpenClaw SDK 提供的类型保护。

## 一、Plugin shape

证据：

- `projects-ref/openclaw/src/plugins/status.ts:34-40`
- `projects-ref/openclaw/src/plugins/status.ts:212-240`
- `extensions/clawlens/index.ts:84-103`

结论：

- OpenClaw 的 inspect shape 有 `hook-only`、`plain-capability`、`hybrid-capability`、`non-capability`。
- ClawLens 注册了 hook、service 和 HTTP route，但没有 capability。
- 因此 shape 应是 `non-capability`。

## 二、已符合项

### 1. 插件入口

证据：

- `extensions/clawlens/index.ts:3`
- `extensions/clawlens/index.ts:66-104`

结论：

- 使用了 `definePluginEntry(...)`。
- 使用的是 `register(api)`，不是 legacy `activate(api)`。

### 2. HTTP 路由注册

证据：

- `extensions/clawlens/src/api-routes.ts:37-125`

结论：

- 使用的是 `registerHttpRoute(...)`，不是已移除的 `registerHttpHandler(...)`。
- `auth: "plugin"` 已显式声明。

### 3. manifest 最低要求

证据：

- `extensions/clawlens/openclaw.plugin.json:1-8`

结论：

- manifest 至少有 `id` 和 `configSchema`，满足最低装载要求。
- 但“最低要求通过”不代表配置设计正确，见下文 P1。

## 三、已确认问题

### P1-1 空 `configSchema` 阻断所有正式配置

证据：

- `extensions/clawlens/openclaw.plugin.json:1-8`
- `extensions/clawlens/index.ts:74`
- `extensions/clawlens/index.ts:89`

现状：

- schema 只有空对象，且 `additionalProperties: false`。
- 用户通过 OpenClaw 配置注入的任何字段都会被拒绝。
- `index.ts:74` 做浅合并 `{ ...defaultConfig, ...(api.pluginConfig) }`，但合并来的值早已被 schema 过滤为空。
- `index.ts:89` 只有 `config.compare?.enabled` 为真才注册 compare hook。

直接后果：

- `compare.enabled` 无法通过正常配置开启。
- 文档若继续把 Comparator 视为”可配置启用但代码有 bug”，需要同时说明它先被 schema 卡死。

### P1-2 大量 `any` 绕过 SDK 类型系统

证据：

- `extensions/clawlens/index.ts:78-90`
- `extensions/clawlens/src/comparator.ts:24`

现状：

- `api.on(...)` 的 event 和 ctx 全部写成 `any`。
- `Comparator` 把整个 `runtime` 写成 `any`。

直接后果：

- `runEmbeddedPiAgent()` 缺少必填 `sessionId` 这类问题不会在编译期暴露。
- `after_tool_call` 字段名漂移也不会被类型系统拦下。

### P1-3 继续使用 legacy `before_agent_start`

证据：

- `extensions/clawlens/index.ts:89-93`
- `projects-ref/openclaw/src/plugins/status.ts:95-107`

结论：

- 这会触发 compatibility warning。
- 它不是功能错误，但应在文档中明确写成“兼容层路径”，而不是推荐新设计。

### P2-1 `registerApiRoutes(api as any, ...)` / `registerStaticRoutes(api as any, ...)`

证据：

- `extensions/clawlens/index.ts:95-96`

结论：

- 这是局部类型逃逸。
- 当前未直接证明有运行时 bug，但它掩盖了 OpenClaw API 类型不匹配问题。

### P2-2 直接修改 OpenClaw Control UI 产物

证据：

- `extensions/clawlens/index.ts:13-62`

结论：

- `patchControlUiIndexHtml()` 会直接改 OpenClaw 的 `dist/control-ui/index.html`。
- 这不是稳定插件扩展接口，升级后容易丢失。

## 四、测试与准则的偏差

### 1. 测试入口本身不可直接执行

证据：

- `extensions/clawlens/package.json:1-8`
- `extensions/clawlens/tests/*.ts` 中对 `../src/*.js` 的 import

已确认：

- 仓库里没有测试前构建步骤。
- 在当前工作树执行 `node --test extensions/clawlens/tests/collector.test.ts` 会因为找不到 `../src/collector.js` 失败。

因此：

- 不能再把这些测试描述成“现成可运行的质量保障”。

### 2. 测试字段名已经陈旧

证据：

- `extensions/clawlens/tests/collector.test.ts:127,256,369-370`
- `extensions/clawlens/src/collector.ts:257-287`

结论：

- 测试仍用 `input`、`content`、`isError`。
- 实现读取的是 `params`、`result`、`error`。
- 这类测试即使解决了 import 问题，也不能有效约束当前行为。

## 五、建议后的统一口径

文档层统一采用以下说法：

1. ClawLens 是 `non-capability` plugin。
2. `api.on()` 不是废弃接口，废弃的是 legacy hook 和 `any` 式写法。
3. 当前首要配置问题是空 schema，不是 UI 提示缺失。
4. 测试覆盖应表述为“存在测试草稿，但执行入口和断言字段仍需修正”，不能写成“已有可靠覆盖”。
