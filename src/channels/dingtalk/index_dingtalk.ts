/**
 * Claude Code DingTalk Channel - 钉钉 API 客户端
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  Channel,
  ChannelMessageContext,
  DingTalkChannelConfig,
  DingTalkTokenResponse,
  DingTalkSendResponse,
  AICardInstance,
  AICardCreateRequest,
  AICardStreamingRequest,
  DingTalkInboundCallback,
} from '../../types.js';
import { registerChannel } from '../registry.js';
import { createLogger } from '../../core/logger.js';
import { loadConfig } from '../../core/claude.js';
import {
  loadPeerMessages,
  removePeerMessages,
  writePeerMessagesFromContent,
  type DingTalkPeerMessage,
} from './peer-message.js';
import {
  appendChatHistory,
  loadChatHistory,
  formatChatHistory,
} from './chat-history.js';

const DINGTALK_API_BASE = 'https://api.dingtalk.com';
const DINGTALK_STREAM_URL = process.env.DINGTALK_STREAM_URL || 'wss://dingtalk-stream.dingtalk.com/connect';

// 钉钉 Stream 连接票据响应
interface DingTalkStreamTicketResponse {
  endpoint: string;
  ticket: string;
}

// 钉钉 Stream WebSocket 帧
interface DingTalkStreamFrame {
  specVersion: string;
  type: string;
  headers: {
    appId: string;
    connectionId: string;
    contentType: string;
    messageId: string;
    time: string;
    topic: string;
  };
  data: string;
}

// 消息到达时的回调函数类型（内部使用，保留原始钉钉回调）
type InternalMessageHandler = (callback: DingTalkInboundCallback) => Promise<void>;

/**
 * 钉钉 API 客户端，实现 Channel 接口
 */
export class DingTalkClient implements Channel {
  private config: DingTalkChannelConfig;
  private tokenCache: { accessToken: string; expiresAt: number } | null = null;
  private internalMessageHandler: InternalMessageHandler | null = null;
  private channelMessageHandler: ((context: ChannelMessageContext, message: string) => Promise<void>) | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isManuallyClosed: boolean = false;
  private reconnectDelayMs: number = 3000;
  private readonly logger: (msg: string) => void;

  // peer-message 相关
  private readonly claudetalkDir: string;
  private readonly profileName: string;
  private peerPollTimer: ReturnType<typeof setInterval> | null = null;
  private processedPeerIds = new Set<string>();
  // 私聊会话 ID → 用户 open_id 映射缓存（钉钉私聊 conversationId 是会话ID，发送时需要用户 open_id）
  private privateSenderCache = new Map<string, string>();

  constructor(config: DingTalkChannelConfig) {
    this.config = config;
    this.profileName = config.profileName || 'default';
    const workDir = config.workDir || process.cwd();
    this.claudetalkDir = path.join(workDir, '.claudetalk');
    this.logger = createLogger('dingtalk', this.profileName);
  }

  /**
   * 注册 Channel 统一消息处理器（实现 Channel 接口）
   */
  onMessage(handler: (context: ChannelMessageContext, message: string) => Promise<void>): void {
    this.channelMessageHandler = handler;
  }

  /**
   * 注册内部钉钉原始消息处理器（内部使用）
   */
  onRawMessage(handler: InternalMessageHandler): void {
    this.internalMessageHandler = handler;
  }

  /**
   * 发送上线通知（实现 Channel 接口）
   */
  async sendOnlineNotification(userId: string, workDir: string): Promise<void> {
    const notifyText = `✅ ClaudeTalk 已上线\n📁 工作目录: ${workDir}`;
    try {
      await this.sendPrivateMessage(userId, notifyText, 'sampleText');
    } catch (error) {
      this.logger(`[notify] Failed to send online notification: ${error}`);
    }
  }

