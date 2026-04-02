# ClaudeTalk

通过钉钉或飞书机器人与 Claude Code 对话。支持多轮会话，在聊天工具里即可使用 Claude Code 的全部能力。

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
配置向导会引导你选择消息通道（钉钉或飞书）并填写对应凭据：

```
🤖 ClaudeTalk 配置向导
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎭 角色：pm
📁 配置文件：./.claudetalk.json

📡 消息通道选择:
   1. dingtalk - 钉钉机器人
   2. feishu   - 飞书机器人
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
# 在项目目录下启动机器人（自动启动配置文件中的所有角色）
cd /path/to/your/project
claudetalk

# 或只启动指定角色
claudetalk --profile pm
```

不指定 `--profile` 时，ClaudeTalk 会读取 `.claudetalk.json` 中的所有 profile，**并发启动全部角色**，每个角色的日志会带上 `[角色名]` 前缀加以区分。如果配置文件中没有任何 profile，会提示你先运行 `claudetalk --setup` 进行配置。

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
# 启动机器人（自动启动配置中的所有角色，每个角色日志带 [角色名] 前缀）
claudetalk

# 只启动指定角色的机器人
claudetalk --profile <角色名>

# 配置当前目录默认角色（交互式）
claudetalk --setup

# 配置当前目录指定角色（交互式）
claudetalk --setup --profile <角色名>

# 批量自动配置多个角色（根据 ~/.claudetalk/agent_auto_config.json）
claudetalk --setup auto

# 编辑已有角色配置（从列表选择，支持修改 profile 名称）
claudetalk --setup edit

# 查看帮助
claudetalk --help
```

## 工作原理

```
用户在钉钉/飞书发消息
    ↓
Channel WebSocket 长连接接收（无需公网 IP）
    ↓
ClaudeTalk 接收消息
    ↓
调用 claude -p CLI 处理（支持多轮会话）
    ↓
通过对应 Channel 回复消息
```

- **无需公网 IP**：钉钉使用 Stream 模式，飞书使用长连接，均通过 WebSocket 长连接接收消息
- **多轮对话**：每个会话维护独立的 Claude Code session，支持上下文连续对话，重启后自动恢复
- **工作目录感知**：Claude Code 在你运行 `claudetalk` 的目录下工作，可以读写该目录的文件

## 机器人配置

ClaudeTalk 支持多种消息通道，选择你需要的通道进行配置：

- [📱 钉钉机器人配置](README_dingtalk.md) - 使用钉钉 Stream 模式接收消息
- [💬 飞书机器人配置](README_feishu.md) - 使用飞书长连接接收消息


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
      "channel": "feishu",
      "feishu": {
        "FEISHU_APP_ID": "Dev 机器人 App ID",
        "FEISHU_APP_SECRET": "Dev 机器人 App Secret"
      },
      "systemPrompt": "你是全栈工程师，擅长 SQL 编写和架构设计"
    }
  }
}
```

**启动方式**：

```bash
# 一键启动所有角色（推荐）
claudetalk

# 只启动指定角色
claudetalk --profile pm
```

- 不指定 `--profile` 时，所有角色**并发启动**，每条日志带 `[角色名]` 前缀区分
- 不同角色的会话完全隔离，互不干扰
- 指定了不存在的角色时，会提示配置命令并退出

### 多模态输入支持

ClaudeTalk 支持接收图片消息并传递给 Claude 进行分析。不同 Channel 的支持情况如下：

#### Channel 能力对比

| 消息类型 | 飞书 | 钉钉 |
|---------|------|------|
| 文字消息 | ✅ | ✅ |
| 图片消息 | ✅ 下载到本地，告知 Claude 路径 | ❌ 不支持 |
| 文字 + 图片（富文本） | ✅ 提取文字和图片，一并传给 Claude | ❌ 不支持 |
| 文件消息（txt/pdf/代码等） | ✅ 下载到本地，告知 Claude 路径 | ❌ 不支持 |
| 历史消息中的图片/文件 | ✅ 自动下载并替换为本地路径 | ❌ 钉钉无历史消息 API |
| 语音、视频 | ❌ 回复"暂不支持该类型" | ❌ 回复"暂不支持该类型" |

