/**
 * Claude Code Feishu Channel - 飞书 API 客户端
 *
 * 使用飞书官方 SDK (@larksuiteoapi/node-sdk) 的 WSClient 建立 WebSocket 长连接
 * 需要在飞书开放平台开启"使用长连接接收事件"并订阅 im.message.receive_v1 事件
 * 文档: https://open.feishu.cn/document/server-docs/im-v1/message/create
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as Lark from '@larksuiteoapi/node-sdk';
import type {
  Channel,
  ChannelMessageContext,
  FeishuChannelConfig,
} from '../types.js';
import { registerChannel } from './registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

// ========== 内部类型定义 ==========

interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

interface FeishuBotInfoResponse {
  code: number;
  msg: string;
  bot: {
    app_name: string;
    avatar_url: string;
    ip_white_list: string[];
    open_id: string;
  };
}

// 飞书 SDK im.message.receive_v1 回调的事件数据结构
// SDK 已路由好事件类型，data 直接是 { sender, message }，不含 header/event 包装层
interface FeishuMessageEvent {
  // 事件唯一标识（用于去重，兼容 V2.0 协议 header.event_id 和 V1.0 协议 uuid）
  header?: {
    event_id: string;
  };
  uuid?: string;
  sender: {
    sender_id: {
      user_id: string;
      union_id: string;
      open_id: string;
    };
    sender_type: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        union_id?: string;
        user_id?: string;
      };
      name: string;
      tenant_key: string;
    }>;
  };
}
// 飞书发送消息响应
interface FeishuSendMessageResponse {
  code: number;
  msg: string;
  data?: {
    message_id: string;
  };
}

// 飞书文本消息内容
interface FeishuTextContent {
  text: string;
}

// 群成员配置文件结构：{ [chatId]: Array<ChatMember> }
// name 作为群内唯一 key（同一群内成员名称唯一）
// type：user/bot/空字符串（空字符串表示未确定，可能是其他机器人）
// openId：open_id（ou_ 开头），用于识别实时消息的 sender
// unionId：用户的 union_id（on_ 开头），跨应用稳定，用于模板中 @ 用户
// appId：机器人的 app_id（cli_ 开头），用于模板中 @ 机器人
type ChatMemberType = 'user' | 'bot' | '';
interface ChatMember {
  name: string;         // 唯一 key，群内成员名称
  type: ChatMemberType;
  openId?: string;      // open_id（ou_ 开头），用于识别实时消息的 sender
  unionId?: string;     // 用户的 union_id（on_ 开头），用于 @ 用户
  appId?: string;       // 机器人的 app_id（cli_ 开头），用于 @ 机器人
}
type ChatMembersConfig = Record<string, Array<ChatMember>>;


/**
 * 飞书 API 客户端，实现 Channel 接口
 *
 * 接收消息：使用飞书 WebSocket 长连接（需要飞书开放平台开启"使用长连接接收事件"）
 * 发送消息：使用飞书 IM API
 */
export class FeishuClient implements Channel {
  private config: FeishuChannelConfig;
  private tokenCache: { accessToken: string; expiresAt: number } | null = null;
  private botOpenId: string | null = null;
  private channelMessageHandler: ((context: ChannelMessageContext, message: string) => Promise<void>) | null = null;
  private wsClient: Lark.WSClient | null = null;
  // 事件去重缓存：event_id/uuid -> timestamp
  private processedEventIds = new Map<string, number>();
  private readonly DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24小时内重复事件忽略
  // 群成员配置文件路径（在 constructor 中初始化）
  private readonly chatMembersConfigPath!: string;

  constructor(config: FeishuChannelConfig) {
    this.config = config;
    // 使用工作目录的 .claudetalk 目录存储 chat-members.json
    // 统一放在 .claudetalk 目录下，便于管理项目内配置
    const workDir = config.workDir || process.cwd();
    this.chatMembersConfigPath = path.join(workDir, '.claudetalk', 'chat-members.json');
    // 说明：chat-members.json 放在项目的 .claudetalk 目录下，因为飞书没有接口可以直接查询到群机器人信息
    // 只能通过历史消息的 sender 和 mentions 被动积累，并通过 API 验证后确定正确的 type
  }

  /**
   * 从磁盘读取群成员配置文件
   */
  private loadChatMembersConfig(): ChatMembersConfig {
    try {
      if (fs.existsSync(this.chatMembersConfigPath)) {
        const content = fs.readFileSync(this.chatMembersConfigPath, 'utf-8');
        return JSON.parse(content) as ChatMembersConfig;
      }
    } catch (error) {
      console.error('[feishu] Failed to load chat-members.json:', error);
    }
    return {};
  }

