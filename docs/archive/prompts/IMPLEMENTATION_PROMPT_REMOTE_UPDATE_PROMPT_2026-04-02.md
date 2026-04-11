# 修改 `docs/PROMPT_IMPLEMENTATION.md`（现为 `docs/PROMPT_IMPLEMENTATION.md`）的提示词

> 用途：指导代理专门修订 `docs/PROMPT_IMPLEMENTATION.md`（原 `docs/PROMPT_IMPLEMENTATION.md`）中”远程部署 / 远程验证 / UI 截图验证”相关内容。
> 输出要求：**不要直接修改原文件**，请基于原文另存为新文件。

---

你是一名高级文档审查与实施规范整理工程师。  
你的任务是审查并修订 `docs/PROMPT_IMPLEMENTATION.md` 中与**远程部署、远程验证、截图验证、连接信息使用**相关的章节，使其更安全、更稳妥、更不容易误操作。

已知当前环境的额外事实：

- 远端 SSH **已经配置好 key 登录**
- 可以直接使用类似 `ssh szhdy` 的方式登录

因此修订时必须把“SSH key 直连”作为**默认推荐路径**，不要再把 `sshpass + 密码` 写成默认发布方案。

## 目标文件

- `docs/PROMPT_IMPLEMENTATION.md`

## 输出要求

1. **禁止直接修改原文件**
2. 基于原文生成一个**新的文档文件**
3. 新文件需在开头明确写出：
   - 本轮修改原因
   - 原文件未修改
4. 如果删除或改写原文中的命令、流程或建议，必须写明原因

建议新文件名：

- `docs/IMPLEMENTATION_PROMPT_REMOTE_REVISED_2026-04-02.md`

---

## 修订范围

只修订以下内容：

1. 远程连接信息的使用方式
2. 远程部署命令
3. 插件发布到正确目录的方式
4. 已存在远程目录时的同步方式
5. 远程验证命令
6. UI 截图验证命令
7. 与上述内容直接相关的前提说明、风险说明、检查步骤

不要改动与这些主题无关的实现修复部分。

---

## 必须修正的点

### 1. 不要把明文凭据写成长期推荐做法

修订后必须体现：

- 文档中不要把用户名、IP、密码写成应长期保留在仓库里的固定值
- 可以使用环境变量名，如：
  - `REMOTE_HOST`
  - `REMOTE_PORT`
  - `SSHPASS`
- 明确说明：
  - 明文密码只适合临时测试
  - 长期方案优先 SSH key
- 既然当前环境已可直接 key 登录，修订后应把：
  - `ssh szhdy`
  - `rsync -e ssh ...`
  - `scp` / `ssh` 基于已配置主机别名的方式
  作为默认示例

并要求文档明确区分：

- 默认推荐：SSH key / 已配置 host alias
- 兼容备用：`sshpass`（仅在 key 未就绪时）

如果原文有把凭据硬编码进命令示例的倾向，需要改写为“环境变量 + 前提说明”的形式。

---

### 2. 修正 `scp -r` 导致目录嵌套的问题

修订后必须明确写出：

如果远端已存在：

- `~/.openclaw/extensions/clawlens`

那么下面这种写法有风险：

```bash
scp -r extensions/clawlens/ host:~/.openclaw/extensions/clawlens/
```

它可能导致：

```bash
~/.openclaw/extensions/clawlens/clawlens/
```

修订后必须要求文档：

1. 明确禁止这种高风险写法
2. 给出更稳妥的替代方案

优先建议以下两种方式之一：

#### 方式 A：同步目录内容

```bash
ssh szhdy 'mkdir -p ~/.openclaw/extensions/clawlens'
scp -r extensions/clawlens/* szhdy:~/.openclaw/extensions/clawlens/
```

#### 方式 B：优先使用 `rsync`

```bash
rsync -av --delete -e "ssh" \
  extensions/clawlens/ \
  "szhdy:~/.openclaw/extensions/clawlens/"
```

