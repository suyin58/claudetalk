# ClaudeTalk Discord 集成方案

## 背景

ClaudeTalk 目前只支持钉钉作为消息通道。本方案将 Discord 作为第二个消息通道接入，同时对架构进行重构，使其支持多 Channel 扩展。

## 核心设计原则

1. **Channel 独立**：钉钉和 Discord 的消息处理逻辑完全独立，不共用代码，便于各自扩展
2. **底层共享**：`callClaude`（Claude CLI 调用 + Session 管理）作为共享底层，两个 Channel 都可调用
3. **向后兼容**：现有钉钉配置无需修改，`channel` 字段默认为 `dingtalk`
4. **配置驱动**：通过 `.claudetalk.json` 中的 `channel` 字段决定使用哪个消息通道

---

## 架构设计

### 整体结构

```
.claudetalk.json（配置）
        ↓
    src/cli.ts（CLI 入口 + 配置引导）
        ↓
    src/index.ts（startBot，根据 channel 创建实例）
        ↓
  ┌─────────────────────────────┐
  │       Channel 接口           │
  ├──────────────┬──────────────┤
  │ DingTalkChannel │ DiscordChannel │
  │ (src/dingtalk.ts) │ (src/discord.ts) │
  └──────────────┴──────────────┘
        ↓（消息到达时调用）
    src/claude.ts（callClaude + Session 管理）
        ↓
    claude CLI（claude -p）
```

### 文件结构变化

| 文件 | 变化 | 说明 |
|------|------|------|
| `src/types.ts` | 修改 | 新增 `Channel` 接口、`ChannelType`、`ChannelMessageContext`，扩展 `ProfileConfig` |
| `src/claude.ts` | **新建** | 从 `index.ts` 抽取 `callClaude` + Session 管理逻辑 |
| `src/dingtalk.ts` | 修改 | `DingTalkClient` 实现 `Channel` 接口 |
| `src/discord.ts` | **新建** | Discord Channel 完整实现 |
| `src/index.ts` | 修改 | `startBot` 根据 channel 类型创建对应实例，移除 `callClaude` |
| `src/cli.ts` | 修改 | 配置引导增加 channel 选择 |

---

## 配置格式

### 新配置结构

```json
{
  "profiles": {
    "pm": {
      "channel": "dingtalk",
      "dingtalk": {
        "DINGTALK_CLIENT_ID": "xxx",
        "DINGTALK_CLIENT_SECRET": "xxxxxx"
      },
      "systemPrompt": "你是产品经理，负责需求分析和文档编写",
      "subagentEnabled": true,
      "subagentModel": "claude-haiku-4-5"
    },
    "dev": {
      "channel": "discord",
      "discord": {
        "TOKEN": "xxxx",
        "CLIENT_ID": "xxx",
        "GUILD_ID": "xxx"
      },
      "systemPrompt": "你是全栈开发工程师，擅长 SQL 编写",
      "subagentEnabled": true,
      "subagentModel": "claude-sonnet-4-6"
    }
  }
}
```

### 说明

- `channel` 字段必填，明确指定消息通道类型
- 各 channel 的配置统一嵌套在对应 key 下，不支持旧的顶层写法
- 旧配置需手动迁移到新格式

---

## 接口定义

### Channel 接口（`src/types.ts`）

```typescript
export type ChannelType = 'dingtalk' | 'discord'

// 跨 Channel 统一的消息上下文
export interface ChannelMessageContext {
  conversationId: string   // 会话 ID（钉钉 conversationId / Discord channelId）
  senderId: string         // 发送者 ID
  isGroup: boolean         // 是否群聊
  userId: string           // 用于私聊通知的用户标识（钉钉 staffId / Discord userId）
}

// Channel 接口
export interface Channel {
  start(): Promise<void>
  stop(): void
  onMessage(handler: (context: ChannelMessageContext, message: string) => Promise<void>): void
  sendMessage(conversationId: string, content: string, isGroup: boolean): Promise<void>
  sendOnlineNotification?(userId: string, workDir: string): Promise<void>
  // Discord 专有：获取历史消息
  getHistoryMessages?(conversationId: string, limit?: number): Promise<string[]>
}
```

### ProfileConfig 扩展（`src/types.ts`）

```typescript
export interface ProfileConfig {
  channel?: ChannelType
  // 钉钉配置（新写法嵌套，旧写法兼容顶层）
  dingtalk?: {
    DINGTALK_CLIENT_ID: string
    DINGTALK_CLIENT_SECRET: string
  }
  DINGTALK_CLIENT_ID?: string   // 旧写法兼容
  DINGTALK_CLIENT_SECRET?: string
  // Discord 配置
  discord?: {
    TOKEN: string
    CLIENT_ID?: string
    GUILD_ID?: string
  }
  systemPrompt?: string
  subagentEnabled?: boolean
  subagentModel?: string
  subagentPermissions?: {
    allow?: string[]
    deny?: string[]
  }
}
```