  /**
   * 将群成员配置文件写入磁盘
   */
  private saveChatMembersConfig(config: ChatMembersConfig): void {
    try {
      const dir = path.dirname(this.chatMembersConfigPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.chatMembersConfigPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
      console.error('[feishu] Failed to save chat-members.json:', error);
    }
  }

  /**
   * 更新指定群的成员信息
   * 以 name 作为唯一 key，如果成员已存在则合并更新字段，否则追加
   */
  private updateChatMember(
    chatId: string,
    memberName: string,
    memberType: ChatMemberType,
    ids?: { openId?: string; unionId?: string; appId?: string }
  ): void {
    if (!memberName || memberName === '(unknown)') return;

    const config = this.loadChatMembersConfig();
    const members = config[chatId] || [];
    const existingIndex = members.findIndex(m => m.name === memberName);

    if (existingIndex >= 0) {
      const existing = members[existingIndex];
      const updatedOpenId = ids?.openId || existing.openId;
      const updatedUnionId = ids?.unionId || existing.unionId;
      const updatedAppId = ids?.appId || existing.appId;
      const hasChanges =
        existing.type !== memberType ||
        existing.openId !== updatedOpenId ||
        existing.unionId !== updatedUnionId ||
        existing.appId !== updatedAppId;

      if (hasChanges) {
        existing.type = memberType;
        if (updatedOpenId) existing.openId = updatedOpenId;
        if (updatedUnionId) existing.unionId = updatedUnionId;
        if (updatedAppId) existing.appId = updatedAppId;
        console.log(`[feishu] Updated chat member: chatId=${chatId}, name=${memberName}, type=${memberType}, openId=${updatedOpenId}, unionId=${updatedUnionId}, appId=${updatedAppId}`);
        config[chatId] = members;
        this.saveChatMembersConfig(config);
      }
    } else {
      const newMember: ChatMember = { name: memberName, type: memberType };
      if (ids?.openId) newMember.openId = ids.openId;
      if (ids?.unionId) newMember.unionId = ids.unionId;
      if (ids?.appId) newMember.appId = ids.appId;
      members.push(newMember);
      console.log(`[feishu] Added chat member: chatId=${chatId}, name=${memberName}, type=${memberType}, openId=${ids?.openId}, unionId=${ids?.unionId}, appId=${ids?.appId}`);
      config[chatId] = members;
      this.saveChatMembersConfig(config);
    }
  }

  /**
   * 读取指定群的成员列表
   */
  private getChatMembersFromConfig(chatId: string): Array<ChatMember> {
    const config = this.loadChatMembersConfig();
    return config[chatId] || [];
  }


  /**
   * 调用用户信息接口，通过 open_id 获取用户信息（name + union_id）
   * 需要 contact:contact.base:readonly 权限
   * @returns { name, unionId }，失败返回 null
   */
  private async fetchUserInfo(openId: string, accessToken: string): Promise<{ name: string; unionId: string } | null> {
    try {
      const response = await fetch(
        `${FEISHU_API_BASE}/contact/v3/users/${openId}?user_id_type=open_id`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = (await response.json()) as {
        code: number;
        msg: string;
        data?: { user: { name: string; open_id: string; union_id: string } };
      };
      console.error(`[feishu] ===== User Info API Response (openId=${openId}) =====`);
      console.error('[feishu] Response:', JSON.stringify(data, null, 2));
      console.error('[feishu] ===================================================');
      if (data.code === 0 && data.data?.user?.name) {
        const { name, union_id: unionId } = data.data.user;
        console.log(`[feishu] Resolved user info: openId=${openId}, name=${name}, unionId=${unionId}`);
        return { name, unionId };
      }
      console.warn(`[feishu] Failed to resolve user info for ${openId}: code=${data.code}, msg=${data.msg}`);
      return null;
    } catch (error) {
      console.error(`[feishu] Error fetching user info for ${openId}:`, error);
      return null;
    }
  }

  /**
   * 从飞书 API 查询 Member 信息（内层方法）
   * 只查询普通用户接口（同时获取 union_id）
   * 机器人信息在启动时通过 initializeBotInfo 预先写入配置
   * @returns { name, type, unionId }，name 为 null 表示查询失败
   */
  private async fetchMemberInfoFromApi(openId: string, accessToken: string): Promise<{ name: string | null; type: ChatMemberType; unionId?: string }> {
    // 只查询用户接口（同时获取 union_id）
    const userInfo = await this.fetchUserInfo(openId, accessToken);
    if (userInfo !== null) {
      return { name: userInfo.name, type: 'user', unionId: userInfo.unionId };
    }

    // 用户接口查询不到，返回 null（可能是机器人或其他情况）
    return { name: null, type: '' };
  }

  /**
   * 获取 Member 信息（外层方法）
   * 先查配置文件（用 openId 字段匹配），没有则调用 API 并更新配置（以 name 作为 key）
   * @param openId - 成员的 open_id
   * @param chatId - 群 ID，用于读写配置文件
   * @param knownName - 可选，从 mentions 中获取的已知 name（用于其他机器人等无法通过 API 查询的情况）
   * @param unionId - 可选，从实时消息 mentions 中直接获取的 union_id
   * @returns 成员 name，失败返回 openId
   */
  private async getMemberInfo(openId: string, chatId: string, knownName?: string, unionId?: string): Promise<string> {
    if (!openId || openId === '(unknown)') return openId;

    // 先从配置文件查找（优先用 knownName 匹配，其次用 openId 字段匹配）
    const members = this.getChatMembersFromConfig(chatId);
    let existing: ChatMember | undefined;

    if (knownName) {
      // 优先用 knownName 匹配（跨应用场景下 openId 可能变化，name 更稳定）
      existing = members.find(m => m.name === knownName);
    }

    if (!existing) {
      // 没有找到，再用 openId 匹配
      existing = members.find(m => m.openId === openId);
    }

    if (existing) {
      // 如果有新的 unionId 或 openId 信息，更新配置
      const idsToUpdate: { openId?: string; unionId?: string } = {};
      if (openId && existing.openId !== openId) {
        idsToUpdate.openId = openId;
      }
      if (unionId && !existing.unionId) {
        idsToUpdate.unionId = unionId;
      }
      if (Object.keys(idsToUpdate).length > 0) {
        this.updateChatMember(chatId, existing.name, existing.type, idsToUpdate);
      }
      return existing.name;
    }

    // 调用 API 查询
    const accessToken = await this.getAccessToken();
    const { name, type, unionId: apiUnionId } = await this.fetchMemberInfoFromApi(openId, accessToken);

    // 优先使用 API 返回的 unionId，其次使用传入的
    const resolvedUnionId = apiUnionId || unionId;

    // API 查询成功才写入配置文件（以 name 作为 key），失效用户不写入
    if (name) {
      this.updateChatMember(chatId, name, type, { openId, unionId: resolvedUnionId });
      return name;
    }

    // API 查询失败，但有 knownName（如 mentions 中的 name），则使用 knownName 并写入配置（type 为空）
    if (knownName) {
      console.log(`[feishu] Using known name from mentions for ${openId}: ${knownName}`);
      this.updateChatMember(chatId, knownName, type, { openId, unionId: resolvedUnionId });
      return knownName;
    }

    // API 查询失败且没有 knownName，返回 openId（不写入配置文件）
    console.warn(`[feishu] User ${openId} is invalid and no known name, skipping config update`);
    return openId;
  }

  /**
   * 注册 Channel 统一消息处理器（实现 Channel 接口）
   */
  onMessage(handler: (context: ChannelMessageContext, message: string) => Promise<void>): void {
    this.channelMessageHandler = handler;
  }

  /**
   * 发送上线通知（实现 Channel 接口）
   */
  async sendOnlineNotification(userId: string, workDir: string): Promise<void> {
    const notifyText = `✅ ClaudeTalk 已上线\n📁 工作目录: ${workDir}`;
    try {
      await this.sendTextMessage(userId, notifyText, false);
    } catch (error) {
      console.error(`[feishu][notify] Failed to send online notification: ${error}`);
    }
  }

  /**
   * 获取 Tenant Access Token
   */
  async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.accessToken;
    }

    const response = await fetch(
      `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      }
    );

    const data = (await response.json()) as FeishuTokenResponse;

    if (data.code !== 0) {
      throw new Error(`Failed to get feishu access token: ${data.msg}`);
    }

    // 缓存 token（提前 60 秒过期）
    this.tokenCache = {
      accessToken: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire - 60) * 1000,
    };

    return data.tenant_access_token;
  }

  /**
   * 获取机器人自身的 open_id（用于识别群聊中 @ 机器人的消息）
   */
  private async fetchBotOpenId(): Promise<string> {
    if (this.botOpenId) {
      return this.botOpenId;
    }

    const accessToken = await this.getAccessToken();
    const response = await fetch(`${FEISHU_API_BASE}/bot/v3/info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = (await response.json()) as FeishuBotInfoResponse;

    if (data.code !== 0) {
      throw new Error(`Failed to get feishu bot info: ${data.msg}`);
    }

    this.botOpenId = data.bot.open_id;
    console.error(`[feishu] Bot open_id: ${this.botOpenId}`);
    return this.botOpenId;
  }

  /**
   * 初始化机器人信息：启动时查询当前机器人自己并写入配置
   * 机器人查询权限只能查询当前应用创建的机器人，所以在启动时预先查询并写入配置
   * 后续 fetchMemberInfoFromApi 只查询普通用户
   */
  private async initializeBotInfo(): Promise<void> {
    try {
      const accessToken = await this.getAccessToken();
      const response = await fetch(`${FEISHU_API_BASE}/bot/v3/info`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const data = (await response.json()) as FeishuBotInfoResponse;

      if (data.code === 0 && data.bot) {
        const { open_id, app_name } = data.bot;
        this.botOpenId = open_id;
        // bot.v3/info 接口不返回 app_id，使用当前应用的 app_id
        const appId = this.config.appId;
        console.error(`[feishu] Bot info initialized: open_id=${open_id}, app_name=${app_name}, app_id=${appId}`);

        // 将当前机器人信息写入所有群的配置文件（以 name 作为唯一 key）
        const config = this.loadChatMembersConfig();
        let updated = false;

        // 遍历所有群聊，更新机器人信息
        for (const chatId in config) {
          const members = config[chatId];
          const existingIndex = members.findIndex(m => m.name === app_name);

          if (existingIndex >= 0) {
            // 更新现有机器人信息
            const existing = members[existingIndex];
            if (existing.type !== 'bot' || existing.openId !== open_id || existing.appId !== appId) {
              existing.type = 'bot';
              existing.openId = open_id;
              existing.appId = appId;
              console.log(`[feishu] Updated bot in chat ${chatId}: name=${app_name}, openId=${open_id}, appId=${appId}`);
              updated = true;
            }
          } else {
            // 添加新机器人信息
            members.push({
              name: app_name,
              type: 'bot',
              openId: open_id,
              appId: appId
            });
            console.log(`[feishu] Added bot to chat ${chatId}: name=${app_name}, openId=${open_id}, appId=${appId}`);
            updated = true;
          }
        }

        // 如果配置文件为空（首次启动），创建一个默认群聊条目存储机器人信息
        // 这样可以确保 chat-members.json 文件始终包含当前机器人的信息
        if (Object.keys(config).length === 0) {
          const defaultChatId = '_bot_self'; // 特殊标识，表示机器人自身信息
          config[defaultChatId] = [{
            name: app_name,
            type: 'bot',
            openId: open_id,
            appId: appId
          }];
          console.log(`[feishu] Created default bot entry: name=${app_name}, openId=${open_id}, appId=${appId}`);
          updated = true;
        }

        if (updated) {
          this.saveChatMembersConfig(config);
        }
      } else {
        throw new Error(`Failed to get bot info: ${data.msg}`);
      }
    } catch (error) {
      console.error(`[feishu] Error initializing bot info:`, error);
      throw error;
    }
  }

  /**
   * 启动 WebSocket 长连接，开始接收飞书消息   * 使用飞书官方 SDK WSClient，内部自动处理认证、心跳、重连
   * 确保全局只有一个 WSClient 实例，避免重复接收消息
   */
  async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error(
        'Missing required feishu configuration.\n' +
        'Please set:\n' +
        '  export FEISHU_APP_ID=your_app_id\n' +
        '  export FEISHU_APP_SECRET=your_app_secret'
      );
    }

    // 防止重复创建连接：若已有 WSClient 实例则直接返回
    if (this.wsClient) {
      console.error('[feishu] WebSocket client already running, skipping start');
      return;
    }

    console.error('[feishu] Connecting to Feishu WebSocket...');

    // 预先复制模板文件到用户目录，确保使用最新版本
    this.copyTemplateFile();

    // 预先获取机器人信息，写入配置文件（当前应用自身的机器人）
    await this.initializeBotInfo();

    // 创建事件分发器，注册消息处理器
    const eventDispatcher = new Lark.EventDispatcher({});
    eventDispatcher.register({
      'im.message.receive_v1': (data) => {
        // 异步处理事件，避免阻塞事件接收
        this.handleMessageEventAsync(data as unknown as FeishuMessageEvent).catch((error) => {
          const eventId = (data as unknown as FeishuMessageEvent).header?.event_id || (data as unknown as FeishuMessageEvent).uuid;
          console.error(`[feishu] Failed to handle message event (event_id=${eventId}):`, error);
        });
      },
    });

    // 创建 WSClient，使用官方 SDK 建立长连接（自动处理认证、心跳、重连）
    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    return new Promise((resolve, reject) => {
      try {
        this.wsClient!.start({ eventDispatcher });
        console.error('[feishu] WebSocket client started');
        resolve();
      } catch (error) {
        // 启动失败时清除实例，允许下次重试
        this.wsClient = null;
        reject(error);
      }
    });
  }

