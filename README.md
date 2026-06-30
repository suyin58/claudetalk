# ClaudeTalk
一个通过角色分工 × 群聊协商，透明可干预的多agent协作框架。

1）以 IM 群聊作为消息总线，Agent 之间通过 @ 消息传递任务，用户可以随时干预； 
2）以 Claude Code 或 Qoder CLI 作为每个角色的执行引擎，通过 `claudetalk` / `qodertalk` 命令选择引擎，支持为不同 Agent 独立配置 Prompt 和模型； 
3）三层记忆机制保证记忆不丢失、减少 Token 消耗、避免上下文腐烂；
4）项目监督者自动检测群内任务停滞并补 @ 跳转，避免多 Agent 协作链路因漏 @ 而中断。

> ⚠️ **多个机器人同时在线不建议使用钉钉**：多个机器人实例同时运行时经常出现消息丢失、收不到消息等问题，多轮测试调整后，应该是钉钉的问题，无法通过代码解决，如果只启动一个agent的话，可以用钉钉，如果你需要多 Agent 协作，请优先选择飞书。

## 前置条件

1. **Node.js** >= 18（推荐 v20+）
2. **Claude Code CLI** 或 **Qoder CLI** 已安装并配置好认证（二选一即可）

```bash
# 安装 Claude Code CLI（如果还没装）
npm install -g @anthropic-ai/claude-code

# 配置其他大模型可以参考 GLM 的文档
https://docs.bigmodel.cn/cn/coding-plan/tool/claude

# 或者安装 Qoder CLI
# 安装文档: https://docs.qoder.com/zh/cli/quick-start
```

## 安装

```bash

# *** 全局卸载(如果不在使用的话) ***
npm uninstall -g claudetalk

# 1. 克隆仓库
git clone https://github.com/suyin58/claudetalk.git

# 2. 进入目录
cd claudetalk

# 3. 安装依赖
npm install

# 4. 构建
npm run build

# 5. 全局安装（注册 claudetalk 和 qodertalk 命令）
npm link


```

安装完成后，终端中即可使用 `claudetalk` 和 `qodertalk` 命令。两个命令共享同一份配置和代码，区别在于底层调用的 CLI 引擎不同：

| 命令 | 底层引擎 | 权限跳过参数 |
|------|---------|-------------|
| `claudetalk` | Claude Code CLI（`claude`） | `--dangerously-skip-permissions` |
| `qodertalk` | Qoder CLI（`qodercli`） | `--yolo` |

## 使用

### 首次配置

ClaudeTalk 支持两种配置范围：

| 范围 | 写入位置 | 适用场景 |
|------|---------|---------|
| **本地（默认）** | `{工作目录}/.claudetalk.json` | 配置只对该项目生效；不同项目用不同 bot |
| **全局**（加 `--global`） | `~/.claudetalk/config.json` | 多个项目目录复用同一份 bot 配置，不必每次重新填 |

启动时本地优先，没本地才回退全局；**本地存在时只用本地，不与全局合并**。启动 banner 会显示当前实际使用的配置文件路径。

**本地配置**（在项目目录下）：

```bash
cd /path/to/your/project
claudetalk --setup                    # 默认角色（default）
claudetalk --setup --profile pm       # 指定角色名
claudetalk --setup auto               # 批量配置多个角色（向导）
```

**全局配置**（一次配好，多目录复用）：

```bash
claudetalk --setup auto --global      # 写到 ~/.claudetalk/config.json
claudetalk --setup edit --global      # 编辑已有全局配置
```

如果不指定 `--profile`，会自动创建名为 `default` 的默认角色。也可以手动指定角色名：

```bash
claudetalk --setup --profile pm
```

配置向导会引导你选择消息通道（钉钉或飞书）并填写对应凭据：

```
🤖 ClaudeTalk 配置向导
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎭 角色：pm
📁 配置文件：./.claudetalk.json (本地)

📡 消息通道选择:
   1. dingtalk - 钉钉机器人
   2. feishu   - 飞书机器人
请选择 (1/2): 1
🔑 钉钉机器人配置
DINGTALK_CLIENT_ID (AppKey): dingxxxxxxxx
DINGTALK_CLIENT_SECRET (AppSecret): xxxxxxxx

📝 角色描述（可选）
systemPrompt: 你是产品经理，负责需求分析

🎯 项目监督者（可选）
是否将 [pm] 设为项目监督者？(y/N): n

✅ 角色 [pm] 配置已保存到 (本地): ./.claudetalk.json
```