---

## Session 管理

### Session Key 格式

```
conversationId|workDir|profile|channel
```

示例：
- `conv123|/path/to/project|pm|dingtalk`
- `conv123|/path/to/project|dev|discord`

不同 channel 的 session 完全隔离，即使同一个 conversationId 在不同 channel 下也是独立的 session。

### SessionEntry 扩展

```typescript
interface SessionEntry {
  sessionId: string
  lastActiveAt: number
  isGroup: boolean
  conversationId: string
  userId: string
  subagentEnabled: boolean
  channel: ChannelType    // 新增：记录 session 所属 channel
}
```

---

## Discord Channel 设计

### Discord 消息接收方式

Discord 使用 Gateway WebSocket 接收消息，通过 `discord.js` 库实现：

```typescript
import { Client, GatewayIntentBits, Events } from 'discord.js'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ]
})
```

### Discord 特有能力：历史消息

Discord 支持通过 API 拉取频道历史消息，可以在新建 session 时注入上下文：

```typescript
async getHistoryMessages(channelId: string, limit: number = 10): Promise<string[]> {
  const channel = await this.client.channels.fetch(channelId)
  if (!channel?.isTextBased()) return []
  const messages = await channel.messages.fetch({ limit })
  return messages
    .filter(msg => !msg.author.bot)
    .map(msg => `${msg.author.username}: ${msg.content}`)
    .reverse()
}
```

### Discord vs 钉钉 差异对比

| 特性 | 钉钉 | Discord |
|------|------|---------|
| 连接方式 | Stream WebSocket（需票据） | Gateway WebSocket（Token 直连） |
| 历史消息 | ❌ 不支持 | ✅ 支持 |
| 私聊通知 | ✅ staffId 发送 | ✅ userId DM |
| 消息格式 | Markdown | Markdown / Embed |
| 群聊识别 | conversationType=2 | Guild Channel |
| 重连机制 | 手动实现 | discord.js 内置 |

---

## 实施步骤

### 第一步：重构类型定义（`src/types.ts`）

- 新增 `ChannelType`、`ChannelMessageContext`、`Channel` 接口
- 扩展 `ProfileConfig`，支持 `channel`、`dingtalk`、`discord` 字段
- 扩展 `SessionEntry`，新增 `channel` 字段

### 第二步：抽取 Claude 调用层（`src/claude.ts`）

从 `src/index.ts` 抽取以下内容到新文件：
- `callClaude` 函数（调整签名，增加 `channel` 参数）
- `getSessionKey`（调整，增加 `channel` 参数）
- `loadSessionMap` / `saveSessionMap`
- `findLastActiveSession`
- `loadConfig` / `loadConfigFromFile`
- `buildAgentJson`
- `SessionEntry` 接口

### 第三步：改造 DingTalkChannel（`src/dingtalk.ts`）

- `DingTalkClient` 实现 `Channel` 接口
- 新增 `onMessage` 统一回调（接收 `ChannelMessageContext` + `message`）
- 新增 `sendOnlineNotification` 方法
- 消息处理逻辑保持不变，只是适配接口

### 第四步：实现 DiscordChannel（`src/discord.ts`）

- 使用 `discord.js` 实现 `Channel` 接口
- 实现 `getHistoryMessages` 方法
- 实现私聊 DM 通知
- 内置指令处理（`/new`、`/reset`、`/help`）

### 第五步：调整启动逻辑（`src/index.ts`）

- `startBot` 根据 `channel` 字段创建对应 Channel 实例
- 移除 `callClaude` 和 session 相关代码（已移到 `src/claude.ts`）
- 统一的消息处理流程：`channel.onMessage → callClaude → channel.sendMessage`

### 第六步：更新 CLI 配置引导（`src/cli.ts`）

- 配置引导增加 channel 选择步骤
- 根据选择的 channel 引导不同的配置字段
- 更新配置保存逻辑，支持嵌套格式

---

## 依赖

Discord Channel 需要新增依赖：

```bash
npm install discord.js
```

`discord.js` 版本要求：v14+（支持 TypeScript，内置 Gateway 重连）

---

## 注意事项

1. **Discord Bot 权限**：需要在 Discord Developer Portal 开启 `MESSAGE CONTENT INTENT`，否则无法读取消息内容
2. **历史消息注入时机**：Discord 历史消息只在新建 session 时注入，恢复 session 时不重复注入
3. **上线通知**：Discord 通过 DM 发送上线通知，需要 Bot 和用户在同一 Guild
4. **消息长度限制**：Discord 单条消息上限 2000 字符，超长回复需要分段发送
5. **配置迁移**：旧的顶层 `DINGTALK_CLIENT_ID` 写法已不再支持，需迁移到 `dingtalk: {}` 嵌套格式