  /**
   * 复制模板文件到用户目录
   * 确保用户目录中的模板文件始终是最新版本
   */
  private copyTemplateFile(): void {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const templateDir = path.join(homeDir, '.claudetalk');
    const templatePath = path.join(templateDir, 'context-message.template');
    
    const sourceTemplatePath = path.join(__dirname, '../core/context-message.template');
    
    if (!fs.existsSync(sourceTemplatePath)) {
      console.error(`[feishu] Source template not found at ${sourceTemplatePath}`);
      return;
    }
    
    // 如果用户目录不存在，创建目录
    if (!fs.existsSync(templateDir)) {
      fs.mkdirSync(templateDir, { recursive: true });
    }
    
    // 复制模板文件
    fs.copyFileSync(sourceTemplatePath, templatePath);
    console.error(`[feishu] Copied template file to ${templatePath}`);
  }

  /**
   * 停止 WebSocket 连接并清理资源
   */
  stop(): void {
    if (this.wsClient) {
      this.wsClient = null;
      console.error('[feishu] WebSocket stopped');
    }
  }

  /**
   * 异步处理飞书消息事件（避免阻塞事件接收）
   * SDK 已通过 eventDispatcher.register 路由好事件类型，data 直接是 { sender, message }
   */
  private async handleMessageEventAsync(event: FeishuMessageEvent): Promise<void> {
    const { sender, message } = event;
    const isGroup = message.chat_type === 'group';

    // 打印原始消息事件，便于排查问题
    console.error('[feishu] ===== Raw Message Event =====');
    console.error('[feishu] Event:', JSON.stringify(event, null, 2));
    console.error('[feishu] =============================');

    // 事件去重：使用 event_id 或 uuid 作为唯一标识
    const eventId = event.header?.event_id || event.uuid || message.message_id;
    const now = Date.now();
    const lastProcessed = this.processedEventIds.get(eventId);
    if (lastProcessed && (now - lastProcessed) < this.DEDUP_TTL_MS) {
      console.error(`[feishu] Ignoring duplicate event: ${eventId}`);
      return;
    }
    this.processedEventIds.set(eventId, now);

    // 清理过期的去重缓存
    for (const [id, timestamp] of this.processedEventIds.entries()) {
      if (now - timestamp > this.DEDUP_TTL_MS) {
        this.processedEventIds.delete(id);
      }
    }
    const senderId = sender.sender_id.open_id;
    const conversationId = message.chat_id;

    // 群聊策略检查
    if (isGroup) {
      const groupPolicy = this.config.groupPolicy || 'at_only';

      if (groupPolicy === 'disabled') {
        console.error('[feishu] Group chat is disabled, ignoring message');
        return;
      }

      if (groupPolicy === 'at_only') {
        // 只响应 @ 机器人的消息
        const botOpenId = await this.fetchBotOpenId();
        const isMentioned = message.mentions?.some(
          (mention) => mention.id?.open_id === botOpenId
        );
        if (!isMentioned) {
          console.error('[feishu] Bot not mentioned in group, ignoring message');
          return;
        }
      }

      if (groupPolicy === 'allowlist') {
        const groupAllowFrom = this.config.groupAllowFrom || this.config.allowFrom || [];
        if (!groupAllowFrom.includes(senderId)) {
          console.error(`[feishu] Sender ${senderId} not in group allowlist, ignoring`);
          return;
        }
      }
    } else {
      // 私聊策略检查
      const dmPolicy = this.config.dmPolicy || 'open';
      if (dmPolicy === 'allowlist') {
        const allowFrom = this.config.allowFrom || [];
        if (!allowFrom.includes(senderId)) {
          console.error(`[feishu] Sender ${senderId} not in allowlist, ignoring`);
          return;
        }
      }
    }

    // 目前只处理文本消息
    if (message.message_type !== 'text') {
      console.error(`[feishu] Unsupported message type: ${message.message_type}, ignoring`);
      return;
    }

    // 解析文本内容
    let messageText = '';
    try {
      const content = JSON.parse(message.content) as FeishuTextContent;
      messageText = content.text || '';
    } catch {
      messageText = message.content;
    }

    // 群聊中去掉 @ 机器人的文本前缀（如 "@机器人名 你好" → "你好"）
    // 飞书消息中 @ 的格式是 @_user_N（占位符），需要用正则去掉所有 @xxx 前缀
    if (isGroup) {
      // 先按 mention.name 替换
      if (message.mentions) {
        for (const mention of message.mentions) {
          messageText = messageText.replace(`@${mention.name}`, '').trim();
        }
      }
      // 兜底：去掉所有 @_user_N 格式的占位符
      messageText = messageText.replace(/@_user_\d+/g, '').trim();
    }

    if (!messageText.trim()) {
      console.error('[feishu] Empty message content, ignoring');
      return;
    }

    console.error(`[feishu] Received message from ${senderId} in ${conversationId}: ${messageText}`);

    // 群聊中从当前消息提取成员信息，更新群成员配置文件
    if (isGroup) {
      // mentions 中的被提及者：传入 union_id 和 name，调用 API 查询并写入配置
      for (const mention of message.mentions || []) {
        const mentionOpenId = mention.id?.open_id;
        if (!mentionOpenId) {
          console.warn(`[feishu] Skipping mention without open_id, name=${mention.name}`);
          continue;
        }
        const mentionUnionId = mention.id?.union_id;
        // 异步查询，传入 mentions 中的 name 和 union_id
        this.getMemberInfo(mentionOpenId, conversationId, mention.name, mentionUnionId || undefined).catch(error => {
          console.error(`[feishu] Failed to resolve mention info for ${mentionOpenId}:`, error);
        });
      }
      // sender 本身：传入 union_id，通过 API 查询真实 name（异步，不阻塞消息处理）
      const senderUnionId = sender.sender_id?.union_id;
      this.getMemberInfo(senderId, conversationId, undefined, senderUnionId || undefined).catch(error => {
        console.error(`[feishu] Failed to resolve sender info for ${senderId}:`, error);
      });
      console.log(`[feishu] Updated chat members from current message, chatId=${conversationId}`);
    }

    if (this.channelMessageHandler) {
      // 飞书群聊默认启用上下文功能（固定 20 条历史消息）
      let contextMessage: string | undefined;
      if (isGroup) {
        console.log(`[feishu] Group chat detected, building context message...`);
        try {
          contextMessage = await this.buildContextMessage(event, messageText);
          console.log(`[feishu] Context message built successfully`);
        } catch (error) {
          console.error(`[feishu] Failed to build context message (event_id=${eventId}):`, error);
        }
      } else {
        console.log(`[feishu] Private chat, context disabled`);
      }

      const context: ChannelMessageContext = {
        conversationId,
        senderId,
        isGroup,
        userId: senderId,
        processedMessage: contextMessage,
      };
      try {
        await this.channelMessageHandler(context, messageText);
      } catch (error) {
        console.error(`[feishu] Failed to execute message handler (event_id=${eventId}):`, error);
      }
    }
  }