> 角色身份通过 Claude Code 的 `--append-system-prompt` 注入主循环，机器人**本身就是该角色**——不再使用 SubAgent 调度模式。这意味着回复直接以本人口吻输出，不会有 "我已通过 X subagent 完成" 之类的元描述。详见下文「工作原理」。

### 日常使用

```bash
# 在项目目录下启动机器人（自动启动配置文件中的所有角色）
cd /path/to/your/project
claudetalk          # 使用 Claude Code CLI 作为引擎
qodertalk           # 使用 Qoder CLI 作为引擎

# 或只启动指定角色
claudetalk --profile pm
qodertalk --profile pm
```

> `claudetalk` 和 `qodertalk` 的参数完全一致，配置文件也共享（`.claudetalk.json`），仅底层调用的 CLI 不同。配置时使用任一命令的 `--setup` 均可。

不指定 `--profile` 时，ClaudeTalk 会读取 `.claudetalk.json` 中的所有 profile，**并发启动全部角色**，每个角色的日志会带上 `[角色名]` 前缀加以区分。如果配置文件中没有任何 profile，会提示你先运行 `claudetalk --setup` 进行配置。

### 聊天指令

在对话中发送以下指令，可以管理会话：

| 指令 | 说明 | 适用场景 |
|------|------|---------|
| `新会话` 或 `/new` | 清空当前会话记忆，下次发消息开启全新对话 | 单聊 / 群聊 |
| `清空记忆` 或 `/reset` | 同上 | 单聊 / 群聊 |
| `重启` 或 `/restart` | 重启 ClaudeTalk 机器人 | **仅限单聊** |
| `帮助` 或 `/help` | 显示指令帮助信息 | 单聊 / 群聊 |

> ⚠️ **重启指令仅限单聊**：`/restart` 和 `重启` 指令只在私聊会话中生效，群聊中发送会被忽略，防止被误触发。

发送其他任意消息将由 Claude Code 处理。

### 命令参考

> 以下所有命令中的 `claudetalk` 均可替换为 `qodertalk`，参数和行为完全一致，仅底层引擎不同。

```bash
# 启动机器人（自动启动配置中的所有角色，每个角色日志带 [角色名] 前缀）
claudetalk

# 只启动指定角色的机器人
claudetalk --profile <角色名>

# 配置当前目录默认角色（交互式）
claudetalk --setup

# 配置当前目录指定角色（交互式）
claudetalk --setup --profile <角色名>

# 批量自动配置多个角色（根据 dist/template/agent_auto_config.json 模板）
claudetalk --setup auto

# 编辑已有角色配置（从列表选择，支持修改 profile 名称）
claudetalk --setup edit

# 单独将协作规范模板写入项目 CLAUDE.md（创建或追加）
claudetalk --setup claude

# === 全局配置 ===（写到 ~/.claudetalk/config.json，跨工作目录复用）
claudetalk --setup auto --global
claudetalk --setup edit --global

# 重启机器人（通过 PID 文件发送 SIGTERM 信号）
claudetalk --restart

# 重启指定角色的机器人
claudetalk --restart --profile <角色名>

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
根据启动命令调用对应 CLI（claudetalk→claude / qodertalk→qodercli）
    ↓
通过对应 Channel 回复消息
```

- **无需公网 IP**：钉钉使用 Stream 模式，飞书使用长连接，均通过 WebSocket 长连接接收消息
- **双引擎支持**：通过 `claudetalk` 启动时调用 Claude Code CLI，通过 `qodertalk` 启动时调用 Qoder CLI，两者共享同一份配置和会话，无需在 profile 中指定引擎
- **多轮对话**：每个会话维护独立的 CLI session，支持上下文连续对话，重启后自动恢复
- **工作目录感知**：CLI 在你运行 `claudetalk` / `qodertalk` 的目录下工作，可以读写该目录的文件
- **角色即主循环**：profile 的 `systemPrompt` 通过 `--append-system-prompt` 注入到 CLI 主循环，机器人本身就是该角色（不通过 SubAgent 调度，回复就是本人口吻）
- **可选模型覆盖**：profile 配置里加 `model` 字段会透传给 `claude --model` / `qodercli --model`，让不同 bot 跑不同模型（如 PM 用 Haiku 省成本，Dev 用 Sonnet 保质量）
- **session 自动迁移**：systemPrompt 改了下次消息自动重建 session；从老版本（SubAgent 模式）升级会自动清除 legacy session 一次性迁移

