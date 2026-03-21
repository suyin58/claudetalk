/**
 * Claude Code DingTalk Channel - 钉钉 API 客户端
 */

import type {
  DingTalkChannelConfig,
  DingTalkTokenResponse,
  DingTalkSendResponse,
  AICardInstance,
  AICardCreateRequest,
  AICardStreamingRequest,
  DingTalkInboundCallback,
} from './types.js';

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

// 消息到达时的回调函数类型
type MessageHandler = (callback: DingTalkInboundCallback) => Promise<void>;

/**
 * 钉钉 API 客户端
 */
export class DingTalkClient {
  private config: DingTalkChannelConfig;
  private tokenCache: { accessToken: string; expiresAt: number } | null = null;
  private messageHandler: MessageHandler | null = null;
  private ws: WebSocket | null = null;

  constructor(config: DingTalkChannelConfig) {
    this.config = config;
  }

  /**
   * 注册消息处理回调
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
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
    const accessToken = await this.getAccessToken();

    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/gateway/connections/open`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify({
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
        }),
      }
    );

    const data = await response.json() as { endpoint: string; ticket: string; errcode?: number; errmsg?: string };

    if (data.errcode && data.errcode !== 0) {
      throw new Error(`Failed to get stream ticket: ${data.errmsg}`);
    }

    return { endpoint: data.endpoint, ticket: data.ticket };
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
    console.error('Connecting to DingTalk Stream...');

    const connectWithRetry = async (retryDelayMs: number = 3000): Promise<void> => {
      try {
        await this.connectStream();
      } catch (error) {
        console.error(`DingTalk Stream connection error: ${error}, retrying in ${retryDelayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        // 指数退避，最大 60 秒
        const nextDelay = Math.min(retryDelayMs * 2, 60000);
        await connectWithRetry(nextDelay);
      }
    };

    await connectWithRetry();
  }

  /**
   * 建立 WebSocket Stream 连接
   */
  private async connectStream(): Promise<void> {
    const { endpoint, ticket } = await this.getStreamTicket();

    const wsUrl = `${endpoint}?ticket=${encodeURIComponent(ticket)}`;
    console.error(`Connecting to DingTalk Stream endpoint: ${endpoint}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        console.error('DingTalk Stream connected');
        resolve();
      };

      ws.onmessage = async (event) => {
        try {
          const frame = JSON.parse(event.data as string) as DingTalkStreamFrame;
          await this.handleStreamFrame(ws, frame);
        } catch (error) {
          console.error(`Failed to handle stream frame: ${error}`);
        }
      };

      ws.onerror = (error) => {
        console.error(`DingTalk Stream WebSocket error: ${error}`);
        reject(error);
      };

      ws.onclose = (event) => {
        console.error(`DingTalk Stream disconnected: code=${event.code}, reason=${event.reason}`);
        this.ws = null;
        reject(new Error(`WebSocket closed: ${event.code}`));
      };
    });
  }

  /**
   * 处理 Stream 帧
   */
  private async handleStreamFrame(ws: WebSocket, frame: DingTalkStreamFrame): Promise<void> {
    const { type, headers, data } = frame;
    // 调试：把所有收到的帧写到日志文件
    const fs = await import('fs');
    fs.appendFileSync('/tmp/dingtalk_frames.log', JSON.stringify({ type, topic: headers?.topic, data }) + '\n');

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
      // 机器人收到消息
      ws.send(JSON.stringify(ack));

      try {
        const callback = JSON.parse(data) as DingTalkInboundCallback;
        await this.handleInboundMessage(callback);
      } catch (error) {
        console.error(`Failed to parse inbound message: ${error}`);
      }
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
        console.error('Group chat is disabled, ignoring message');
        return;
      }
      if (groupPolicy === 'allowlist') {
        const groupAllowFrom = this.config.groupAllowFrom || this.config.allowFrom || [];
        if (!groupAllowFrom.includes(callback.senderId)) {
          console.error(`Sender ${callback.senderId} not in group allowlist, ignoring`);
          return;
        }
      }
    } else {
      // 私聊策略检查
      const dmPolicy = this.config.dmPolicy || 'open';
      if (dmPolicy === 'allowlist') {
        const allowFrom = this.config.allowFrom || [];
        if (!allowFrom.includes(callback.senderId)) {
          console.error(`Sender ${callback.senderId} not in allowlist, ignoring`);
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
      console.error('Empty message content, ignoring');
      return;
    }

    console.error(`Received message from ${callback.senderId} in ${callback.conversationId}: ${messageText}`);

    if (this.messageHandler) {
      await this.messageHandler(callback);
    }
  }

  /**
   * 发送消息（自动判断私聊/群聊，自动选择消息类型）
   */
  async sendMessage(
    conversationId: string,
    content: string,
    isGroup: boolean
  ): Promise<DingTalkSendResponse> {
    const messageType = this.config.messageType || 'markdown';

    if (messageType === 'card' && this.config.cardTemplateId) {
      // AI 卡片模式
      const card = await this.createAICard(conversationId, content);
      return { errcode: 0, errmsg: 'ok', processQueryKeys: [card.processQueryKey] };
    }

    // 默认 Markdown 模式
    return this.sendMarkdownMessage(conversationId, content, isGroup);
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
   */
  async sendMarkdownMessage(
    conversationId: string,
    content: string,
    isGroup: boolean
  ): Promise<DingTalkSendResponse> {
    const msgKey = 'sampleMarkdown';
    const msgParam = {
      title: 'Claude Code',
      text: content,
    };

    if (isGroup) {
      return this.sendGroupMessage(conversationId, JSON.stringify(msgParam), msgKey);
    } else {
      return this.sendPrivateMessage(conversationId, JSON.stringify(msgParam), msgKey);
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
