# ClawLens Plugin 准则复核

> 复核时间：2026-04-01
> 证据源：`extensions/clawlens/`、`projects-ref/openclaw/src/plugins/`
> 输出策略：基于原文另存为新文件；原文件未修改。

## 本轮修改/删除说明

1. 保留原文关于 plugin shape、`api.on()`、`definePluginEntry()`、空 `configSchema`、`any` 类型逃逸的主判断，原因是对应源码未变。
2. 将 “Comparator 缺少 `sessionId`” 的合规风险扩大为 “`runtime: any` 让整组必填参数缺失都绕过类型系统”，原因是这比单字段缺失更能解释当前实现为何在编译期未报警。
3. 保留“测试不可直接运行、字段名陈旧”的判断，并扩大到多个测试文件，原因是当前不仅 `collector.test.ts`，`cost-calculator.test.ts` 和 `sse-manager.test.ts` 也都直接导入不存在的 `../src/*.js`。

## 结论摘要

1. ClawLens 的 shape 应记为 `non-capability`，不是 `hook-only`。
2. `definePluginEntry()`、`register(api)`、`api.registerHttpRoute()` 这些主路径使用正确。
3. 当前最严重的合规问题不是 legacy hook，而是空 `configSchema` 直接封死了所有正式配置。
4. 第二类明确问题是大量 `any` 抹掉了 OpenClaw SDK 的类型保护，已实际掩盖 compare 路径的必填参数缺失。

## 一、Plugin shape

证据：

- `projects-ref/openclaw/src/plugins/status.ts:34-40`
- `projects-ref/openclaw/src/plugins/status.ts:212-240`
- `extensions/clawlens/index.ts:74-103`

结论：

- ClawLens 注册了 typed hooks、service、HTTP route。
- 它没有 capability。
- 因此 inspect shape 应为 `non-capability`。

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

- `extensions/clawlens/src/api-routes.ts:37-126`

结论：

- 使用的是 `registerHttpRoute(...)`。
- `auth: "plugin"` 已显式声明。

### 3. manifest 最低要求

证据：

- `extensions/clawlens/openclaw.plugin.json:1-7`

结论：

- manifest 至少具备 `id` 和 `configSchema`，满足最低装载要求。
- 但“能装载”不等于“配置设计正确”。

## 三、已确认问题

### P1-1 空 `configSchema` 阻断所有正式配置

证据：

- `extensions/clawlens/openclaw.plugin.json:1-7`
- `extensions/clawlens/index.ts:69-90`

结论：

- schema 为 `{ type: "object", additionalProperties: false, properties: {} }`。
- 任何用户配置字段都会被拒绝。
- `compare.enabled` 因此无法经正式配置路径开启。

### P1-2 大量 `any` 绕过 SDK 类型系统

证据：

- `extensions/clawlens/index.ts:78-96`
- `extensions/clawlens/src/comparator.ts:21-24`
- `projects-ref/openclaw/src/agents/pi-embedded-runner/run/params.ts:27-104`

结论：

- `api.on(...)` 的 event / ctx 被写成 `any`。
- `Comparator` 的 `runtime` 被写成 `any`。
- 这已经实际掩盖了 compare 路径中 `sessionId`、`prompt`、`runId` 等必填参数缺失。

### P1-3 继续使用 legacy `before_agent_start`

证据：

- `extensions/clawlens/index.ts:87-91`
- `projects-ref/openclaw/src/plugins/status.ts:101-109`

结论：

- 这不是功能错误，但会触发 compatibility warning。
- 文档中应写成“兼容层路径”，而不是推荐新设计。

### P2-1 `registerApiRoutes(api as any, ...)` / `registerStaticRoutes(api as any, ...)`

证据：

- `extensions/clawlens/index.ts:95-96`

结论：

- 这是局部类型逃逸。
- 当前未直接证实运行时 bug，但它继续扩大了 API 面的静态检查盲区。

### P2-2 直接修改 OpenClaw Control UI 产物

证据：

- `extensions/clawlens/index.ts:13-58`

结论：

- `patchControlUiIndexHtml()` 会直接改 OpenClaw 的 `dist/control-ui/index.html`。
- 这不是稳定插件扩展接口。

## 四、测试与准则偏差

### 1. 测试入口不可直接执行

证据：

- `extensions/clawlens/package.json:1-8`
- `extensions/clawlens/tests/collector.test.ts:10`

补充验证：

- 本轮执行 `node --test extensions/clawlens/tests/collector.test.ts`，结果为 `ERR_MODULE_NOT_FOUND`，因为测试直接导入不存在的 `../src/collector.js`。
- 同类问题也出现在 `extensions/clawlens/tests/cost-calculator.test.ts` 与 `extensions/clawlens/tests/sse-manager.test.ts`，它们分别导入 `../src/cost-calculator.js`、`../src/sse-manager.js`。

结论：

- 不能再把这些测试写成“现成可运行的质量保障”。

### 2. 测试字段名陈旧

证据：

- `extensions/clawlens/tests/collector.test.ts:127`
- `extensions/clawlens/tests/collector.test.ts:256`
- `extensions/clawlens/tests/collector.test.ts:369-370`
- `extensions/clawlens/src/collector.ts:261-286`

结论：

- 测试仍使用 `input` / `content` / `isError`。
- 实现已改为 `params` / `result` / `error`。

## 五、建议后的统一口径

1. ClawLens 是 `non-capability` plugin。
2. `api.on()` 不是废弃接口；真正的问题是 legacy hook 依赖和 `any` 式实现。
3. 当前首要配置问题是空 schema，而不是 UI 提示缺失。
4. 测试覆盖应写成“存在测试草稿，但执行入口和断言字段需修正”，不能写成“已有可靠覆盖”。