## 机器人配置

ClaudeTalk 支持多种消息通道，选择你需要的通道进行配置：

- [💬 飞书机器人配置](README_feishu.md) - 使用飞书长连接接收消息（**推荐**）
- [📱 钉钉机器人配置](README_dingtalk.md) - 使用钉钉 Stream 模式接收消息（⚠️ 消息推送不稳定，不建议多 Agent 场景使用）


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

### 角色身份注入与每角色模型

每个 profile 启动后是一个独立的 CLI 主循环进程，角色身份通过 CLI 参数注入：

| 字段 | 注入方式 | 作用 |
|------|---------|------|
| `systemPrompt` | `claude --append-system-prompt <prompt>` / `qodercli --append-system-prompt <prompt>` | 把角色定义追加到主循环的 system prompt，主循环本身就是该角色，直接以本人口吻回复 |
| `model`（可选） | `claude --model <id>` / `qodercli --model <id>` | 指定该 profile 用的模型，不填走 CLI 默认 |

> 历史说明：早期版本通过 SubAgent 调度（`--agents` JSON）实现角色控制，但主循环会做"我已通过 X 子代理完成"的元包装，使群聊回复语义错位。当前实现废弃 SubAgent 模式，让主循环直接扮演角色。`subagentEnabled` / `subagentModel` / `subagentPermissions` 三个字段已从 schema 移除；老配置里残留这些字段会被忽略（无副作用，可手动清掉）。

**示例**（pm 用 sonnet，dev 用 haiku 省成本）：

```json
{
  "profiles": {
    "pm": {
      "channel": "dingtalk",
      "dingtalk": { "DINGTALK_CLIENT_ID": "...", "DINGTALK_CLIENT_SECRET": "..." },
      "systemPrompt": "你是产品经理，负责需求分析和文档编写",
      "model": "claude-sonnet-4-5"
    },
    "dev": {
      "channel": "feishu",
      "feishu": { "FEISHU_APP_ID": "...", "FEISHU_APP_SECRET": "..." },
      "systemPrompt": "你是全栈工程师",
      "model": "claude-haiku-4-5"
    }
  }
}
```

**session 自动迁移**：
- 改 `systemPrompt` 后下一条消息会触发漂移检测（基于 systemPrompt hash），自动清除并重建 session，无需手动重启
- 从旧版本（带 `subagentEnabled` 字段的 SessionEntry）升级时，会在第一次 resume 时识别为 legacy session 并清除重建一次

### 跨频道的 @ 抽象：`Channel.formatMention()`

不同 IM 的 @ 标签格式差异由 `Channel.formatMention(target)` 统一封装，业务层只关心"@ 哪个角色"，不需要管底层标签语法：

| Channel | `formatMention` 产物 | 路由匹配 |
|---|---|---|
| feishu | `<at user_id="cli_xxx">显示名</at>` （bot 优先 appId，降级 openId） | peer-message 路由按 appId 主匹配 + name 模糊兜底 |
| dingtalk | `@profileName` 文本 | sendMessage 内再展开为 `<at id=...>` |

**feishu 群消息出口的纯文本 @ 兜底**：所有 `sendMessage(isGroup=true)` 都会过 `autoConvertPlainAtTags` —— LLM 写 `@front` 或 `@前端工程师` 时会自动转换为正确的 `<at>` 标签，避免出现普通文字 @ 不生效的情况。

### 共享的 context 模板（直接消息 / peer-message 都走）

`buildContextMessage` 接收 primitives（chatId、senderOpenId、currentMessageId、mentions、messageText），不依赖底层 event 对象。两条入口路径都用它：

