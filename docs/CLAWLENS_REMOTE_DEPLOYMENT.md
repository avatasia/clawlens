---
status: active
created: 2026-04-10
updated: 2026-04-14
---

# ClawLens Remote Deployment

> [!IMPORTANT]
> Current Authority: This is the active remote deployment SOP.

本文档描述将 ClawLens 插件部署到远端 OpenClaw 服务器的完整步骤。

## 前提条件

- 远端服务器可通过 SSH 密钥登录（示例：`ssh szhdy`）。
- 远端已安装 OpenClaw 并有运行中的 gateway。
- 本地已完成 `pnpm install`（在 `extensions/clawlens/` 下）。插件为源码直接部署，无需 build 步骤。

## 1. SSH 执行约束（必须加载 `~/.bashrc`）

通过 `ssh szhdy '<command>'` 执行非交互命令时，远端默认不会加载 `~/.bashrc`，容易命中错误 PATH。

本 SOP 统一要求：**所有 SSH 命令都通过 `bash -lc` 并显式 `source ~/.bashrc` 执行。**

统一模板：

```bash
ssh szhdy 'bash -lc "source ~/.bashrc && <command>"'
```

> [!IMPORTANT]
> 当前 `szhdy` 机器的非交互 SSH 默认 PATH 会落到系统工具链（`/usr/bin/node`、`/usr/bin/npm`）。
> 远端执行 `node/npm/pnpm/openclaw` 时，不要依赖默认 PATH；优先使用 nvm 绝对路径，或在命令内显式导出 nvm PATH。

远端当前绝对路径（用于排障与兜底）：

| 工具 | 远端路径 |
|---|---|
| `node` | `/home/openclaw/.nvm/versions/node/v24.14.0/bin/node` |
| `npm` | `/home/openclaw/.nvm/versions/node/v24.14.0/bin/npm` |
| `pnpm` | `/home/openclaw/.nvm/versions/node/v24.14.0/bin/pnpm` |
| `openclaw` | `/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw` |

推荐统一前缀（可直接复用）：

```bash
ssh szhdy 'bash -lc "
  source ~/.bashrc
  export PATH=\"/home/openclaw/.nvm/versions/node/v24.14.0/bin:/home/openclaw/.local/share/pnpm:$PATH\"
  <command>
"'
```

若仍不稳定，直接使用绝对路径执行（最稳妥）：

```bash
ssh szhdy 'bash -lc "/home/openclaw/.nvm/versions/node/v24.14.0/bin/openclaw --version"'
```

## 2. 复制插件文件到远端

使用 `rsync`（推荐，支持增量同步）或 `scp`。

### rsync 方式

```bash
rsync -avz --delete \
  extensions/clawlens/ \
  szhdy:~/.openclaw/extensions/clawlens/
```

说明：

- `--delete` 确保远端不残留本地已删除的文件。
- 首次部署时远端目录 `~/.openclaw/extensions/clawlens` 不存在，rsync 会自动创建。
- 注意源路径末尾的 `/`，表示同步目录内容而非目录本身。

### scp 方式（备选）

```bash
ssh szhdy 'bash -lc "source ~/.bashrc && mkdir -p ~/.openclaw/extensions/clawlens"'
scp -r extensions/clawlens/* szhdy:~/.openclaw/extensions/clawlens/
```

## 3. 远端安装依赖

若插件有 npm 依赖需要安装：

```bash
ssh szhdy 'bash -lc "source ~/.bashrc && cd ~/.openclaw/extensions/clawlens && pnpm install --frozen-lockfile"'
```

## 4. 注册插件到 openclaw.yaml

远端 OpenClaw 配置文件通常位于 `~/.openclaw/openclaw.yaml`。

需要在 `plugins.entries` 中添加 clawlens 条目：

```yaml
plugins:
  entries:
    clawlens:
      enabled: true
      source: local
      path: ~/.openclaw/extensions/clawlens
```

通过 SSH 编辑：

```bash
ssh szhdy 'bash -lc "source ~/.bashrc && vi ~/.openclaw/openclaw.yaml"'
```

或使用交互式 SSH 会话：

```bash
ssh szhdy
# 然后在远端编辑
vi ~/.openclaw/openclaw.yaml
```

## 5. 重启 Gateway

重启 OpenClaw gateway 以加载新插件：

```bash
ssh szhdy 'bash -lc "source ~/.bashrc && openclaw gateway restart"'
```