  /**
   * 获取 Access Token
   */
  async getAccessToken(): Promise<string> {
    // 检查缓存
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.accessToken;
    }

    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/oauth2/accessToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appKey: this.config.clientId,
          appSecret: this.config.clientSecret,
        }),
      }
    );

    const data = (await response.json()) as DingTalkTokenResponse & { code?: string; message?: string };

    // 钉钉 v1.0 token 接口失败时返回 { code, message }，成功时返回 { accessToken, expireIn }
    if (!data.accessToken) {
      const errorMessage = data.message || data.errmsg || JSON.stringify(data);
      throw new Error(`Failed to get access token: ${errorMessage}`);
    }

    // 缓存 token (提前 60 秒过期)
    this.tokenCache = {
      accessToken: data.accessToken,
      expiresAt: Date.now() + (data.expiresIn - 60) * 1000,
    };

    return data.accessToken;
  }

  /**
   * 获取 Stream 连接票据
   */
  private async getStreamTicket(): Promise<DingTalkStreamTicketResponse> {
    this.logger('[getStreamTicket] Fetching access token...');
    const accessToken = await this.getAccessToken();
    this.logger('[getStreamTicket] Access token obtained');

    const requestBody = {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      subscriptions: [
        {
          type: 'EVENT',
          topic: '*',
        },
        {
          type: 'CALLBACK',
          topic: '/v1.0/im/bot/messages/get',
        },
      ],
      ua: 'claude-code-dingtalk-channel/0.1.0',
    };

    this.logger('[getStreamTicket] Requesting stream ticket...');
    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/gateway/connections/open`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify(requestBody),
      }
    );

    const data = await response.json() as { endpoint: string; ticket: string; errcode?: number; errmsg?: string };
    this.logger('[getStreamTicket] Response: ' + JSON.stringify({ status: response.status, data }));

    if (data.errcode && data.errcode !== 0) {
      throw new Error(`Failed to get stream ticket: ${data.errmsg}`);
    }

    this.logger('[getStreamTicket] Stream ticket obtained: ' + JSON.stringify({ endpoint: data.endpoint, ticket: data.ticket?.substring(0, 20) + '...' }));
    return { endpoint: data.endpoint, ticket: data.ticket };
  }

  /**
   * 启动 peer-message 轮询
   * 每 5 秒检查一次自己的 bot_{profileName}.json
   * 处理 createdAt + 10秒 <= now 的消息
   */
  private startPeerMessagePolling(): void {
    this.logger(`Starting peer message polling for profile: ${this.profileName}`);

    this.peerPollTimer = setInterval(() => {
      this.processPeerMessages().catch((error) => {
        this.logger(`Error processing peer messages: ${error}`);
      });
    }, 5000);
  }

  /**
   * 处理 peer-messages
   * 找到 createdAt + 10秒 <= now 的消息，走 Claude CLI 流程
   */
  private async processPeerMessages(): Promise<void> {
    const messages = loadPeerMessages(this.claudetalkDir, this.profileName);
    if (messages.length === 0) return;

    const now = Date.now();
    const DELAY_MS = 10 * 1000; // 10秒延迟，等待消息稳定

    const pendingMessages = messages.filter(
      (msg: DingTalkPeerMessage) =>
        !this.processedPeerIds.has(msg.id) && now - msg.createdAt >= DELAY_MS
    );

    if (pendingMessages.length === 0) return;

    this.logger(`Processing ${pendingMessages.length} peer messages for profile: ${this.profileName}`);

    for (const peerMsg of pendingMessages) {
      this.processedPeerIds.add(peerMsg.id);

      if (this.channelMessageHandler) {
        const context: ChannelMessageContext = {
          conversationId: peerMsg.conversationId,
          senderId: peerMsg.from,
          isGroup: true,
          userId: peerMsg.from,
        };

        try {
          await this.channelMessageHandler(context, peerMsg.message);
          this.logger(`Peer message processed: id=${peerMsg.id}, from=${peerMsg.from}`);
        } catch (error) {
          this.logger(`Failed to process peer message id=${peerMsg.id}: ${error}`);
        }
      }
    }

    // 原子删除已处理的消息，并从内存集合中移除（避免集合无限增长）
    removePeerMessages(this.claudetalkDir, this.profileName, this.processedPeerIds);
    for (const peerMsg of pendingMessages) {
      this.processedPeerIds.delete(peerMsg.id);
    }
  }

  /**
   * 构建群聊上下文消息（用于注入 Claude 的 prompt）
   * 读取 context-message.template，填充历史记录、发送者信息、@列表等变量后返回完整字符串
   *
   * 模板查找顺序：
   *   1. {workDir}/.claudetalk/dingtalk/context-message.template（用户自定义）
   *   2. dist/channels/dingtalk/context-message.template（内置默认）
   */
  private buildContextMessage(callback: DingTalkInboundCallback, messageText: string): string {
    const conversationId = callback.conversationId;

    // 读取历史记录（最近 10 条，按时间正序）
    const allHistory = loadChatHistory(this.claudetalkDir, conversationId);
    // 过滤掉当前这条消息（刚写入的最后一条），避免重复
    const historyWithoutCurrent = allHistory.slice(0, -1).slice(-10);
    const historySection = historyWithoutCurrent.length > 0
      ? formatChatHistory(historyWithoutCurrent)
      : '（暂无历史消息）';

    // 构建发送者信息
    const senderInfo = `${callback.senderId}`;

    // 构建 @列表段落（钉钉消息体中 atUserIds 包含被@的用户 ID 列表）
    const atUserIds = callback.atUserIds || [];
    const mentionsSection = atUserIds.length > 0
      ? `- **提及了**: ${atUserIds.join(', ')}`
      : '';

    // 读取模板文件：优先用户自定义，其次内置默认
    const userTemplatePath = path.join(this.claudetalkDir, 'template', 'context-message.template');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const builtinTemplatePath = path.join(__dirname, '../../template/context-message.template');

    let templateContent: string;
    if (fs.existsSync(userTemplatePath)) {
      templateContent = fs.readFileSync(userTemplatePath, 'utf-8');
      this.logger(`Using user template: ${userTemplatePath}`);
    } else if (fs.existsSync(builtinTemplatePath)) {
      templateContent = fs.readFileSync(builtinTemplatePath, 'utf-8');
      this.logger(`Using builtin template: ${builtinTemplatePath}`);
    } else {
      this.logger(`Template not found at ${userTemplatePath} or ${builtinTemplatePath}, skipping context build`);
      return messageText;
    }

    // subagentEnabled 时 Claude Code 从 agent.md 读取角色信息，无需再注入 profileName 和 systemPrompt
    const currentConfig = loadConfig(this.config.workDir || process.cwd(), this.profileName);
    const subagentEnabled = currentConfig?.subagentEnabled ?? false;
    const profileNameValue = subagentEnabled ? '' : this.profileName;
    const systemPromptValue = subagentEnabled ? '' : (this.config.systemPrompt || '');
    this.logger(`subagentEnabled=${subagentEnabled}, role header=${subagentEnabled ? 'skipped (agent.md)' : 'injected'}`);

    // 替换模板变量
    const result = templateContent
      .replace(/\{\{profileName\}\}/g, profileNameValue)
      .replace(/\{\{systemPrompt\}\}/g, systemPromptValue)
      .replace(/\{\{senderInfo\}\}/g, senderInfo)
      .replace(/\{\{messageText\}\}/g, messageText)
      .replace(/\{\{mentionsSection\}\}/g, mentionsSection)
      .replace(/\{\{historySection\}\}/g, historySection);

    this.logger(`Context message built: length=${result.length}, historyCount=${historyWithoutCurrent.length}`);
    return result;
  }

  /**
   * 启动 Stream WebSocket 连接，开始接收钉钉消息
   */
  async start(): Promise<void> {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error(
        'Missing required environment variables.\n' +
        'Please set:\n' +
        '  export DINGTALK_CLIENT_ID=your_app_key\n' +
        '  export DINGTALK_CLIENT_SECRET=your_app_secret'
      );
    }
    this.logger('Connecting to DingTalk Stream...');

    this.isManuallyClosed = false;
    this.reconnectDelayMs = 3000;

    // 启动 peer-message 轮询
    this.startPeerMessagePolling();

    // 启动连接
    await this.connectStream();
  }

  /**
   * 停止 WebSocket 连接
   */
  stop(): void {
    this.isManuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.peerPollTimer) {
      clearInterval(this.peerPollTimer);
      this.peerPollTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.logger('DingTalk Stream stopped');
  }

  /**
   * 建立 WebSocket Stream 连接
   */
  private async connectStream(): Promise<void> {
    const { endpoint, ticket } = await this.getStreamTicket();

    const wsUrl = `${endpoint}?ticket=${encodeURIComponent(ticket)}`;
    this.logger(`Connecting to DingTalk Stream endpoint: ${endpoint}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.logger('DingTalk Stream connected');
        // 重置重连延迟
        this.reconnectDelayMs = 3000;
        resolve();
      };

      ws.onmessage = async (event) => {
        try {
          const frame = JSON.parse(event.data as string) as DingTalkStreamFrame;
          await this.handleStreamFrame(ws, frame);
        } catch (error) {
          this.logger(`Failed to handle stream frame: ${error}`);
        }
      };

      ws.onerror = (error) => {
        this.logger('DingTalk Stream WebSocket error: ' + JSON.stringify(error));
        this.logger(`[ws.onerror] Error type: ${(error as any)?.type}`);
        this.logger(`[ws.onerror] Error message: ${(error as any)?.message}`);
        // 错误不 reject，等待 onclose 处理重连
      };

      ws.onclose = (event) => {
        this.logger(`DingTalk Stream disconnected: code=${event.code}, reason=${event.reason}`);
        this.ws = null;

        // 如果不是手动关闭，则自动重连
        // 重置退避延迟，避免之前退避到最大值后断线重连还要等很久
        if (!this.isManuallyClosed) {
          this.reconnectDelayMs = 3000;
          this.logger(`[ws.onclose] Scheduling reconnect in ${this.reconnectDelayMs}ms...`);
          this.reconnectTimer = setTimeout(() => {
            this.startReconnectLoop();
          }, this.reconnectDelayMs);
        }
      };
    });
  }

  /**
   * 启动重连循环，持续重连直到成功或手动停止
   */
  private startReconnectLoop(): void {
    const attemptReconnect = async (): Promise<void> => {
      try {
        this.logger(`[reconnect] Attempting to connect...`);
        await this.connectStream();
        this.logger(`[reconnect] Connected successfully`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger(`[reconnect] Reconnect failed: ${errorMessage}`);
        this.logger(`[reconnect] Error details: ${JSON.stringify(error)}`);
        
        // 指数退避，最大 60 秒
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60000);
        
        // 继续尝试重连
        if (!this.isManuallyClosed) {
          this.logger(`[reconnect] Will retry in ${this.reconnectDelayMs}ms...`);
          this.reconnectTimer = setTimeout(attemptReconnect, this.reconnectDelayMs);
        }
      }
    };

    attemptReconnect();
  }

  /**
   * 处理 Stream 帧
   */
  private async handleStreamFrame(ws: WebSocket, frame: DingTalkStreamFrame): Promise<void> {
    const { type, headers, data } = frame;
    this.logger(`[stream] frame: type=${type}, topic=${headers?.topic}, data=${data?.substring(0, 200)}`);

    // 回复 ACK
    const ack = {
      code: 200,
      headers: {
        contentType: 'application/json',
        messageId: headers.messageId,
        time: String(Date.now()),
      },
      message: 'OK',
      data: '',
    };

    if (type === 'SYSTEM') {
      // 系统消息（心跳等）
      if (headers.topic === 'ping') {
        ws.send(JSON.stringify({ ...ack, data: 'pong' }));
      } else {
        ws.send(JSON.stringify(ack));
      }
      return;
    }

    if (type === 'CALLBACK' && headers.topic === '/v1.0/im/bot/messages/get') {
      // 先立即回 ACK，避免阻塞 WebSocket 帧循环（Claude 处理消息可能需要数十秒）
      ws.send(JSON.stringify(ack));

      // 异步处理消息，不阻塞当前帧循环，确保心跳等帧能正常响应
      Promise.resolve().then(async () => {
        try {
          const callback = JSON.parse(data) as DingTalkInboundCallback;
          await this.handleInboundMessage(callback);
        } catch (error) {
          this.logger(`Failed to parse inbound message: ${error}`);
        }
      });
      return;
    }

    // 其他类型，统一回 ACK
    ws.send(JSON.stringify(ack));
  }

  /**
   * 处理收到的钉钉消息，转发给 Claude Code
   */
  private async handleInboundMessage(callback: DingTalkInboundCallback): Promise<void> {
    const isGroup = callback.conversationType === '2';

    // 群聊策略检查
    if (isGroup) {
      const groupPolicy = this.config.groupPolicy || 'open';
      if (groupPolicy === 'disabled') {
        this.logger('Group chat is disabled, ignoring message');
        return;
      }
      if (groupPolicy === 'allowlist') {
        const groupAllowFrom = this.config.groupAllowFrom || this.config.allowFrom || [];
        if (!groupAllowFrom.includes(callback.senderId)) {
          this.logger(`Sender ${callback.senderId} not in group allowlist, ignoring`);
          return;
        }
      }
    } else {
      // 私聊策略检查
      const dmPolicy = this.config.dmPolicy || 'open';
      if (dmPolicy === 'allowlist') {
        const allowFrom = this.config.allowFrom || [];
        if (!allowFrom.includes(callback.senderId)) {
          this.logger(`Sender ${callback.senderId} not in allowlist, ignoring`);
          return;
        }
      }
    }

    // 解析消息内容：钉钉文本消息在 text.content 字段里
    let messageText = '';
    if (callback.text?.content) {
      messageText = callback.text.content.trim();
    } else if (callback.msgtype === 'richText' && callback.content) {
      try {
        const parsed = JSON.parse(callback.content);
        messageText = parsed.content || parsed.text || JSON.stringify(parsed);
      } catch {
        messageText = callback.content;
      }
    } else if (callback.content) {
      messageText = callback.content;
    }

    if (!messageText.trim()) {
      this.logger('Empty message content, ignoring');
      return;
    }

    this.logger(`Received message from ${callback.senderId} in ${callback.conversationId}: ${messageText}`);

    // 群聊消息写入历史记录
    if (isGroup) {
      appendChatHistory(this.claudetalkDir, callback.conversationId, {
        timestamp: callback.createTime || Date.now(),
        role: 'user',
        senderId: callback.senderId,
        content: messageText,
      });
    }

    if (this.channelMessageHandler) {
      // 群聊时构建上下文 prompt（读取模板、历史记录、@列表等）
      let contextMessage: string | undefined;
      if (isGroup) {
        this.logger('Group chat detected, building context message...');
        try {
          contextMessage = this.buildContextMessage(callback, messageText);
          this.logger('Context message built successfully');
        } catch (error) {
          this.logger(`Failed to build context message: ${error}`);
        }
      }

      // 私聊时缓存 conversationId → senderStaffId（发送回复时需要员工 staffId，senderId 是加密ID不能用）
      if (!isGroup && callback.senderStaffId) {
        this.privateSenderCache.set(callback.conversationId, callback.senderStaffId);
      }

      const context: ChannelMessageContext = {
        conversationId: callback.conversationId,
        senderId: callback.senderId,
        isGroup,
        userId: callback.senderStaffId || '',
        processedMessage: contextMessage,
      };
      await this.channelMessageHandler(context, messageText);
    }
  }

  /**
   * 发送消息（实现 Channel 接口，自动判断私聊/群聊，自动选择消息类型）
   * 发送成功后：
   *   - 群聊：写入历史记录 + 解析 @标签写入 peer-message
   */
  async sendMessage(
    conversationId: string,
    content: string,
    isGroup: boolean
  ): Promise<void> {
    const messageType = this.config.messageType || 'markdown';

    if (messageType === 'card' && this.config.cardTemplateId) {
      await this.createAICard(conversationId, content);
    } else {
      await this.sendMarkdownMessage(conversationId, content, isGroup);
    }

    // 群聊：写入历史记录 + 解析 @标签写入 peer-message
    if (isGroup) {
      appendChatHistory(this.claudetalkDir, conversationId, {
        timestamp: Date.now(),
        role: 'bot',
        senderId: this.profileName,
        content,
      });

      const knownProfiles = this.config.knownProfiles || [];
      if (knownProfiles.length > 0) {
        writePeerMessagesFromContent(
          this.claudetalkDir,
          conversationId,
          content,
          this.profileName,
          knownProfiles
        );
      }
    }
  }

  /**
   * 发送单聊消息
   */
  async sendPrivateMessage(
    userId: string,
    content: string,
    msgKey: string = 'text'
  ): Promise<DingTalkSendResponse> {
    const accessToken = await this.getAccessToken();
    const robotCode = this.config.robotCode || this.config.clientId;

    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify({
          robotCode,
          userIds: [userId],
          msgKey,
          msgParam: JSON.stringify({ content }),
        }),
      }
    );

    return response.json();
  }

  /**
   * 发送群聊消息
   */
  async sendGroupMessage(
    conversationId: string,
    content: string,
    msgKey: string = 'text'
  ): Promise<DingTalkSendResponse> {
    const accessToken = await this.getAccessToken();
    const robotCode = this.config.robotCode || this.config.clientId;

    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify({
          robotCode,
          openConversationId: conversationId,
          msgKey,
          msgParam: JSON.stringify({ content }),
        }),
      }
    );

    return response.json();
  }

  /**
   * 发送 Markdown 消息
   * 注意：不能复用 sendGroupMessage/sendPrivateMessage，因为它们会把 content 包成 { content: ... }，
   * 而 sampleMarkdown 的 msgParam 格式是 { title, text }，需要直接构造请求体。
   */
  async sendMarkdownMessage(
    conversationId: string,
    content: string,
    isGroup: boolean
  ): Promise<DingTalkSendResponse> {
    const accessToken = await this.getAccessToken();
    const robotCode = this.config.robotCode || this.config.clientId;
    const msgKey = 'sampleMarkdown';
    const msgParam = JSON.stringify({
      title: 'Claude Code',
      text: content,
    });

    if (isGroup) {
      const response = await fetch(
        `${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-acs-dingtalk-access-token': accessToken,
          },
          body: JSON.stringify({
            robotCode,
            openConversationId: conversationId,
            msgKey,
            msgParam,
          }),
        }
      );
      const result = await response.json() as DingTalkSendResponse;
      if (!response.ok || result.errcode) {
        this.logger(`[sendMarkdownMessage] Group send failed: status=${response.status}, errcode=${result.errcode}, errmsg=${result.errmsg}`);
      } else {
        this.logger(`[sendMarkdownMessage] Group send success: conversationId=${conversationId}`);
      }
      return result;
    } else {
      // 私聊时需要用用户 open_id（senderId）而非会话 ID（conversationId）
      const userId = this.privateSenderCache.get(conversationId) || conversationId;
      if (!this.privateSenderCache.has(conversationId)) {
        this.logger(`[sendMarkdownMessage] No cached senderId for conversationId=${conversationId}, falling back to conversationId as userId`);
      }
      const response = await fetch(
        `${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-acs-dingtalk-access-token': accessToken,
          },
          body: JSON.stringify({
            robotCode,
            userIds: [userId],
            msgKey,
            msgParam,
          }),
        }
      );
      const result = await response.json() as DingTalkSendResponse;
      if (!response.ok || result.errcode) {
        this.logger(`[sendMarkdownMessage] Private send failed: status=${response.status}, errcode=${result.errcode}, errmsg=${result.errmsg}, userId=${userId}`);
      } else {
        this.logger(`[sendMarkdownMessage] Private send success: conversationId=${conversationId}, userId=${userId}`);
      }
      return result;
    }
  }

  /**
   * 创建并投放 AI 卡片
   */
  async createAICard(
    conversationId: string,
    content: string
  ): Promise<AICardInstance> {
    const accessToken = await this.getAccessToken();
    const robotCode = this.config.robotCode || this.config.clientId;
    const templateId = this.config.cardTemplateId || '';
    const templateKey = this.config.cardTemplateKey || 'content';

    const request: AICardCreateRequest = {
      cardTemplateId: templateId,
      outTrackId: `claude-code-${Date.now()}`,
      openConversationId: conversationId,
      cardData: {
        cardParam: {},
        cardDataModel: {
          [templateKey]: content,
        },
      },
      dynamicSummary: content.substring(0, 100),
    };

    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/card/instances/createAndDeliver`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify({
          robotCode,
          ...request,
        }),
      }
    );

    const data = await response.json();

    if (data.errcode !== 0) {
      throw new Error(`Failed to create AI card: ${data.errmsg}`);
    }

    return {
      cardInstanceId: data.cardInstanceId,
      conversationId,
      processQueryKey: data.processQueryKey,
      templateId,
    };
  }

  /**
   * 流式更新 AI 卡片
   */
  async streamAICard(
    card: AICardInstance,
    content: string,
    isFinalize: boolean = false
  ): Promise<void> {
    const accessToken = await this.getAccessToken();
    const templateKey = this.config.cardTemplateKey || 'content';

    const request: AICardStreamingRequest = {
      cardInstanceId: card.cardInstanceId,
      outTrackId: `claude-code-${Date.now()}`,
      cardData: {
        cardParam: {},
        cardDataModel: {
          [templateKey]: content,
        },
      },
      isFinalize,
      dynamicSummary: content.substring(0, 100),
    };

    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/card/streaming`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify(request),
      }
    );

    const data = await response.json();

    if (data.errcode !== 0) {
      throw new Error(`Failed to stream AI card: ${data.errmsg}`);
    }
  }

  /**
   * 下载媒体文件
   */
  async downloadMedia(downloadCode: string): Promise<Buffer> {
    const accessToken = await this.getAccessToken();
    const robotCode = this.config.robotCode || this.config.clientId;

    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/robot/media/download?downloadCode=${downloadCode}&robotCode=${robotCode}`,
      {
        headers: {
          'x-acs-dingtalk-access-token': accessToken,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to download media: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * 发送媒体消息
   */
  async sendMediaMessage(
    conversationId: string,
    mediaBuffer: Buffer,
    mediaType: 'image' | 'voice' | 'video' | 'file',
    fileName: string,
    isGroup: boolean
  ): Promise<DingTalkSendResponse> {
    const accessToken = await this.getAccessToken();
    const robotCode = this.config.robotCode || this.config.clientId;

    // 1. 上传媒体文件
    const formData = new FormData();
    formData.append('media', new Blob([new Uint8Array(mediaBuffer)]), fileName);
    formData.append('type', mediaType);

    const uploadResponse = await fetch(
      `${DINGTALK_API_BASE}/v1.0/robot/media/upload?robotCode=${robotCode}`,
      {
        method: 'POST',
        headers: {
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: formData,
      }
    );

    const uploadData = await uploadResponse.json();

    if (uploadData.errcode !== 0) {
      throw new Error(`Failed to upload media: ${uploadData.errmsg}`);
    }

    const mediaId = uploadData.mediaId;

    // 2. 发送媒体消息
    const msgKeyMap = {
      image: 'sampleImageMsg',
      voice: 'sampleAudio',
      video: 'sampleVideo',
      file: 'sampleFile',
    };

    const msgParam = {
      mediaId,
    };

    if (isGroup) {
      return this.sendGroupMessage(
        conversationId,
        JSON.stringify(msgParam),
        msgKeyMap[mediaType]
      );
    } else {
      return this.sendPrivateMessage(
        conversationId,
        JSON.stringify(msgParam),
        msgKeyMap[mediaType]
      );
    }
  }
}

// ========== Channel 自注册 ==========

registerChannel({
  type: 'dingtalk',
  label: '钉钉机器人',
  configFields: [
    {
      key: 'DINGTALK_CLIENT_ID',
      label: 'DINGTALK_CLIENT_ID (AppKey)',
      required: true,
      hint: '在钉钉开放平台 (https://open-dev.dingtalk.com) 创建应用获取',
    },
    {
      key: 'DINGTALK_CLIENT_SECRET',
      label: 'DINGTALK_CLIENT_SECRET (AppSecret)',
      required: true,
      secret: true,
    },
  ],
  create(config: Record<string, string>) {
    return new DingTalkClient({
      clientId: config.DINGTALK_CLIENT_ID,
      clientSecret: config.DINGTALK_CLIENT_SECRET,
      robotCode: config.DINGTALK_CLIENT_ID,
      profileName: config.profileName,
      workDir: config.workDir,
      systemPrompt: config.systemPrompt,
      knownProfiles: config.knownProfiles ? JSON.parse(config.knownProfiles) : undefined,
    })
  },
})
