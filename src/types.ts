/**
 * Claude Code DingTalk Channel - Type Definitions
 */

// 钉钉 Channel 配置
export interface DingTalkChannelConfig {
  /** 应用的 AppKey (Client ID) */
  clientId: string;
  /** 应用的 AppSecret (Client Secret) */
  clientSecret: string;
  /** 机器人代码，通常与 clientId 相同 */
  robotCode?: string;
  /** 企业 ID */
  corpId?: string;
  /** 应用 ID */
  agentId?: string;
  /** 私聊策略: open | pairing | allowlist */
  dmPolicy?: 'open' | 'pairing' | 'allowlist';
  /** 群聊策略: open | allowlist | disabled */
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  /** 允许的发送者 ID 列表 */
  allowFrom?: string[];
  /** 群聊发送者白名单 */
  groupAllowFrom?: string[];
  /** 消息类型: markdown | card */
  messageType?: 'markdown' | 'card';
  /** AI 卡片模板 ID */
  cardTemplateId?: string;
  /** 卡片内容字段键 */
  cardTemplateKey?: string;
  /** 调试模式 */
  debug?: boolean;
  /** 工作目录，用于存储 peer-message 和历史记录文件 */
  workDir?: string;
  /** 当前机器人的 profile 名称，用于 peer-message 文件命名和 @匹配 */
  profileName?: string;
  /** 已知的其他机器人 profile 名称列表，用于 peer-message @匹配 */
  knownProfiles?: string[];
  /** 机器人角色的系统提示词，用于 context-message.template 的 {{systemPrompt}} 变量 */
  systemPrompt?: string;
}

// 钉钉 Stream 消息
export interface DingTalkStreamMessage {
  /** 消息类型 */
  msgtype: string;
  /** 消息内容 */
  text?: {
    content: string;
  };
  /** 富文本内容 */
  richText?: string;
  /** 图片内容 */
  image?: {
    downloadCode: string;
    photoSize?: {
      width: number;
      height: number;
    };
  };
  /** 语音内容 */
  voice?: {
    downloadCode: string;
    duration: number;
    recognition?: string;
  };
  /** 视频内容 */
  video?: {
    downloadCode: string;
    duration: number;
    videoSize?: {
      width: number;
      height: number;
    };
  };
  /** 文件内容 */
  file?: {
    downloadCode: string;
    fileName: string;
    fileSize: number;
    fileType: string;
  };
  /** 引用消息 */
  quotedMsg?: {
    msgId: string;
    msgtype: string;
    content: string;
    createdAt: number;
  };
  /** 被引用的消息详情 */
  repliedMsg?: {
    msgId: string;
    msgtype: string;
    content: unknown;
    createdAt: number;
  };
}

// 钉钉入站消息回调
export interface DingTalkInboundCallback {
  /** 消息 ID */
  msgId: string;
  /** 会话类型: 1=单聊, 2=群聊 */
  conversationType: '1' | '2';
  /** 文本消息内容 */
  text?: {
    content: string;
  };
  /** 会话 ID */
  conversationId: string;
  /** 发送者 ID */
  senderId: string;
  /** 发送者企业员工 ID */
  senderCorpId?: string;
  /** 发送者员工 ID */
  senderStaffId?: string;
  /** 消息内容 */
  content: string;
  /** 消息创建时间 */
  createTime: number;
  /** 消息类型 */
  msgtype: string;
  /** @人员列表 */
  atUserIds?: string[];
  /** @机器人标记 */
  isInAtList?: boolean;
  /** 引用消息 ID */
  originalMsgId?: string;
  /** 会话 Webhook (用于回复) */
  sessionWebhook?: string;
  /** 会话 Webhook 过期时间 */
  sessionWebhookExpiredTime?: number;
}

// 钉钉 API Token 响应
export interface DingTalkTokenResponse {
  errcode: number;
  errmsg: string;
  accessToken: string;
  expiresIn: number;
}

// 钉钉消息发送响应
export interface DingTalkSendResponse {
  errcode: number;
  errmsg: string;
  processQueryKeys?: string[];
}

// AI 卡片实例
export interface AICardInstance {
  cardInstanceId: string;
  conversationId: string;
  processQueryKey: string;
  templateId: string;
}

// AI 卡片创建请求
export interface AICardCreateRequest {
  cardTemplateId: string;
  outTrackId: string;
  openConversationId: string;
  callbackRoute?: string;
  cardData: {
    cardParam: {
      [key: string]: string;
    };
    cardDataModel: {
      [key: string]: unknown;
    };
  };
  previewCategory?: string;
  dynamicSummary?: string;
}

// AI 卡片流式更新请求
export interface AICardStreamingRequest {
  cardInstanceId: string;
  outTrackId: string;
  cardData: {
    cardParam: {
      [key: string]: string;
    };
    cardDataModel: {
      [key: string]: unknown;
    };
  };
  isFinalize?: boolean;
  previewCategory?: string;
  dynamicSummary?: string;
}

// 解析后的消息内容
export interface ParsedMessageContent {
  /** 消息类型 */
  type: 'text' | 'image' | 'voice' | 'video' | 'file' | 'richText';
  /** 文本内容 */
  text?: string;
  /** 媒体下载码 */
  downloadCode?: string;
  /** 文件名 */
  fileName?: string;
  /** 文件大小 */
  fileSize?: number;
  /** 语音识别结果 */
  recognition?: string;
  /** 引用内容 */
  quotedContent?: string;
  /** 额外元数据 */
  meta?: Record<string, unknown>;
}

