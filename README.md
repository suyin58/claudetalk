# ClaudeTalk

将 Qoder CLI 变成钉钉群里的答疑机器人。在群聊中 @ 机器人或直接发消息，机器人结合项目代码、日志和工具进行问题排查与答疑。

## 特性

- **无需公网 IP**：钉钉 Stream 模式，WebSocket 长连接接收消息
- **多轮对话**：会话持久化，进程重启后自动恢复上下文
- **群聊 per-user 隔离**：同一群内每个用户拥有独立会话，互不干扰
- **引用回复上下文**：回复机器人消息时自动补全被引用消息的完整内容
- **自动压缩**：长跑会话超过 100 万 token 时异步压缩，用户无感知

## 前置条件

1. **Node.js** >= 18（推荐 v20+）
2. **Qoder CLI** 已安装并配置好认证

```bash
# 安装 Qoder CLI
# https://docs.qoder.com/zh/cli/quick-start
```

## 安装

```bash
git clone https://github.com/suyin58/claudetalk.git
cd claudetalk
npm install
npm run build
npm link
```

安装完成后，终端可用 `qodertalk` 命令。底层调用 Qoder CLI（`qodercli`），权限跳过参数 `--yolo`。

## 钉钉机器人配置

### 1. 创建钉钉应用

1. 登录 [钉钉开放平台](https://open-dev.dingtalk.com)，创建**企业内部应用**
2. 在「机器人与消息推送」中启用**机器人能力**
3. 消息接收模式选择 **Stream 模式**（无需公网 IP）
4. 在「凭证与基础信息」中复制 **AppKey** 和 **AppSecret**
5. 在「版本管理与发布」中**发布应用**
6. 在目标群聊中通过「智能群助手」添加机器人

### 2. 配置项目

在工作目录下运行配置向导：

```bash
cd /path/to/your/project
qodertalk --setup --profile help
```

向导会引导你填写：
- 消息通道：选择 `1`（钉钉）
- AppKey / AppSecret：粘贴上一步复制的凭据
- systemPrompt：机器人的角色描述

生成的 `.claudetalk.json` 如下：

```json
{
  "profiles": {
    "help": {
      "channel": "dingtalk",
      "dingtalk": {
        "DINGTALK_CLIENT_ID": "你的 AppKey",
        "DINGTALK_CLIENT_SECRET": "你的 AppSecret",
        "groupPolicy": "open",
        "dmPolicy": "disabled"
      },
      "systemPrompt": "是一个系统答疑机器人，通过当前项目的工程代码和相关工具，分析和识别问题原因并答疑。"
    }
  }
}
```

**群聊/私聊策略**（在 `dingtalk` 配置块中设置）：

| 字段 | 可选值 | 默认 | 说明 |
|------|--------|------|------|
| `groupPolicy` | `open` / `allowlist` / `disabled` | `open` | 群聊消息接收策略 |
| `dmPolicy` | `open` / `allowlist` / `disabled` | `open` | 私聊消息接收策略 |
| `groupAllowFrom` | string[] | — | 群聊白名单（`groupPolicy` 为 `allowlist` 时生效），值为群 conversationId |
| `allowFrom` | string[] | — | 私聊白名单（`dmPolicy` 为 `allowlist` 时生效），值为用户 senderId |

`allowlist` 模式只接收白名单内的消息：

```json
{
  "dingtalk": {
    "DINGTALK_CLIENT_ID": "你的 AppKey",
    "DINGTALK_CLIENT_SECRET": "你的 AppSecret",
    "groupPolicy": "allowlist",
    "groupAllowFrom": ["cidxxxxx群A的conversationId", "cidxxxxx群B的conversationId"],
    "dmPolicy": "allowlist",
    "allowFrom": ["$:LWCP_v1:$用户A的senderId"]
  }
}
```

> - 群 `conversationId` 可在启动日志中查看：收到消息时会打印 `conversationId=xxx`
> - 用户 `senderId` 同样在日志中：`Received message from senderId=xxx`

答疑场景建议：群聊 `open`，私聊 `disabled`（专注群内答疑）。

### 3. 启动机器人

```bash
cd /path/to/your/project
qodertalk --profile help
```

机器人上线后会自动连接钉钉 WebSocket，开始接收群消息。

## 聊天指令

在群聊或私聊中发送以下指令管理会话：

| 指令 | 说明 |
|------|------|
| `新会话` 或 `/new` | 清空当前会话记忆，开启全新对话 |
| `清空记忆` 或 `/reset` | 同上 |
| `帮助` 或 `/help` | 显示指令帮助 |
| `重启` 或 `/restart` | 重启机器人（仅私聊生效） |

发送其他任意消息由 AI 处理。群聊中每个用户的会话独立隔离，`/new` 只清空自己的会话。

## 命令参考

```bash
# 启动机器人
qodertalk --profile help

# 交互式配置
qodertalk --setup --profile help

# 重启（通过 PID 文件发送 SIGTERM）
qodertalk --restart --profile help

# 查看帮助
qodertalk --help
```

## 工作原理

```
用户在钉钉群发消息
    ↓
WebSocket 长连接接收（无需公网 IP）
    ↓
构建上下文（历史消息 + 引用消息 + 群成员信息）
    ↓
调用 Qoder CLI 处理（qodercli）
    ↓
通过钉钉 API 回复消息
```

- **角色即主循环**：`systemPrompt` 通过 `--append-system-prompt` 注入 CLI 主循环，机器人本身就是该角色
- **工作目录感知**：CLI 在运行目录下工作，可读写项目文件
- **会话持久化**：session_id 存入 `.claudetalk-sessions.json`，重启后自动恢复
- **引用回复**：回复机器人消息时，从本地历史中补全被引用消息的完整内容（钉钉 API 只返回截断标题）

## 配置文件

### 项目级文件

| 文件 | 说明 |
|------|------|
| `.claudetalk.json` | Profile 配置（凭据、角色描述、策略） |
| `.claudetalk-sessions.json` | 会话 session 持久化（自动生成） |
| `.claudetalk/qodertalk-{profile}.pid` | 进程 PID 文件（自动管理） |
| `.claudetalk/qodertalk-*.log` | 运行日志（按天滚动） |
| `.claudetalk/dingtalk/history_{conversationId}.json` | 群聊历史记录（最多 50 条/会话） |
| `.claudetalk/dingtalk/chat-members.json` | 群成员信息（自动维护） |

### 全局配置

加 `--global` 参数可将配置写入 `~/.claudetalk/config.json`，跨目录复用：

```bash
qodertalk --setup --profile help --global
```

启动时优先读本地 `.claudetalk.json`，不存在则回退全局配置。

## 高级特性

<details>
<summary>多角色配置</summary>

同一工作目录可配置多个角色，每个角色对应独立机器人，拥有独立会话：

```json
{
  "profiles": {
    "help": {
      "channel": "dingtalk",
      "dingtalk": { "DINGTALK_CLIENT_ID": "...", "DINGTALK_CLIENT_SECRET": "..." },
      "systemPrompt": "你是答疑助手"
    },
    "pm": {
      "channel": "dingtalk",
      "dingtalk": { "DINGTALK_CLIENT_ID": "...", "DINGTALK_CLIENT_SECRET": "..." },
      "systemPrompt": "你是项目经理"
    }
  }
}
```

不指定 `--profile` 时所有角色并发启动。
</details>

<details>
<summary>每角色模型配置</summary>

在 profile 中加 `model` 字段透传给 CLI：

```json
{
  "profiles": {
    "help": {
      "channel": "dingtalk",
      "dingtalk": { "DINGTALK_CLIENT_ID": "...", "DINGTALK_CLIENT_SECRET": "..." },
      "systemPrompt": "你是答疑助手",
      "model": "claude-sonnet-4-5"
    }
  }
}
```
</details>

<details>
<summary>会话自动压缩</summary>

长跑会话超过 100 万 token（单轮实际处理总量）时，异步触发 `/compact` 压缩历史。压缩在返回结果给用户之后执行，用户无感知。同一 session 压缩期间，新消息会等待压缩完成。

日志关键字：`[compact] Starting auto compact` / `[compact] Compact done`
</details>

<details>
<summary>Session 自动迁移</summary>

修改 `systemPrompt` 后，下一条消息会检测 hash 不一致并自动清除重建 session，无需手动重启。从旧版本升级时也会自动识别并清除 legacy session。
</details>

<details>
<summary>实例锁</summary>

按 bot 凭据指纹建立全局锁，同一份凭据同一时刻只允许一个进程运行，防止消息双消费。锁文件位于 `~/.claudetalk/locks/`。
</details>

<details>
<summary>飞书渠道</summary>

ClaudeTalk 也支持飞书长连接，配置方式类似。飞书支持图片/文件消息、多 Agent 协作等更多特性，详见 [README_feishu.md](README_feishu.md)。
</details>

## License

MIT
