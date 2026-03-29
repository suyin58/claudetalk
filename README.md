# ClaudeTalk

通过钉钉或 Discord 机器人与 Claude Code 对话。支持多轮会话，在聊天工具里即可使用 Claude Code 的全部能力。

## 前置条件

1. **Node.js** >= 18（推荐 v20+）
2. **Claude Code CLI** 已安装并配置好认证

```bash
# 安装 Claude Code CLI（如果还没装）
npm install -g @anthropic-ai/claude-code

# 配置其他大模型可以参考 GLM 的文档
https://docs.bigmodel.cn/cn/coding-plan/tool/claude
```

## 安装

```bash
# 1. 克隆仓库
git clone https://github.com/suyin58/claudetalk.git

# 2. 进入目录
cd claudetalk

# 3. 安装依赖
npm install

# 4. 构建
npm run build

# 5. 全局安装（注册 claudetalk 命令）
npm link


# *** 全局卸载(如果不在使用的话) ***
npm uninstall -g claudetalk
```

安装完成后，终端中即可使用 `claudetalk` 命令。

## 使用

### 首次配置

在你想作为工作目录的文件夹下运行配置向导：

```bash
cd /path/to/your/project
claudetalk --setup
```

如果不指定 `--profile`，会自动创建名为 `default` 的默认角色。也可以手动指定角色名：

```bash
claudetalk --setup --profile pm
```

配置向导会引导你选择消息通道（钉钉或 Discord）并填写对应凭据：

```
🤖 ClaudeTalk 配置向导
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎭 角色: pm
📁 配置文件: ./.claudetalk.json

📡 消息通道选择:
   1. dingtalk - 钉钉机器人
   2. discord  - Discord 机器人
请选择 (1/2): 1

🔑 钉钉机器人配置
DINGTALK_CLIENT_ID (AppKey): dingxxxxxxxx
DINGTALK_CLIENT_SECRET (AppSecret): xxxxxxxx

📝 角色描述（可选）
systemPrompt: 你是产品经理，负责需求分析

🤖 SubAgent 配置（可选）
是否配置 SubAgent？(Y/n): n

✅ 角色 [pm] 配置已保存到 ./.claudetalk.json
```

### 日常使用

```bash
# 在项目目录下启动机器人（使用默认角色）
cd /path/to/your/project
claudetalk

# 或指定角色名启动
claudetalk --profile pm
```

### 聊天指令

在对话中发送以下指令，可以管理会话：

| 指令 | 说明 |
|------|------|
| `新会话` 或 `/new` | 清空当前会话记忆，下次发消息开启全新对话 |
| `清空记忆` 或 `/reset` | 同上 |
| `帮助` 或 `/help` | 显示指令帮助信息 |

发送其他任意消息将由 Claude Code 处理。

### 命令参考

```bash
# 启动机器人（使用默认角色，或配置中唯一的角色）
claudetalk

# 启动指定角色的机器人
claudetalk --profile <角色名>

# 配置当前目录默认角色
claudetalk --setup

# 配置当前目录指定角色
claudetalk --setup --profile <角色名>

# 查看帮助
claudetalk --help
```

## 工作原理

```
用户在钉钉/Discord 发消息
    ↓
Channel WebSocket 长连接接收（无需公网 IP）
    ↓
ClaudeTalk 接收消息
    ↓
调用 claude -p CLI 处理（支持多轮会话）
    ↓
通过对应 Channel 回复消息
```

- **无需公网 IP**：钉钉使用 Stream 模式，Discord 使用 Gateway，均通过 WebSocket 长连接接收消息
- **多轮对话**：每个会话维护独立的 Claude Code session，支持上下文连续对话，重启后自动恢复
- **工作目录感知**：Claude Code 在你运行 `claudetalk` 的目录下工作，可以读写该目录的文件

## 钉钉机器人配置指南