  /**
   * 获取群聊历史消息
   * 需要飞书开放平台申请 im:message:readonly 权限
   */
  private async getChatHistory(
    conversationId: string,
    limit: number
  ): Promise<Array<{
    messageId: string;
    senderInfo: string; // 格式：名称 (id)
    messageText: string;
    timestamp: number;
    mentions: Array<{ name: string; openId: string; type: string; unionId?: string; appId?: string }>;
  }>> {
    console.log(`[feishu] Getting chat history: conversationId=${conversationId}, limit=${limit}`);
    const accessToken = await this.getAccessToken();
    const response = await fetch(
      `${FEISHU_API_BASE}/im/v1/messages?container_id_type=chat&container_id=${conversationId}&page_size=${limit}&sort_type=ByCreateTimeDesc`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    const data = (await response.json()) as {
      code: number;
      msg: string;
      data?: {
        items?: Array<{
          message_id: string;
          create_time: string;
          sender: {
            id: string;
            id_type: string;
            sender_type: string;
          };
          body: { content: string };
          mentions?: Array<{ name: string; id: string; id_type: string }>;
        }>;
      };
    };

    // 打印历史消息 API 返回的原始数据，便于排查问题
    console.error('[feishu] ===== Chat History API Response =====');
    console.error('[feishu] Response:', JSON.stringify(data, null, 2));
    console.error('[feishu] =====================================');

    if (data.code !== 0) {
      throw new Error(`Failed to get feishu chat history: ${data.msg}`);
    }

    const items = data.data?.items || [];
    console.log(`[feishu] Retrieved ${items.length} history messages`);

    // 收集 mentions 和 sender 的信息，用于并发查询
    // key: open_id，value: knownName（历史消息中没有 union_id，只有 open_id 和 name）
    const memberQueries = new Map<string, string | undefined>();

    // 收集 mentions 中的 open_id 和 name（历史消息 mentions 只有 open_id，无 union_id）
    for (const item of items) {
      for (const mention of item.mentions || []) {
        if (mention.id_type === 'open_id' && mention.id) {
          if (!memberQueries.has(mention.id)) {
            memberQueries.set(mention.id, mention.name);
          }
        }
      }
    }

    // 收集 sender 信息
    for (const item of items) {
      const { id, id_type } = item.sender || {};
      if (!id || id === '(unknown)') continue;

      if (id_type === 'open_id') {
        // 普通用户 sender：用 open_id 查询
        if (!memberQueries.has(id)) {
          memberQueries.set(id, undefined);
        }
      } else if (id_type === 'app_id') {
        // 机器人 sender：id 就是 app_id（cli_ 开头），先从 _bot_self 中匹配机器人信息
        const botSelfMembers = this.getChatMembersFromConfig('_bot_self');
        const botSelfBot = botSelfMembers.find(m => m.appId === id);
        
        const existingMembers = this.getChatMembersFromConfig(conversationId);
        const existingBot = existingMembers.find(m => m.appId === id);
        
        if (!existingBot) {
          if (botSelfBot) {
            // _bot_self 中有该机器人信息，用真实的 name 写入
            console.log(`[feishu] Found bot sender with app_id=${id}, matched in _bot_self: name=${botSelfBot.name}`);
            this.updateChatMember(conversationId, botSelfBot.name, 'bot', { appId: id, openId: botSelfBot.openId });
          } else {
            // _bot_self 中也没有该机器人信息，暂时用 app_id 作为 name 占位写入
            console.log(`[feishu] Found new bot sender with app_id=${id}, writing placeholder to config`);
            this.updateChatMember(conversationId, id, 'bot', { appId: id });
          }
        }
      }
    }

    // 并发查询所有 open_id
    await Promise.all(
      [...memberQueries.entries()].map(([openId, knownName]) =>
        this.getMemberInfo(openId, conversationId, knownName).catch(error => {
          console.error(`[feishu] Failed to resolve member info for ${openId}:`, error);
        })
      )
    );

    return items.map((item) => {
      let messageText = '';
      try {
        const body = JSON.parse(item.body.content) as { text?: string };
        messageText = body.text || item.body.content;
      } catch {
        messageText = item.body.content;
      }

      // 从配置文件中查找发送者名称
      const senderId = item.sender?.id || '(unknown)';
      const senderIdType = item.sender?.id_type || 'open_id';
      const knownMembers = this.getChatMembersFromConfig(conversationId);
      // 机器人 sender 的 id 是 app_id，通过 appId 字段匹配；用户 sender 通过 openId 字段匹配
      const knownMember = senderIdType === 'app_id'
        ? knownMembers.find(m => m.appId === senderId)
        : knownMembers.find(m => m.openId === senderId);
      const senderName = knownMember?.name || senderId;
      const senderInfo = `${senderName} (id: ${senderId})`;

      return {
        messageId: item.message_id,
        senderInfo,
        messageText,
        timestamp: parseInt(item.create_time),
        mentions: (item.mentions || []).map((mention) => {
          const mentionOpenId = mention.id || '';
          const mentionMember = knownMembers.find(m => m.openId === mentionOpenId);
          return {
            name: mention.name,
            openId: mentionOpenId,
            type: mentionMember?.type || '',
            unionId: mentionMember?.unionId,
            appId: mentionMember?.appId,
          };
        }),
      };
    });
  }

  /**
   * 构建群聊上下文消息
   * 读取模板文件，替换变量后返回完整的上下文字符串
   */
  private async buildContextMessage(
    event: FeishuMessageEvent,
    messageText: string
  ): Promise<string> {
    const { sender, message } = event;
    const conversationId = message.chat_id;
    const historySize = 5; // 固定 5 条历史消息

    console.log(`[feishu] Building context message: conversationId=${conversationId}, sender=${sender.sender_id?.open_id || '(unknown)'}, message="${messageText.substring(0, 100)}..."`);

    // 获取历史消息
    const history = await this.getChatHistory(conversationId, historySize);

    // 过滤掉当前消息（历史消息第一条就是当前收到的消息）
    const filteredHistory = history.filter(msg => msg.messageId !== message.message_id);

    // 获取当前消息发送者的用户信息（从群成员配置文件查找）
    const currentSenderId = sender.sender_id?.open_id || sender.sender_id?.user_id || '(unknown)';
    const currentSenderMembers = this.getChatMembersFromConfig(conversationId);
    const currentSenderMember = currentSenderMembers.find(m => m.openId === currentSenderId);
    const currentSenderName = currentSenderMember?.name || currentSenderId;
    const senderInfo = `${currentSenderName} (id: ${currentSenderId})`;
    console.log(`[feishu] Current sender: id=${currentSenderId}, name=${currentSenderName}`);

    // 从配置文件读取群成员列表，构建群成员信息段落
    let chatMembersSection = '';
    if (message.chat_type === 'group') {
      const chatMembers = this.getChatMembersFromConfig(conversationId);
      console.log(`[feishu] Chat members from config: chatId=${conversationId}, count=${chatMembers.length}`);
      if (chatMembers.length > 0) {
        chatMembersSection = `### 👥 群成员信息（共 ${chatMembers.length} 人，来自历史消息记录）

${chatMembers.map((member, index) => {
  // @ 语法：根据 type 区分，user 用 union_id，bot 用 app_id，都没有则用 open_id
  let atId: string | undefined;
  let atIdType: string;
  if (member.type === 'user') {
    atId = member.unionId || member.openId;
    atIdType = member.unionId ? 'union_id' : 'open_id';
  } else if (member.type === 'bot') {
    atId = member.appId || member.openId;
    atIdType = member.appId ? 'app_id' : 'open_id';
  } else {
    atId = member.openId;
    atIdType = 'open_id';
  }
  return `${index + 1}. ${member.name} (at_id: ${atId}, at_id_type: ${atIdType}, type: ${member.type || '未知'})`;
}).join('\n')}

`;
      }
    }

    // 读取模板文件（从 ~/.claudetalk/ 目录读取，首次运行时自动复制）
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const templateDir = path.join(homeDir, '.claudetalk');
    const templatePath = path.join(templateDir, 'context-message.template');
    
    console.log(`[feishu] Template path: ${templatePath}`);
    console.log(`[feishu] __dirname: ${__dirname}`);
    
    // 每次都检查并更新模板文件，确保使用最新版本
    const sourceTemplatePath = path.join(__dirname, '../core/context-message.template');
    console.log(`[feishu] Source template path: ${sourceTemplatePath}`);
    console.log(`[feishu] Source template exists: ${fs.existsSync(sourceTemplatePath)}`);
    
    if (!fs.existsSync(sourceTemplatePath)) {
      console.error(`[feishu] Source template not found at ${sourceTemplatePath}`);
      throw new Error(`Template file not found at ${sourceTemplatePath}`);
    }
    
    // 如果用户目录不存在，创建目录
    if (!fs.existsSync(templateDir)) {
      fs.mkdirSync(templateDir, { recursive: true });
    }
    
    // 每次都复制最新的模板文件，覆盖旧版本
    fs.copyFileSync(sourceTemplatePath, templatePath);
    console.log(`[feishu] Copied template file to ${templatePath}`);
    
    const templateContent = fs.readFileSync(templatePath, 'utf-8');

    // 构建 mentions 段落
    const currentMentions = message.mentions || [];
    console.log(`[feishu] Current message mentions: ${currentMentions.length} people`);
    console.log(`[feishu] Mentions data: ${JSON.stringify(currentMentions)}`);
    const mentionsSection = currentMentions.length > 0
      ? `- **提及了**:\n${currentMentions.map((m) => {
          const mentionOpenId = m.id?.open_id || '';
          const mentionMember = currentSenderMembers.find(mem => mem.openId === mentionOpenId);
          let atId: string;
          let atIdType: string;
          if (mentionMember?.type === 'user') {
            atId = mentionMember.unionId || mentionOpenId;
            atIdType = mentionMember.unionId ? 'union_id' : 'open_id';
          } else if (mentionMember?.type === 'bot') {
            atId = mentionMember.appId || mentionOpenId;
            atIdType = mentionMember.appId ? 'app_id' : 'open_id';
          } else {
            atId = mentionOpenId || '(unknown)';
            atIdType = 'open_id';
          }
          return `  - ${m.name} (at_id: ${atId}, at_id_type: ${atIdType})`;
        }).join('\n')}`
      : '';

    // 构建历史消息段落（已按时间倒序，最新的在前）
    const historySection = filteredHistory.length > 0
      ? filteredHistory.map((msg) => {
          const mentionsPart = msg.mentions.length > 0
            ? `\n  - **提及了**: ${msg.mentions.map((m) => {
                let atId: string;
                let atIdType: string;
                if (m.type === 'user') {
                  atId = m.unionId || m.openId;
                  atIdType = m.unionId ? 'union_id' : 'open_id';
                } else if (m.type === 'bot') {
                  atId = m.appId || m.openId;
                  atIdType = m.appId ? 'app_id' : 'open_id';
                } else {
                  atId = m.openId || '(unknown)';
                  atIdType = 'open_id';
                }
                return `${m.name}(at_id: ${atId}, at_id_type: ${atIdType})`;
              }).join(', ')}`
            : '';
          return `- **发送者**: ${msg.senderInfo}\n  - **内容**: ${msg.messageText}${mentionsPart}`;
        }).join('\n\n')
      : '（暂无历史消息）';

    console.log(`[feishu] Context built: profileName="${this.config.profileName || '(none)'}", historySize=${historySize}, historyCount=${filteredHistory.length}`);

    // 替换模板变量
    const result = templateContent
      .replace(/\{\{profileName\}\}/g, this.config.profileName || '')
      .replace(/\{\{systemPrompt\}\}/g, this.config.systemPrompt || '')
      .replace(/\{\{senderInfo\}\}/g, senderInfo)
      .replace(/\{\{messageText\}\}/g, messageText)
      .replace(/\{\{mentionsSection\}\}/g, mentionsSection)
      .replace(/\{\{historySection\}\}/g, historySection)
      .replace(/\{\{chatMembersSection\}\}/g, chatMembersSection);

    console.log(`[feishu] Final context message length: ${result.length} chars`);
    return result;
  }

  /**
   * 发送消息（实现 Channel 接口）
   * 统一使用 text 类型发送消息，支持 @标签格式
   */
  async sendMessage(
    conversationId: string,
    content: string,
    isGroup: boolean
  ): Promise<void> {
    await this.sendTextMessage(conversationId, content, isGroup);
  }

  /**
   * 发送文本消息
   *
   * @param receiverId - 私聊时为用户 open_id，群聊时为 chat_id
   * @param isGroup - 是否群聊，决定 receive_id_type
   */
  async sendTextMessage(
    receiverId: string,
    content: string,
    isGroup: boolean
  ): Promise<FeishuSendMessageResponse> {
    const accessToken = await this.getAccessToken();
    // 无论私聊还是群聊，conversationId 都是 chat_id（oc_ 开头）
    // 飞书私聊的 p2p 会话也有 chat_id，统一用 chat_id 类型发送
    const receiveIdType = 'chat_id';
    void isGroup; // isGroup 保留参数兼容性，实际不影响发送类型

    const requestBody = {
      receive_id: receiverId,
      msg_type: 'text',
      content: JSON.stringify({ text: content }),
    };

    // 打印完整的机器人回复消息，便于定位问题
    console.error('[feishu] ===== Bot Reply Message (Text) =====');
    console.error('[feishu] Receiver ID:', receiverId);
    console.error('[feishu] Receive ID Type:', receiveIdType);
    console.error('[feishu] Message Type: text');
    console.error('[feishu] Content:', content);
    console.error('[feishu] Full Request Body:', JSON.stringify(requestBody, null, 2));
    console.error('[feishu] =====================================');

    const response = await fetch(
      `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(requestBody),
      }
    );

    const data = (await response.json()) as FeishuSendMessageResponse;

    if (data.code !== 0) {
      throw new Error(`Failed to send feishu text message: ${data.msg}`);
    }

    return data;
  }
}

// ========== Channel 自注册 ==========

registerChannel({
  type: 'feishu',
  label: '飞书机器人',
  configFields: [
    {
      key: 'FEISHU_APP_ID',
      label: 'FEISHU_APP_ID (App ID)',
      required: true,
      hint: '在飞书开放平台 (https://open.feishu.cn) 创建应用获取',
    },
    {
      key: 'FEISHU_APP_SECRET',
      label: 'FEISHU_APP_SECRET (App Secret)',
      required: true,
      secret: true,
    },
  ],
  create(config) {
    return new FeishuClient({
      appId: config.FEISHU_APP_ID,
      appSecret: config.FEISHU_APP_SECRET,
      profileName: config.profileName,
      systemPrompt: config.systemPrompt,
    });
  },
});
