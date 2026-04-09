/**
 * Discord Channel 实现
 * 使用 discord.js 接收消息，实现 Channel 接口
 * 消息处理逻辑与钉钉完全独立
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  TextChannel,
  DMChannel,
  type Message,
  type TextBasedChannel,
} from 'discord.js'
import type { Channel, ChannelMessageContext } from '../../types.js'
import { registerChannel } from '../registry.js'
import { createLogger } from '../../core/logger.js'

export interface DiscordChannelConfig {
  /** Bot Token */
  token: string
  /** 限定 Guild ID（可选，不填则响应所有 Guild） */
  guildId?: string
}

// Discord 单条消息最大长度
const DISCORD_MAX_MESSAGE_LENGTH = 2000

/**
 * Discord Channel 实现，实现 Channel 接口
 * 特有能力：支持获取历史消息（getHistoryMessages）
 */
export class DiscordClient implements Channel {
  private config: DiscordChannelConfig
  private client: Client
  private messageHandler: ((context: ChannelMessageContext, message: string) => Promise<void>) | null = null
  private readonly logger = createLogger('discord')

  constructor(config: DiscordChannelConfig) {
    this.config = config
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    })
  }

  /**
   * 注册消息处理器（实现 Channel 接口）
   */
  onMessage(handler: (context: ChannelMessageContext, message: string) => Promise<void>): void {
    this.messageHandler = handler
  }

  /**
   * 启动 Discord Bot（实现 Channel 接口）
   */
  async start(): Promise<void> {
    if (!this.config.token) {
      throw new Error('Discord Bot Token 未配置，请在 discord.TOKEN 中填写')
    }

    this.client.on(Events.ClientReady, (readyClient) => {
      this.logger(`[discord] Bot 已上线: ${readyClient.user.tag}`)
    })

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // 忽略 Bot 自身的消息
      if (message.author.bot) return

      // 限定 Guild（如果配置了 guildId）
      if (this.config.guildId && message.guildId && message.guildId !== this.config.guildId) {
        return
      }

      const messageText = message.content.trim()
      if (!messageText) return

      const isGroup = message.channel instanceof TextChannel
      const context: ChannelMessageContext = {
        conversationId: message.channelId,
        senderId: message.author.id,
        isGroup,
        userId: message.author.id,
      }

      this.logger(`[discord] Message from ${message.author.tag} in ${message.channelId}: ${messageText}`)

      if (this.messageHandler) {
        await this.messageHandler(context, messageText)
      }
    })

    try {
      await this.client.login(this.config.token)
    } catch (error) {
      this.logger('[discord] 登录失败，完整错误信息:')
      this.logger(String(error))

      // 检查是否为连接超时
      const isTimeout =
        error instanceof Error &&
        (error.message.includes('ConnectTimeoutError') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('timeout'))

      if (isTimeout) {
        throw new Error(
          '无法连接到 Discord 服务器（连接超时）。原因可能是：\n' +
          '  1. 网络防火墙阻止了对 Discord 的访问\n' +
          '  2. Discord 域名被 DNS 污染或无法解析\n' +
          '  3. 网络环境不支持访问境外服务器\n\n' +
          '建议：\n' +
          '  - 切换网络环境（如使用手机热点）\n' +
          '  - 配置代理：export HTTPS_PROXY=http://your-proxy:port\n' +
          '  - 测试连接：curl https://discord.com/api/v10/gateway/bot'
        )
      }

      // 检查是否为 403 错误（网络被阻止）
      const isNetworkBlocked =
        error &&
        typeof error === 'object' &&
        'status' in error &&
        error.status === 403

      if (isNetworkBlocked) {
        throw new Error(
          '无法连接到 Discord 服务器（HTTP 403）。原因可能是：\n' +
          '  1. 网络防火墙阻止了对 Discord 的访问\n' +
          '  2. 需要配置代理（设置 HTTP_PROXY/HTTPS_PROXY 环境变量）\n' +
          '  3. Discord 域名被 DNS 污染或劫持\n\n' +
          '建议：\n' +
          '  - 尝试切换网络环境（如使用手机热点）\n' +
          '  - 检查公司防火墙是否阻止了 discord.com\n' +
          '  - 运行 `curl https://discord.com/api/v10/gateway/bot` 测试网络连接'
        )
      }

      const isAuthError =
        error instanceof Error &&
        (error.message.includes('No Description') ||
          error.message.includes('TOKEN_INVALID') ||
          error.message.includes('Unauthorized') ||
          error.message.includes('401'))
      if (isAuthError) {
        throw new Error(
          'Discord Bot Token 无效或已过期，请前往 https://discord.com/developers/applications 重新生成 Token 并更新配置'
        )
      }
      throw error
    }
  }

  /**
   * 停止 Discord Bot（实现 Channel 接口）
   */
  stop(): void {
    this.client.destroy()
    this.logger('[discord] Bot 已停止')
  }

  /**
   * 发送消息（实现 Channel 接口）
   * 超过 2000 字符时自动分段发送
   */
  async sendMessage(conversationId: string, content: string, _isGroup: boolean): Promise<void> {
    const channel = await this.client.channels.fetch(conversationId)
    if (!channel?.isTextBased()) {
      throw new Error(`[discord] Channel ${conversationId} 不是文本频道`)
    }

    const textChannel = channel as TextBasedChannel & { send: (content: string) => Promise<unknown> }

    if (content.length <= DISCORD_MAX_MESSAGE_LENGTH) {
      await textChannel.send(content)
      return
    }

    // 超长消息分段发送
    const chunks = splitMessage(content, DISCORD_MAX_MESSAGE_LENGTH)
    for (const chunk of chunks) {
      await textChannel.send(chunk)
    }
  }

  /**
   * 发送上线通知（实现 Channel 接口）
   * 通过 DM 发送给指定用户
   */
  async sendOnlineNotification(userId: string, workDir: string): Promise<void> {
    const notifyText = [
      `✅ ClaudeTalk 已上线`,
      `📁 工作目录: ${workDir}`,
      ``,
      `💡 常用指令：`,
      `  /new 或 新会话 — 清空会话记忆`,
      `  /reset 或 清空记忆 — 同上`,
      `  /restart 或 重启 — 重启机器人（仅私聊）`,
      `  /help 或 帮助 — 查看全部指令`,
    ].join('\n')
    try {
      const user = await this.client.users.fetch(userId)
      const dmChannel = await user.createDM()
      await dmChannel.send(notifyText)
    } catch (error) {
      this.logger(`[discord] 发送上线通知失败: ${error}`)
    }
  }

  /**
   * 获取频道历史消息（Discord 专有能力）
   * 可在新建 session 时注入上下文
   */
  async getHistoryMessages(channelId: string, limit: number = 10): Promise<string[]> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel?.isTextBased()) return []

    const textChannel = channel as TextChannel | DMChannel
    const messages = await textChannel.messages.fetch({ limit })

    return messages
      .filter((msg) => !msg.author.bot)
      .map((msg) => `${msg.author.username}: ${msg.content}`)
      .reverse()
  }
}

/**
 * 将长文本按最大长度分段，尽量在换行处切割
 */
function splitMessage(content: string, maxLength: number): string[] {
  const chunks: string[] = []
  let remaining = content

  while (remaining.length > maxLength) {
    // 尝试在最大长度内找最后一个换行符
    const sliceAt = remaining.lastIndexOf('\n', maxLength)
    const cutAt = sliceAt > 0 ? sliceAt + 1 : maxLength
    chunks.push(remaining.slice(0, cutAt))
    remaining = remaining.slice(cutAt)
  }

  if (remaining.length > 0) {
    chunks.push(remaining)
  }

  return chunks
}

// ========== Channel 自注册 ==========

registerChannel({
  type: 'discord',
  label: 'Discord 机器人',
  configFields: [
    {
      key: 'TOKEN',
      label: 'Bot Token',
      required: true,
      secret: true,
      hint: '在 Discord Developer Portal (https://discord.com/developers) 创建 Bot 获取',
    },
    {
      key: 'GUILD_ID',
      label: 'Guild ID（限定服务器，可选，直接回车跳过）',
      required: false,
    },
  ],
  create(config: Record<string, string>) {
    return new DiscordClient({
      token: config.TOKEN,
      guildId: config.GUILD_ID,
    })
  },
})