1. 登录 [钉钉开放平台](https://open-dev.dingtalk.com)
2. 创建企业内部应用
3. 在应用中启用「机器人」能力
4. 配置机器人的消息接收模式为 **Stream 模式**
5. 复制 AppKey（Client ID）和 AppSecret（Client Secret）

创建机器人应用
![创建机器人应用](https://down-cdn.dingtalk.com/ddmedia/iwELAqNwbmcDBgTRDW4F0QWcBrCGJnmU7-17zQmWXqczAm8AB9IB61N7CAAJqm9wZW4udG9vbHMKAAvSABBoig.png)
开启机器人功能
![开启机器人功能](https://down-cdn.dingtalk.com/ddmedia/iwELAqNwbmcDBgTRC4QF0QZoBrB4hMu8Zv-y7wmWXMLES2oAB9IB61N7CAAJqm9wZW4udG9vbHMKAAvSABb4qA.png)

配置完成后，在左侧菜单【版本管理和发布】发布后，在钉钉里给机器人发消息即可开始对话。

## Discord 机器人配置指南

1. 登录 [Discord Developer Portal](https://discord.com/developers/applications)
2. 创建新应用，进入 Bot 页面
3. 开启 **MESSAGE CONTENT INTENT**（必须，否则无法读取消息内容）
4. 复制 Bot Token
5. 将 Bot 邀请到你的服务器

## 高级特性

### 多角色配置

在同一工作目录下，可以配置多个角色，每个角色对应一个独立的机器人（可以是不同 Channel），拥有独立的会话记忆和角色描述。

**配置方式**：运行 `claudetalk --setup --profile <角色名>` 进行交互式配置，或直接编辑 `.claudetalk.json`：

```json
{
  "profiles": {
    "pm": {
      "channel": "dingtalk",
      "dingtalk": {
        "DINGTALK_CLIENT_ID": "PM 机器人 AppKey",
        "DINGTALK_CLIENT_SECRET": "PM 机器人 AppSecret"
      },
      "systemPrompt": "你是产品经理，负责需求分析和文档编写"
    },
    "dev": {
      "channel": "discord",
      "discord": {
        "TOKEN": "Dev 机器人 Bot Token"
      },
      "systemPrompt": "你是全栈工程师，擅长 SQL 编写和架构设计"
    }
  }
}
```

**启动不同角色**：

```bash
# 终端 1：启动 PM 角色（钉钉）
claudetalk --profile pm

# 终端 2：启动 Dev 角色（Discord）
claudetalk --profile dev
```

- 不同角色的会话完全隔离，互不干扰
- 指定了不存在的角色时，会提示配置命令并退出

### SubAgent 精细化角色控制

> 这是 Claude Code 的原生 SubAgent 机制，适合需要**精细权限控制**或**指定模型**的场景。

在配置角色时，可以选择启用 SubAgent 模式。启用后，ClaudeTalk 会将角色配置通过 Claude Code 的 `--agents` 参数传入，Claude Code 会自动委托给对应的 SubAgent 处理消息。

**SubAgent 相比 systemPrompt 的优势**：
- 独立的上下文窗口，不占用主会话 token
- 可以为不同角色指定不同模型（如 PM 用 Haiku 节省成本，Dev 用 Sonnet 保证质量）
- 可以精细控制每个角色的工具权限（如 PM 只读，Dev 可写）

**启用方式**：运行 `claudetalk --setup --profile <角色名>` 时，在 SubAgent 配置引导中选择 `Y`：

```
🤖 SubAgent 配置（可选）
是否配置 SubAgent？(Y/n): Y
  📦 模型选择：
     1. claude-opus-4-5    - 最强推理
     2. claude-sonnet-4-5  - 均衡性能（推荐）
     3. claude-haiku-4-5   - 速度最快
  请输入选项 (1-4，直接回车使用默认): 2

✅ 角色 [pm] 配置已保存到 ./.claudetalk.json
✅ SubAgent 文件已创建: ./.claude/agents/pm.md
```

配置后，`.claudetalk.json` 中会增加 SubAgent 相关字段：

```json
{
  "profiles": {
    "pm": {
      "channel": "dingtalk",
      "dingtalk": {
        "DINGTALK_CLIENT_ID": "PM 机器人 AppKey",
        "DINGTALK_CLIENT_SECRET": "PM 机器人 AppSecret"
      },
      "systemPrompt": "你是产品经理，负责需求分析和文档编写",
      "subagentEnabled": true,
      "subagentModel": "claude-sonnet-4-5"
    }
  }
}
```

**配置变化自动生效**：修改配置后，下一条消息会自动检测到变化并重建会话，无需手动重启。

### 切换工作目录

Claude Code 的 session 与工作目录绑定，不同目录的 session 不会互相干扰。

- 在项目 A 下启动 claudetalk，与 Claude Code 讨论项目 A 的代码
- 切换到项目 B，重新启动 claudetalk，会开启新的会话
- 切换回项目 A，重新启动 claudetalk，会恢复项目 A 的会话记忆

每次切换工作目录后，必须**重新启动 claudetalk**。

### 上线通知

每次重启 claudetalk 后，会自动向**最近活跃的私聊会话**发送一条上线通知：

```
✅ ClaudeTalk 已上线
📁 工作目录: /path/to/your/project
```

## 配置文件

所有配置和数据存放在 `~/.claudetalk/` 目录下：

| 文件 | 说明 |
|------|------|
| `claudetalk.json` | 全局配置（兜底） |
| `sessions.json` | 会话 session 持久化（自动生成，重启后恢复多轮对话） |

**配置优先级**：工作目录 `.claudetalk.json` > 全局 `~/.claudetalk/claudetalk.json`

**配置文件格式**（工作目录 `.claudetalk.json`）：

```json
{
  "profiles": {
    "pm": {
      "channel": "dingtalk",
      "dingtalk": {
        "DINGTALK_CLIENT_ID": "PM 机器人 AppKey",
        "DINGTALK_CLIENT_SECRET": "PM 机器人 AppSecret"
      },
      "systemPrompt": "你是产品经理，负责需求分析",
      "subagentEnabled": true,
      "subagentModel": "claude-sonnet-4-5"
    },
    "dev": {
      "channel": "discord",
      "discord": {
        "TOKEN": "Dev 机器人 Bot Token",
        "GUILD_ID": "可选，限定服务器 ID"
      },
      "systemPrompt": "你是全栈工程师，擅长 SQL 编写"
    }
  }
}
```

**会话持久化** `~/.claudetalk/sessions.json`：

每个会话的 Claude Code session_id 会自动保存到此文件。重启 ClaudeTalk 后，之前的多轮对话上下文会自动恢复。发送 `新会话` 或 `/new` 可清除指定会话的记忆。

## License

MIT
