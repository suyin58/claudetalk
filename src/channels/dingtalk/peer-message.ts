/**
 * DingTalk Peer Message 协作机制
 *
 * 解决钉钉平台限制：机器人无法收到其他机器人发送的消息（即使被@了也收不到）
 * 通过共享文件（bot_{profileName}.json）实现同机器上多个 ClaudeTalk 实例之间的协作
 *
 * 文件路径：{claudetalkDir}/dingtalk/bot_{profileName}.json
 * 原子写入：写入临时文件后 rename，避免并发写覆盖
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('dingtalk', 'peer-message');

// ========== 类型定义 ==========

export interface DingTalkPeerMessage {
  /** 消息唯一 ID */
  id: string;
  /** 发送方 profile 名称 */
  from: string;
  /** 群会话 ID */
  conversationId: string;
  /** 消息内容（包含 @标签的原始文本） */
  message: string;
  /** 创建时间戳（ms） */
  createdAt: number;
}

// ========== 文件路径 ==========

/**
 * 获取 dingtalk 目录路径
 */
function getDingTalkDir(claudetalkDir: string): string {
  return path.join(claudetalkDir, 'dingtalk');
}

/**
 * 获取指定 profileName 的 peer-message 文件路径
 */
export function getPeerMessageFilePath(claudetalkDir: string, profileName: string): string {
  return path.join(getDingTalkDir(claudetalkDir), `bot_${profileName}.json`);
}

// ========== 读写操作 ==========

/**
 * 读取指定 profileName 的 peer-messages
 */
export function loadPeerMessages(claudetalkDir: string, profileName: string): DingTalkPeerMessage[] {
  const filePath = getPeerMessageFilePath(claudetalkDir, profileName);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as DingTalkPeerMessage[];
    }
  } catch (error) {
    logger(`[peer-message] Failed to load bot_${profileName}.json: ${JSON.stringify(error)}`);
  }
  return [];
}

/**
 * 原子写入 peer-messages 到指定 profileName 的文件
 * 先写入临时文件，再 rename 替换，避免并发写覆盖
 */
function atomicWritePeerMessages(
  claudetalkDir: string,
  profileName: string,
  messages: DingTalkPeerMessage[]
): void {
  const filePath = getPeerMessageFilePath(claudetalkDir, profileName);
  const tmpFilePath = `${filePath}.tmp`;

  const dingtalkDir = getDingTalkDir(claudetalkDir);
  if (!fs.existsSync(dingtalkDir)) {
    fs.mkdirSync(dingtalkDir, { recursive: true });
  }

  fs.writeFileSync(tmpFilePath, JSON.stringify(messages, null, 2), 'utf-8');
  fs.renameSync(tmpFilePath, filePath);
}

/**
 * 追加一条 peer-message 到指定 profileName 的文件
 */
export function appendPeerMessage(
  claudetalkDir: string,
  profileName: string,
  message: DingTalkPeerMessage
): void {
  const existingMessages = loadPeerMessages(claudetalkDir, profileName);
  existingMessages.push(message);
  atomicWritePeerMessages(claudetalkDir, profileName, existingMessages);
  logger(`[peer-message] Appended message to bot_${profileName}.json: id=${message.id}, from=${message.from}`);
}

/**
 * 删除已处理的 peer-messages（根据 id 集合过滤）
 */
export function removePeerMessages(
  claudetalkDir: string,
  profileName: string,
  processedIds: Set<string>
): void {
  const existingMessages = loadPeerMessages(claudetalkDir, profileName);
  const remainingMessages = existingMessages.filter((msg) => !processedIds.has(msg.id));
  atomicWritePeerMessages(claudetalkDir, profileName, remainingMessages);
  logger(
    `[peer-message] Removed ${existingMessages.length - remainingMessages.length} processed messages from bot_${profileName}.json`
  );
}

// ========== @标签解析 ==========

/**
 * 解析消息内容中的 @机器人名称
 * 钉钉消息中 @机器人 的文本格式为：@机器人名称（空格分隔）
 * 例如："@ClaudeA 帮我分析一下这段代码"
 * 返回被@的名称列表
 */
export function parseAtMentions(messageText: string): string[] {
  const atPattern = /@(\S+)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = atPattern.exec(messageText)) !== null) {
    mentions.push(match[1]);
  }
  return mentions;
}

// ========== 写入 peer-message ==========

/**
 * 发送消息成功后，解析 @标签，将 peer-message 写入被@机器人的文件
 *
 * @param claudetalkDir - .claudetalk 目录路径
 * @param conversationId - 钉钉群会话 ID
 * @param messageText - 发送的消息内容
 * @param fromProfile - 发送方 profile 名称
 * @param knownProfiles - 当前已知的所有 profile 名称列表（用于匹配被@的机器人）
 */
export function writePeerMessagesFromContent(
  claudetalkDir: string,
  conversationId: string,
  messageText: string,
  fromProfile: string,
  knownProfiles: string[]
): void {
  const mentionedNames = parseAtMentions(messageText);
  if (mentionedNames.length === 0) return;

  for (const mentionedName of mentionedNames) {
    // 在已知 profile 列表中查找匹配的机器人（忽略大小写）
    const matchedProfile = knownProfiles.find(
      (profile) => profile.toLowerCase() === mentionedName.toLowerCase()
    );

    if (!matchedProfile) {
      logger(`[peer-message] No profile matched for mention: @${mentionedName}`);
      continue;
    }

    // 不给自己写 peer-message
    if (matchedProfile === fromProfile) {
      logger(`[peer-message] Skipping self-mention: @${mentionedName}`);
      continue;
    }

    const peerMessage: DingTalkPeerMessage = {
      id: randomUUID(),
      from: fromProfile,
      conversationId,
      message: messageText,
      createdAt: Date.now(),
    };

    appendPeerMessage(claudetalkDir, matchedProfile, peerMessage);
    logger(
      `[peer-message] Wrote peer message to bot_${matchedProfile}.json: conversationId=${conversationId}, from=${fromProfile}`
    );
  }
}
