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
配置完成后会自动启动机器人，在钉钉里给机器人发消息即可开始对话。

### 日常使用

```bash
# 在项目目录下启动（该目录就是 Claude Code 的工作目录）
cd /path/to/your/project
claudetalk
```


### 其他命令

```bash
# 重新配置钉钉凭据
claudetalk --setup

# 查看帮助
claudetalk --help

# 全局卸载
npm uninstall -g claudetalk
```

### 通过环境变量配置（优先级高于配置文件）

```bash
export DINGTALK_CLIENT_ID=your_app_key
export DINGTALK_CLIENT_SECRET=your_app_secret
claudetalk
```

## 配置文件

配置文件路径：`~/.claudetalk/claudetalk.json`

```json
{
  "DINGTALK_CLIENT_ID": "your_app_key",
  "DINGTALK_CLIENT_SECRET": "your_app_secret"
}
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
- **多轮对话**：每个钉钉会话维护独立的 Claude Code session，支持上下文连续对话
- **工作目录感知**：Claude Code 在你运行 `claudetalk` 的目录下工作，可以读写该目录的文件

## 钉钉机器人配置指南

1. 登录 [钉钉开放平台](https://open-dev.dingtalk.com)
2. 创建企业内部应用
3. 在应用中启用「机器人」能力
4. 配置机器人的消息接收模式为 **Stream 模式**
5. 复制 AppKey（Client ID）和 AppSecret（Client Secret）
6. 在钉钉中搜索并添加该机器人，即可开始对话

## License

MIT
