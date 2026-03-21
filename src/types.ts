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