重启后必须做“两阶段验收”，不可只依赖 `restart` 的返回文本：

1. 服务重启验收（systemd 时间戳）
2. UI/API 就绪验收（等待 dashboard + 插件 API 可访问，支持慢启动场景）

推荐直接使用仓库脚本：

```bash
bash scripts/remote-gateway-restart-verify.sh szhdy 120 600
```

验收规则：

- `SubState=running`
- `ActiveEnterTimestamp` 距当前时间不超过 120 秒（可按需调整阈值）
- 建议额外核对 `MainPID` 是否变化（若未变化，脚本会告警）
- 就绪阶段默认最多等待 600 秒，每 5 秒轮询，连续 3 次成功才判定 ready
- 若超时，脚本会自动输出 `gateway status`、最近日志和 HTTP 端点诊断

若 `openclaw gateway restart` 不可用，可使用进程管理方式：

```bash
# 查找现有 gateway 进程
ssh szhdy 'bash -lc "source ~/.bashrc && ps aux | grep openclaw"'

# 按实际情况停止并重新启动
ssh szhdy 'bash -lc "source ~/.bashrc && openclaw gateway start"'
```

## 6. 验证插件加载

### 6.1 检查 gateway 日志

```bash
ssh szhdy 'bash -lc "source ~/.bashrc && openclaw gateway logs --tail 50"'
```

预期看到类似输出：

```
[plugin:clawlens] ClawLens plugin started
```

### 6.2 检查插件状态

```bash
ssh szhdy 'bash -lc "source ~/.bashrc && openclaw plugins inspect clawlens"'
```

### 6.3 测试 API 端点

通过 SSH 在远端本地测试：

```bash
ssh szhdy 'bash -lc "source ~/.bashrc && curl -s http://localhost:18789/plugins/clawlens/api/overview"'
```

预期返回 JSON 数据而非 404。

## 7. SSH Tunnel（本地浏览器访问）

远端 gateway 绑定在 `localhost:18789`，需通过 SSH tunnel 从本地浏览器访问。

```bash
ssh -L 18789:127.0.0.1:18789 szhdy
```

> [!IMPORTANT]
> 若本机 `18789` 已被占用（常见为已有 tunnel 或本地 gateway），请改用其他本地端口映射；
> 不要与本地 QA 验证流程共用同一个 `18789`。

然后在本地浏览器访问：

```
http://localhost:18789
```

ClawLens 的 Control UI 可通过以下路径访问：

```
http://localhost:18789/plugins/clawlens/ui/
```

保持 SSH 会话打开以维持 tunnel。如需后台运行：

```bash
ssh -fN -L 18789:127.0.0.1:18789 szhdy
```

## 8. 更新部署（后续迭代）

后续更新只需重复以下步骤：

1. 本地完成修改与构建。
2. rsync 同步到远端（步骤 2）。
3. 如有依赖变更，远端重新安装（步骤 3）。
4. 重启 gateway（步骤 5）。
5. 验证加载（步骤 6）。

无需重复 openclaw.yaml 注册（步骤 4），除非插件 ID 或路径发生变化。

## 故障排查

### 插件未加载

1. 检查 `~/.openclaw/openclaw.yaml` 中 clawlens 条目的 `enabled` 是否为 `true`。
2. 检查 `path` 是否指向正确目录。
3. 检查远端 `~/.openclaw/extensions/clawlens/openclaw.plugin.json` 是否存在且 `id` 为 `"clawlens"`。
4. 检查 gateway 日志中是否有报错信息。

### API 返回 404

1. 确认 gateway 已重启且插件已加载。
2. 确认请求路径正确：`/plugins/clawlens/api/overview`。
3. 检查 SSH tunnel 是否连通（本地访问时）。

### PATH 相关报错

远端通过非交互式 SSH 执行命令时，若不显式加载 `~/.bashrc`，PATH 往往与交互会话不一致。统一使用：

```bash
ssh szhdy 'bash -lc "source ~/.bashrc && <command>"'
```

## 参考

- [clawlens-usage.md](clawlens-usage.md) -- 插件使用指南与 API 参考
- [architecture.md](architecture.md) -- 插件架构文档
- [CLAWLENS_PLUGIN_DEV_WORKFLOW.md](CLAWLENS_PLUGIN_DEV_WORKFLOW.md) -- 插件开发工作流
