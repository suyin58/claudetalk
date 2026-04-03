/**
 * DingTalk Chat History - 群聊历史记录文件中转机制
 *
 * 由于钉钉 API 不支持拉取群聊历史消息，通过本地文件记录历史消息
 * 每个群会话对应一个文件：{claudetalkDir}/dingtalk/history_{conversationId}.json
 * 最多保存 50 条记录，超过上限时删除最早的若干条（保持总数不超过上限）
 *
 * 文件路径：{claudetalkDir}/dingtalk/history_{conversationId}.json
 * 原子写入：写入临时文件后 rename，避免并发写覆盖
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('dingtalk', 'chat-history');

/** 历史消息条数上限 */
const MAX_HISTORY_SIZE = 50;

// ========== 类型定义 ==========

/** 消息来源类型 */
export type MessageRole = 'user' | 'bot';

/** 历史消息条目 */
export interface ChatHistoryEntry {
  /** 消息时间戳（ms） */
  timestamp: number;
  /** 消息来源：user=用户，bot=机器人 */
  role: MessageRole;
  /** 发送者标识（用户 ID 或机器人 profile 名称） */
  senderId: string;
  /** 消息内容 */
  content: string;
}

// ========== 文件路径 ==========

/**
 * 获取 dingtalk 目录路径
 */
function getDingTalkDir(claudetalkDir: string): string {
  return path.join(claudetalkDir, 'dingtalk');
}

/**
 * 获取指定会话的历史记录文件路径
 * conversationId 中可能含有特殊字符，做简单 base64 编码保证文件名安全
 */
export function getChatHistoryFilePath(claudetalkDir: string, conversationId: string): string {
  // 钉钉 conversationId 通常是 cid 格式，直接替换不安全字符
  const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getDingTalkDir(claudetalkDir), `history_${safeId}.json`);
}

// ========== 读写操作 ==========

/**
 * 读取指定会话的历史记录
 */
export function loadChatHistory(claudetalkDir: string, conversationId: string): ChatHistoryEntry[] {
  const filePath = getChatHistoryFilePath(claudetalkDir, conversationId);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as ChatHistoryEntry[];
    }
  } catch (error) {
    logger(`[chat-history] Failed to load history for ${conversationId}: ${JSON.stringify(error)}`);
  }
  return [];
}

/**
 * 原子写入历史记录
 * 先写入临时文件，再 rename 替换，避免并发写覆盖
 */
function atomicWriteChatHistory(
  claudetalkDir: string,
  conversationId: string,
  entries: ChatHistoryEntry[]
): void {
  const filePath = getChatHistoryFilePath(claudetalkDir, conversationId);
  const tmpFilePath = `${filePath}.tmp`;

  const dingtalkDir = getDingTalkDir(claudetalkDir);
  if (!fs.existsSync(dingtalkDir)) {
    fs.mkdirSync(dingtalkDir, { recursive: true });
  }

  fs.writeFileSync(tmpFilePath, JSON.stringify(entries, null, 2), 'utf-8');
  fs.renameSync(tmpFilePath, filePath);
}

/**
 * 追加一条历史记录
 * 超过 MAX_HISTORY_SIZE 条时，删除最早的一条（按 timestamp 排序）
 */
export function appendChatHistory(
  claudetalkDir: string,
  conversationId: string,
  entry: ChatHistoryEntry
): void {
  const entries = loadChatHistory(claudetalkDir, conversationId);
  entries.push(entry);

  // 超出上限时，删除最早的若干条（历史记录按追加顺序已是时间有序，直接从头截取）
  if (entries.length > MAX_HISTORY_SIZE) {
    const removeCount = entries.length - MAX_HISTORY_SIZE;
    entries.splice(0, removeCount);
    logger(
      `[chat-history] History for ${conversationId} exceeded ${MAX_HISTORY_SIZE}, removed ${removeCount} oldest entries`
    );
  }

  atomicWriteChatHistory(claudetalkDir, conversationId, entries);
  logger(
    `[chat-history] Appended ${entry.role} message to history_${conversationId}: senderId=${entry.senderId}, content=${entry.content.substring(0, 50)}`
  );
}

/**
 * 将历史记录格式化为可读文本，供注入到 Claude 上下文中
 * 格式：[时间] 角色(发送者): 内容
 */
export function formatChatHistory(entries: ChatHistoryEntry[]): string {
  if (entries.length === 0) return '';

  const lines = entries.map((entry) => {
    const time = new Date(entry.timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const roleLabel = entry.role === 'user' ? '用户' : '机器人';
    return `[${time}] ${roleLabel}(${entry.senderId}): ${entry.content}`;
  });

  return lines.join('\n');
}