并说明：

- `rsync source_dir/ target_dir/` 同步的是**目录内容**
- 比 `scp -r` 更适合覆盖已有插件目录
- 如果已经配置好了 SSH host alias，优先使用 alias，减少用户名/IP/端口重复书写错误

---

### 3. 发布前必须先确认远端路径

修订后必须新增“发布前检查”步骤，至少包括：

```bash
ssh szhdy 'echo "$HOME"'
ssh szhdy 'ls -la ~/.openclaw/extensions'
ssh szhdy 'ls -la ~/.openclaw/extensions/clawlens || true'
```

原理说明必须写清：

- 不要凭猜测假定插件路径
- 不要在未确认目录存在状态前直接覆盖

---

### 4. 发布后必须验证实际文件位置

修订后必须新增“发布后检查”步骤，例如：

```bash
ssh szhdy 'find ~/.openclaw/extensions/clawlens -maxdepth 2 -type f | sort | sed -n "1,80p"'
```

要求明确说明：

- 先验证文件是否到了正确目录
- 再验证插件 API / UI
- 不要跳过文件路径检查

---

### 5. 不要假设远端 `openclaw` 一定在 PATH 中

修订后必须体现：

- `openclaw dashboard --no-open`
- `openclaw gateway restart`
- `openclaw gateway logs`

这些命令不能被写成“默认一定可执行”的命令

文档中必须明确：

1. 这些命令依赖远端 PATH / 安装方式
2. 如果远端 shell 里 `openclaw` 不在 PATH，应改用：
   - 已知绝对路径
   - 现有服务管理方式
   - 直接 API 探活

可保留这些命令，但必须放进“若环境支持则使用”的表述中。

---

### 6. API 验证要优先于 CLI 验证

修订后必须强调：

远端部署后，优先验证：

```bash
ssh szhdy 'curl -s http://localhost:18789/plugins/clawlens/api/overview'
ssh szhdy 'curl -s "http://localhost:18789/plugins/clawlens/api/audit?days=7&limit=3"'
```

理由要写清：

- API 返回正常，能更直接证明插件在线
- 比单纯依赖 CLI 更稳

---

### 7. UI 截图验证部分要标明环境依赖

修订后必须把以下依赖明确列成“前提”：

- `google-chrome --headless`
- `ssh`
- 已开放的本地端口转发

并补充说明：

- 若当前环境已配置 SSH key，则截图验证默认使用 `ssh szhdy`
- `sshpass` 只能作为“没有 key 时的兼容备用”，不再作为默认依赖

并明确：

- 这不是通用默认环境
- 只能在本地工具链具备时执行

---

### 8. 新增“推荐的远程部署流程”

修订后的新文档中，应该把远程流程整理成一个清晰顺序，例如：

1. 检查远端目录
2. 确认目标插件目录
3. 用 `rsync` 或“同步内容而非同步目录本身”的方式发布
4. 检查远端实际文件结构
5. 用 API 进行探活
6. 若环境允许，再做 dashboard / UI 验证

并要求文档把该流程写成：

- 默认流程：基于 SSH key / host alias
- 兼容流程：基于环境变量与 `sshpass`

不要让命令散落在多个章节里没有流程感。

---

## 写作要求

1. 直接在原文基础上修订，不要完全重写成无关格式
2. 对删除、改写的关键段落，增加“修改原因”说明
3. 用语务实，不要写空泛安全口号
4. 命令尽量可复制执行，但必须标清前提
5. 明确区分：
   - 默认推荐做法
   - 可选做法
   - 高风险写法（应避免）
6. 在当前场景下，“默认推荐做法”必须是 SSH key 登录，而不是密码登录

---

## 最终交付

完成后输出：

1. 新文件路径
2. 你修改了哪些远程部署/验证规则
3. 这些修改分别是为了解决什么具体误操作风险