| 触发路径 | 上下文 |
|---|---|
| 直接在群里 @ bot | ✅ 含群成员表（at_id 映射）、6 条历史、sender 信息 |
| peer-message 转发（其他 bot @ 过来） | ✅ 同上 —— 让被 @ 的 bot 也能看到群里有谁、上下文是什么，按 CLAUDE.md @ 规范正确汇报回项目经理 |

> 上述"两条路径都走 buildContextMessage"**目前仅飞书成立**。钉钉的直接 @ 路径也走 buildContextMessage，但钉钉的 peer-message 转发只透传原始消息文本（不含群成员表/历史/sender 信息）。

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

💡 常用指令：
  /new 或 新会话 — 清空会话记忆
  /reset 或 清空记忆 — 同上
  /restart 或 重启 — 重启机器人（仅私聊）
  /help 或 帮助 — 查看全部指令
```

### 机器人间协作（Peer Message）

当多个 ClaudeTalk 实例运行在**同一台机器**上时，机器人之间可以通过共享文件实现协作，解决 IM 平台限制（机器人无法收到其他机器人发送的消息）。

**工作流程**：

```
用户 @ PM 机器人 → PM 机器人处理后，回复中 @ 前端开发机器人
                                        ↓ 发送成功后
                          写入 .claudetalk/{channel}/bot_front.json
                                        ↓ 每 5 秒轮询一次（仅消费写入满 10 秒的消息）
                          前端开发机器人轮询到消息
                                        ↓
                          走 Claude CLI 流程处理并回复
```

**@ 机器人的格式**（由 [`Channel.formatMention()`](#跨频道的--抽象channelformatmention) 统一生成，无需手写）：

| Channel | @ 格式 | 路由匹配 |
|---------|--------|------|
| 飞书 | `<at user_id="cli_xxx">机器人名称</at>` | peer-message 路由按 `appId` 主匹配 → `name` 模糊兜底；@ 标签的 user_id 优先 appId，降级 openId |
| 钉钉 | `@profileName`（如 `@front`） | 文本格式，sendMessage 会自动展开为 `<at id=front>前端开发工程师</at>` 展示 |

> 即便 LLM 偶尔写出纯文本 `@profileName` / `@显示名`，飞书 `sendMessage(isGroup)` 会兜底转成 `<at>` 标签发出，避免出现普通文字 @ 不生效的情况。

**注意**：
- 多个机器人实例需运行在同一台机器上，共享同一个工作目录
- 多个机器人必须在**同一个群**中，协作消息才能正确路由
- 每 5 秒轮询一次协作队列，但只消费写入满 10 秒的消息（给机器人发消息留出时间）
- ⚠️ **钉钉限制**：钉钉平台消息推送不稳定，多机器人场景下经常出现消息丢失，不建议在钉钉上使用多 Agent 协作

### 实例锁（防止消息双消费）

ClaudeTalk 启动时会按 **bot 凭据指纹** 建立全局运行时锁，**同一份 bot 凭据在任意时刻只允许一个 ClaudeTalk 进程运行**——不论是同一个工作目录、还是不同工作目录用了同一份全局配置。

- 锁文件位置：`~/.claudetalk/locks/{channel}-{sha256(credential).slice(0,12)}.lock`
- 凭据用 sha256 截断指纹，不落明文
- 第二个进程尝试用相同 bot 启动时会被拦下，错误信息显示已有进程的 PID、工作目录、角色、启动时间
- 上一个进程被 SIGKILL 未清理锁时，下一次启动会自动探活（`process.kill(pid, 0)`）并覆盖 stale lock

冲突示例：

```
❌ 该 bot 已在以下位置运行，不能同时启动多个实例（避免消息双消费）：
   PID:        12345
   工作目录:   /path/to/proj-a
   角色:       pm
   Channel:    feishu
   启动时间:   2026-06-01T03:21:08.123Z

