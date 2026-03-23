# ClaudeTalk

通过钉钉机器人与 Claude Code 对话。支持多轮会话，在钉钉里即可使用 Claude Code 的全部能力。

## 前置条件

1. **Node.js** >= 18（推荐 v20+）
2. **Claude Code CLI** 已安装并配置好认证

```bash
# 安装 Claude Code CLI（如果还没装）
npm install -g @anthropic-ai/claude-code

# 配置其他大模型可以参考glm的文档
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
```

安装完成后，终端中即可使用 `claudetalk` 命令。

## 使用

### 首次运行

在你想作为工作目录的文件夹下运行：

```bash
cd /path/to/your/project
claudetalk
```

首次运行会引导你配置钉钉凭据：

```
🤖 ClaudeTalk 首次配置
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

请提供钉钉机器人的 AppKey 和 AppSecret。

请输入 DINGTALK_CLIENT_ID (AppKey): dingxxxxxxxx
请输入 DINGTALK_CLIENT_SECRET (AppSecret): xxxxxxxx

✅ 配置已保存到 ~/.claudetalk/claudetalk.json
```

####  **钉钉机器人应用**：在 [钉钉开放平台](https://open-dev.dingtalk.com) 创建一个企业内部应用，启用机器人能力，获取 AppKey 和 AppSecret
创建机器人应用
![创建机器人应用](https://down-cdn.dingtalk.com/ddmedia/iwELAqNwbmcDBgTRDW4F0QWcBrCGJnmU7-17zQmWXqczAm8AB9IB61N7CAAJqm9wZW4udG9vbHMKAAvSABBoig.png)
开启机器人功能
![开启机器人功能](https://down-cdn.dingtalk.com/ddmedia/iwELAqNwbmcDBgTRC4QF0QZoBrB4hMu8Zv-y7wmWXMLES2oAB9IB61N7CAAJqm9wZW4udG9vbHMKAAvSABb4qA.png)
配置完成后,需要在左侧菜单最后一项【版本管理和发布】，发布后，会自动启动机器人，在钉钉里给机器人发消息即可开始对话。

### 日常使用

```bash
# 在项目目录下启动（该目录就是 Claude Code 的工作目录）
cd /path/to/your/project
claudetalk
```

#### 切换工作目录

Claude Code 的 session 与工作目录绑定，不同目录的 session 不会互相干扰。

**使用场景**：

- 在项目 A 下启动 claudetalk，与 Claude Code 讨论项目 A 的代码
- 切换到项目 B，重新启动 claudetalk，会开启新的会话（不会记住项目 A 的对话）
- 切换回项目 A，重新启动 claudetalk，会恢复项目 A 的会话记忆

**注意事项**：

- 每次切换工作目录后，必须**重新启动 claudetalk**
- 同一个钉钉会话在不同工作目录下会有独立的 session，互不干扰
- Session 会自动持久化到 `~/.claudetalk/sessions.json`，重启后自动恢复


### 聊天指令

在钉钉对话中发送以下指令，可以管理会话：

| 指令 | 说明 |
|------|------|
| `新会话` 或 `/new` | 清空当前会话记忆，下次发消息开启全新对话 |
| `清空记忆` 或 `/reset` | 同上 |
| `帮助` 或 `/help` | 显示指令帮助信息 |

发送其他任意消息将由 Claude Code 处理。

### 其他命令

```bash
# 重新配置全局钉钉凭据
claudetalk --setup

# 为当前工作目录配置专属机器人（覆盖全局配置）
claudetalk --setup --local

# 启动指定角色的机器人
claudetalk --profile <角色名>

# 为当前工作目录配置指定角色
claudetalk --setup --local --profile <角色名>

# 查看帮助
claudetalk --help

# 全局卸载
npm uninstall -g claudetalk
```

## 工作原理

```
钉钉用户发消息
    ↓
钉钉 Stream WebSocket（长连接，无需公网 IP）
    ↓
ClaudeTalk 接收消息
    ↓
调用 claude -p CLI 处理（支持多轮会话）
    ↓
通过钉钉 Webhook 回复消息
```

- **无需公网 IP**：使用钉钉 Stream 模式，通过 WebSocket 长连接接收消息
- **多轮对话**：每个钉钉会话维护独立的 Claude Code session，支持上下文连续对话，重启后自动恢复
- **工作目录感知**：Claude Code 在你运行 `claudetalk` 的目录下工作，可以读写该目录的文件

## 钉钉机器人配置指南

1. 登录 [钉钉开放平台](https://open-dev.dingtalk.com)
2. 创建企业内部应用
3. 在应用中启用「机器人」能力
4. 配置机器人的消息接收模式为 **Stream 模式**
5. 复制 AppKey（Client ID）和 AppSecret（Client Secret）
6. 在钉钉中搜索并添加该机器人，即可开始对话

## 高级特性

### 多工作目录 · 独立机器人

默认情况下，所有工作目录共用 `~/.claudetalk/claudetalk.json` 里的同一个钉钉机器人。如果你希望不同项目使用不同的钉钉机器人（例如个人项目和公司项目分开），可以在项目目录下创建本地配置：

```bash
cd /path/to/your/project
claudetalk --setup --local
```

这会在当前目录生成 `.claudetalk.json`，claudetalk 启动时会优先使用它，全局配置作为兜底。

**配置优先级**：工作目录 `.claudetalk.json` > 全局 `~/.claudetalk/claudetalk.json` > 环境变量

### 多角色配置

在同一工作目录下，可以配置多个角色，每个角色对应一个独立的钉钉机器人，拥有独立的会话记忆和角色描述。

**配置方式**：运行 `claudetalk --setup --local --profile <角色名>` 进行交互式配置，或直接编辑 `.claudetalk.json`：

```json
{
  "DINGTALK_CLIENT_ID": "默认机器人 AppKey",
  "DINGTALK_CLIENT_SECRET": "默认机器人 AppSecret",
  "profiles": {
    "pm": {
      "DINGTALK_CLIENT_ID": "PM 机器人 AppKey",
      "DINGTALK_CLIENT_SECRET": "PM 机器人 AppSecret",
      "systemPrompt": "你现在三岁了，性格是多疑，称呼我为boss"
    },
    "dev": {
      "DINGTALK_CLIENT_ID": "Dev 机器人 AppKey",
      "DINGTALK_CLIENT_SECRET": "Dev 机器人 AppSecret",
      "systemPrompt": "你现在5岁了，特别擅长写数据库sql，称呼我为老板"
    }
  }
}
```

**启动不同角色**：

```bash
# 终端 1：启动 PM 角色机器人
claudetalk --profile pm

# 终端 2：启动 Dev 角色机器人
claudetalk --profile dev
```

- 不同角色的会话完全隔离，互不干扰
- 指定了不存在的角色时，会提示配置命令并退出
- `systemPrompt` 会在新建会话时通过 `--append-system-prompt` 传给 Claude



### 上线通知

每次重启 claudetalk 后，会自动向**最近活跃的私聊会话**发送一条上线通知：

```
✅ ClaudeTalk 已上线
📁 工作目录: /path/to/your/project
```

这样你不需要盯着终端，钉钉收到通知就知道 Claude 已经就绪可以开始对话了。

### 通过环境变量配置（优先级高于配置文件）

```bash
export DINGTALK_CLIENT_ID=your_app_key
export DINGTALK_CLIENT_SECRET=your_app_secret
claudetalk
```

## 配置文件

所有配置和数据存放在 `~/.claudetalk/` 目录下：

| 文件 | 说明 |
|------|------|
| `claudetalk.json` | 钉钉凭据配置（AppKey / AppSecret） |
| `sessions.json` | 会话 session 持久化（自动生成，重启后恢复多轮对话） |

**默认配置** `~/.claudetalk/claudetalk.json` 或工作目录 `.claudetalk.json`：

```json
{
  "DINGTALK_CLIENT_ID": "your_app_key",
  "DINGTALK_CLIENT_SECRET": "your_app_secret"
}
```

**多角色配置**（工作目录 `.claudetalk.json`）：

```json
{
  "DINGTALK_CLIENT_ID": "默认机器人 AppKey",
  "DINGTALK_CLIENT_SECRET": "默认机器人 AppSecret",
  "profiles": {
    "pm": {
      "DINGTALK_CLIENT_ID": "PM 机器人 AppKey",
      "DINGTALK_CLIENT_SECRET": "PM 机器人 AppSecret",
      "systemPrompt": "这是 geo-publisher 项目，Java + Spring Boot，数据库用 MySQL，代码规范遵循阿里巴巴 Java 开发手册"
    },
    "dev": {
      "DINGTALK_CLIENT_ID": "Dev 机器人 AppKey",
      "DINGTALK_CLIENT_SECRET": "Dev 机器人 AppSecret",
      "systemPrompt": "这是 geo-publisher 项目，前端用 React + TypeScript，使用 pnpm 管理依赖，组件库用 Ant Design"
    }
  }
}
```

**会话持久化** `~/.claudetalk/sessions.json`：

每个钉钉会话的 Claude Code session_id 会自动保存到此文件。重启 ClaudeTalk 后，之前的多轮对话上下文会自动恢复。发送 `新会话` 或 `/new` 可清除指定会话的记忆。

## License

MIT