#### 飞书图片/文件处理说明

图片和文件下载到本地后，分别以 `[图片: /path/to/image.jpg]` 和 `[文件: /path/to/file.txt]` 的形式告知 Claude，Claude 会自动用 Read 工具读取内容进行分析。

- **图片**：以 `image_key` 为唯一标识缓存，保存在 `.claudetalk/feishu/images/` 下
- **文件**：以 `file_key` 为唯一标识缓存，保存在 `.claudetalk/feishu/files/` 下，文件名保留原始后缀
- 同一张图片/文件无论出现在实时消息还是历史消息中，只下载一次

**纯图片/文件消息的特殊处理**：

用户只发图片或文件（不带文字）时，机器人不会立即调用 Claude，而是将其缓存并等待后续指令：

```
用户发送一张图片（或一个文件）
  → 📎 已收到（共 1 个文件/图片），请继续发送指令。

用户发送"帮我分析这张图"
  → Claude 收到：帮我分析这张图 + 图片/文件路径，进行分析并回复
```

- 支持连续发多张图片/文件后再发指令，会按发送顺序全部传给 Claude
- 群聊中不同用户的缓存相互独立，不会混淆

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

### 飞书机器人间协作（Peer Message）

> 仅飞书 Channel 支持，解决飞书平台限制：机器人无法收到其他机器人发送的消息。

当多个 ClaudeTalk 实例运行在**同一台机器**上时，机器人之间可以通过共享文件（`.claudetalk/bot_{机器人名称}.json`）实现协作：

**工作流程**：

```
用户 @ PM 机器人 → PM 机器人处理后，回复中 @ 前端开发机器人
                                        ↓ 发送成功后
                          写入 .claudetalk/bot_前端开发.json
                                        ↓ 10秒后
                          前端开发机器人轮询到消息
                                        ↓
                          给原消息回复 👌 表情（表示收到）
                                        ↓
                          走 Claude CLI 流程处理并回复
```

**触发条件**：机器人发送的消息中包含 `<at user_id="cli_xxx">机器人名称</at>` 格式的 @标签，且被@的机器人在 `chat-members.json` 中有记录。

**注意**：
- 多个机器人实例需运行在同一台机器上，共享同一个工作目录
- 多个机器人必须在**同一个飞书群**中，协作消息才能正确路由
- 被@的机器人名称（飞书 app_name）即为 peer-message 文件的命名依据
- 消息写入后 10 秒才会被消费（给机器人发消息留出时间）

## 配置文件

### 项目配置目录

所有项目级配置统一存放在工作目录的 `.claudetalk/` 目录下：

| 文件 | 说明 |
|------|------|
| `.claudetalk.json` | Profile 配置（Channel 凭据、角色描述等） |
| `.claudetalk/feishu/chat-members.json` | 飞书群成员信息（自动积累，用于 @功能） |
| `.claudetalk/feishu/images/` | 飞书图片消息下载缓存目录（可按需清理） |
| `.claudetalk/bot_{名称}.json` | 飞书机器人间协作消息队列（自动生成） |
| `.claudetalk-sessions.json` | 会话 session 持久化（自动生成，重启后恢复多轮对话） |

SubAgent 配置文件遵循 Claude Code 标准目录：

| 文件 | 说明 |
|------|------|
| `.claude/agents/{profile}.md` | SubAgent 定义文件（启用 SubAgent 时自动生成） |

**配置优先级**：工作目录 `.claudetalk.json` > 全局 `~/.claudetalk/claudetalk.json`

### 配置文件格式

工作目录 `.claudetalk.json`：

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
      "channel": "feishu",
      "feishu": {
        "FEISHU_APP_ID": "Dev 机器人 App ID",
        "FEISHU_APP_SECRET": "Dev 机器人 App Secret"
      },
      "systemPrompt": "你是全栈工程师，擅长 SQL 编写和架构设计"
    }
  }
}
```

### 会话持久化

每个会话的 Claude Code session_id 会自动保存到 `.claudetalk-sessions.json`。重启 ClaudeTalk 后，之前的多轮对话上下文会自动恢复。发送 `新会话` 或 `/new` 可清除指定会话的记忆。

## License

MIT