💡 请先在该目录运行 `claudetalk --restart` 或手动 kill 12345。
```

### 项目监督者（Supervisor）

在多 agent 协作群聊中，偶尔会出现某个 agent 漏 @ 下一个 agent → 对话链中断 → 没人接手的情况。**项目监督者**会定时检查群聊是否停滞，自动让 LLM 判断该 @ 谁并发跟进消息。

**启用方式**：`claudetalk --setup` 流程末尾的"是否设为项目监督者"询问中选 y。也可直接编辑配置：

```json
{
  "profiles": {
    "pm": {
      "channel": "feishu",
      "feishu": { "FEISHU_APP_ID": "xxx", "FEISHU_APP_SECRET": "xxx" },
      "systemPrompt": "你是项目经理",
      "supervisorRole": true,
      "supervision": {
        "checkIntervalMs": 1200000,
        "staleThresholdMs": 600000,
        "cooldownMs": 1200000
      }
    }
  }
}
```

**默认行为**：
- 每 20 分钟轮询、最后一条消息距今超 10 分钟视为停滞、介入后该群 20 分钟内不再次介入
- 启动时延迟 5-15s 随机抖动后跑首次 tick（不必等满 20 分钟才有反应；多 bot 同时启动也错峰）

**LLM 输出与校验**：
- LLM 必须输出结构化 JSON `{shouldFollowUp, mention, message, reason}`
- `mention` 只填 profileName，`message` 是**纯文本正文**——`<at>` 标签由代码用 `Channel.formatMention()` 后置组装并 prepend；LLM 不需要也不应自己写标签
- LLM 看到的 agent 列表**包含 self（监督者自己）**并明确标 `⚠️ 这是你自己`，附带"@ self 会引发 1 轮自答自；系统不再自动跳过，由你下次 tick 自行判断是否继续介入"的说明，由 LLM 自行决策何时选 self、何时输出 `shouldFollowUp: false`
- JSON 解析失败时有 best-effort fixer 兜底：自动转义字符串值内未转义的半角双引号（中文 LLM 常见错误）
- 任何校验失败（含 parse 失败、mention 不合法、message 缺失）都会把 LLM 原始 decision 序列化打到日志，方便定位
- 校验失败重试一次再 drop；LLM 调用 60s 超时即 drop 本群

**安全门**：
- 一个工作目录下 `supervisorRole: true` 的 profile **最多 1 个**，启动时校验，超过会报错退出
- 监督独立 session（`supervision-{chatId}`），调用前 `clearSession`，不污染项目经理自己的对话上下文
- supervisor 调 LLM 时 `profile=undefined`——不注入任何角色 systemPrompt（避免 PM 身份污染严格的 JSON 判官指令）
- 不再用「最后一条是项目经理自己 → 自动跳过」的硬 guard：会误伤 PM 发完无 @ 总结后流程真卡死的情况；改由 LLM 看到完整最近消息后自行判断要不要再介入
- 群成员列表由 `chat-members.json` 自动维护（机器人启动时注册自己到 `_bot_self`）

## 配置文件

### 项目配置目录

所有项目级配置统一存放在工作目录的 `.claudetalk/` 目录下：

| 文件 | 说明 |
|------|------|
| `.claudetalk.json` | Profile 配置（Channel 凭据、角色描述等） |
| `.claudetalk/claudetalk.pid` | 默认角色进程 PID 文件（启动时自动创建，退出时自动清理） |
| `.claudetalk/claudetalk-{profile}.pid` | 指定角色进程 PID 文件（`--profile` 启动时生成） |
| `.claudetalk/feishu/chat-members.json` | 飞书群成员信息（自动积累，用于 @功能） |
| `.claudetalk/feishu/images/` | 飞书图片消息下载缓存目录（可按需清理） |
| `.claudetalk/feishu/bot_{profileName}.json` | 飞书机器人间协作消息队列（自动生成） |
| `.claudetalk/dingtalk/chat-members.json` | 钉钉群成员信息（启动时自动写入，收到消息后更新） |
| `.claudetalk/dingtalk/bot_{profileName}.json` | 钉钉机器人间协作消息队列（自动生成） |
| `.claudetalk-sessions.json` | 会话 session 持久化（自动生成，重启后恢复多轮对话） |

兼容老安装的文件（新版本不再生成）：

| 文件 | 说明 |
|------|------|
| `.claude/agents/{profile}.md` | 旧版 SubAgent 定义文件。新流程不读它，**钉钉的 `readAgentDisplayName` 仍会兼容读取**用于补显示名；可手动删 |

### 全局配置目录

全局配置存放在 `~/.claudetalk/`，用于跨多个工作目录复用同一份 profile：

| 文件 / 目录 | 说明 |
|------|------|
| `~/.claudetalk/config.json` | 全局 Profile 配置（结构与本地 `.claudetalk.json` 相同） |
| `~/.claudetalk/agents/{profile}.md` | 旧版 SubAgent 定义文件目录，新流程不再生成；保留是为了让钉钉 `readAgentDisplayName` 在老安装上继续返回中文显示名（可手动删） |
| `~/.claudetalk/locks/{channel}-{digest}.lock` | 实例锁文件（按 bot 凭据指纹隔离，自动管理，防双消费） |
| `~/.claudetalk/context-message.template` | 飞书群聊上下文模板（首次启动自动复制；用户可自定义，不会被后续启动覆盖） |

**启动时的查找顺序**：先看 `{工作目录}/.claudetalk.json`，没有则回退到 `~/.claudetalk/config.json`。**本地存在时只用本地，不与全局合并**。启动 banner 会显示当前实际使用的配置文件路径与来源（本地/全局）。

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
      "model": "claude-sonnet-4-5",
      "supervisorRole": true
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

**字段说明**：
- `channel`：`dingtalk` 或 `feishu`，对应渠道配置嵌套在同名键下
- `systemPrompt`：角色定义，通过 `--append-system-prompt` 注入 Claude Code 主循环
- `model`（可选）：透传给 `claude --model`，用于该 profile 选择特定模型；不填走 CLI 默认
- `supervisorRole`（可选）：标该 profile 为项目监督者；同一工作目录最多 1 个
- `supervision`（可选）：监督参数（`checkIntervalMs` / `staleThresholdMs` / `cooldownMs`，单位毫秒）；详见[项目监督者](#项目监督者supervisor)

> 已废弃字段：`subagentEnabled` / `subagentModel` / `subagentPermissions` 在新版本中已从 schema 移除（详见 [角色身份注入与每角色模型](#角色身份注入与每角色模型)）。老配置里保留这些字段不会报错，但被代码完全忽略，可手动清掉。

### 会话持久化

每个会话的 CLI session_id 会自动保存到 `.claudetalk-sessions.json`。重启 ClaudeTalk / QoderTalk 后，之前的多轮对话上下文会自动恢复。发送 `新会话` 或 `/new` 可清除指定会话的记忆。

**两类自动迁移**（无需手动介入）：

| 触发 | 行为 |
|---|---|
| 改 `systemPrompt` 后 | 下次消息 resume 时检测 `systemPromptHash` 不一致 → 清除该 session + 重建 |
| 从老版本（含 `subagentEnabled` 字段的 SessionEntry）升级 | 第一次 resume 识别为 legacy → 清除 + 重建 → 老的 SubAgent dispatch 上下文不会污染新会话 |

清除时日志会打 `[session] 清除并重建: <原因> (conversationId=...)`，可在 `.claudetalk/claudetalk-*.log` 里 grep 查看。

### 自动压缩（Auto Compact）

长跑会话的上下文会随对话增长，若不加干预会撑爆模型上下文窗口被拒。ClaudeTalk 在每轮 Claude 回复**返回给用户之后**异步检查实际 token 消耗，超过阈值时自动触发 `/compact` 压缩历史，用户无感知。

- **触发阈值**：单轮模型实际处理 token 总量（`input + cache_read + cache_creation`）超过 **1,000,000**（约模型 200K 窗口的 5 倍）即触发
- **为何看"总 token"而非 input_tokens**：Claude Code 中 `usage.input_tokens` 仅统计非缓存的新增 input，长跑 agent 几乎所有上下文走 cache_read，input_tokens 永远是个位数——旧实现按它判断导致压缩从不触发，session 滚到 1M+ 才被模型 400 拒绝
- **压缩流程**：异步 spawn 子进程对当前 session 发 `/compact`，完成后用新返回的 `session_id` 更新本地 session 记录，下一轮对话自动 resume 新 session
- **并发保护**：同一 session 正在压缩时，新消息会等待压缩完成再处理，避免历史互相覆盖

日志关键字：`[compact] Starting auto compact` / `[compact] Compact done, resume session_id: ...`，可在 `.claudetalk/claudetalk-*.log` 查看。

## License

MIT