// Channel 消息元数据
export interface ChannelMessageMeta {
  /** 会话 ID */
  conversationId: string;
  /** 发送者 ID */
  senderId: string;
  /** 会话类型 */
  conversationType: '1' | '2';
  /** 消息 ID */
  msgId: string;
  /** 是否群聊 */
  isGroup: boolean;
  /** @用户列表 */
  atUserIds?: string[];
}

// 发送者白名单存储
export interface SenderAllowlist {
  /** 白名单用户 ID 列表 */
  senders: string[];
  /** 配对码映射 */
  pairingCodes: Map<string, { code: string; expiresAt: number }>;
}

// 持久化状态
export interface ChannelState {
  /** 发送者白名单 */
  allowlist: SenderAllowlist;
  /** Access Token 缓存 */
  tokenCache: {
    accessToken: string;
    expiresAt: number;
  } | null;
  /** 活跃的 AI 卡片 */
  activeCards: Map<string, AICardInstance>;
}

// ========== Channel 抽象层 ==========

/**
 * 支持的消息通道类型
 * 使用 string 而非联合类型，便于通过注册表动态扩展新 Channel，无需修改此文件
 */
export type ChannelType = string

/** 跨 Channel 统一的消息上下文 */
export interface ChannelMessageContext {
  /** 会话 ID（钉钉 conversationId / Discord channelId） */
  conversationId: string
  /** 发送者 ID */
  senderId: string
  /** 是否群聊 */
  isGroup: boolean
  /** 用于私聊通知的用户标识（钉钉 staffId / Discord userId） */
  userId: string
  /** 加工后的消息（由 Channel 处理后生成，用于传给大模型；原始消息用于 ClaudeTalk 内置指令识别） */
  processedMessage?: string
}

/** Channel 统一接口，钉钉和 Discord 各自完整实现 */
export interface Channel {
  /** 启动连接 */
  start(): Promise<void>
  /** 停止连接 */
  stop(): void
  /** 注册消息处理器 */
  onMessage(handler: (context: ChannelMessageContext, message: string) => Promise<void>): void
  /** 发送消息 */
  sendMessage(conversationId: string, content: string, isGroup: boolean): Promise<void>
  /** 发送上线通知（可选，各 Channel 自行实现） */
  sendOnlineNotification?(userId: string, workDir: string): Promise<void>
  /** 获取历史消息（Discord 专有，钉钉不支持） */
  getHistoryMessages?(conversationId: string, limit?: number): Promise<string[]>
}

// ========== 配置层 ==========

/** 钉钉 Channel 专属配置 */
export interface DingTalkProfileConfig {
  DINGTALK_CLIENT_ID: string
  DINGTALK_CLIENT_SECRET: string
}

/** 飞书 Channel 内部配置 */
export interface FeishuChannelConfig {
  /** 飞书应用 App ID */
  appId: string
  /** 飞书应用 App Secret */
  appSecret: string
  /** 私聊策略: open | allowlist */
  dmPolicy?: 'open' | 'allowlist'
  /** 群聊策略: at_only | open | allowlist | disabled */
  groupPolicy?: 'at_only' | 'open' | 'allowlist' | 'disabled'
  /** 允许的发送者 open_id 列表（私聊白名单） */
  allowFrom?: string[]
  /** 群聊发送者白名单 */
  groupAllowFrom?: string[]
  /** 消息类型: text | post */
  messageType?: 'text' | 'post'
  /** 当前 profile 名称（由 startBot 注入，用于上下文模板渲染） */
  profileName?: string
  /** 角色系统提示词（由 startBot 注入，用于上下文模板渲染） */
  systemPrompt?: string
  /** 工作目录（由 startBot 注入，用于存储 chat-members.json） */
  workDir?: string
}

// ========== Peer Message 类型 ==========

/**
 * Bot 间协作消息（peer-message）
 * 存储在 {workDir}/.claudetalk/bot_{botName}.json 中
 * 机器人A 发送消息成功后，解析 @标签，写入被@机器人的 peer-message 文件
 * 机器人B 轮询自己的 peer-message 文件，10秒后处理
 */
export interface PeerMessage {
  /** 唯一 ID */
  id: string
  /** 发送方 profile 名称 */
  from: string
  /** 飞书群 chat_id */
  chatId: string
  /** 飞书消息 ID（发送成功后记录） */
  messageId: string
  /** 消息内容（原始文本） */
  message: string
  /** 创建时间戳（ms） */
  createdAt: number
}

/** 飞书 Channel 专属配置 */
export interface FeishuProfileConfig {
  FEISHU_APP_ID: string
  FEISHU_APP_SECRET: string
}

/** Discord Channel 专属配置 */
export interface DiscordProfileConfig {
  /** Bot Token */
  TOKEN: string
  /** Application Client ID */
  CLIENT_ID?: string
  /** 限定 Guild ID（可选，不填则响应所有 Guild） */
  GUILD_ID?: string
}

/** ClaudeTalk Profile 配置 */
export interface ProfileConfig {
  /** 消息通道类型，必填 */
  channel: ChannelType
  /** 钉钉配置 */
  dingtalk?: DingTalkProfileConfig
  /** 飞书配置 */
  feishu?: FeishuProfileConfig
  /** Discord 配置 */
  discord?: DiscordProfileConfig
  /** 角色系统提示词 */
  systemPrompt?: string
  /** 是否启用 SubAgent */
  subagentEnabled?: boolean
  /** SubAgent 使用的模型 */
  subagentModel?: string
  /** SubAgent 权限配置 */
  subagentPermissions?: {
    allow?: string[]
    deny?: string[]
  }
  /** 索引签名：支持动态 Channel 类型的嵌套配置（如 wechat、slack 等） */
  [channelKey: string]: unknown
}

/** ClaudeTalk 配置文件结构（loadConfig 返回的合并后配置） */
export interface ClaudeTalkConfig extends ProfileConfig {}