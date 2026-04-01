/**
 * Peer Message 协作机制
 *
 * 解决飞书平台限制：机器人无法收到其他机器人发送的消息
 * 通过共享文件（bot_{botName}.json）实现同机器上多个 ClaudeTalk 实例之间的协作
 *
 * 文件路径：{claudetalkDir}/bot_{botName}.json
 * 原子写入：写入临时文件后 rename，避免并发写覆盖
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { PeerMessage } from '../../types.js';

// ========== 文件路径 ==========

/**
 * 获取指定 botName 的 peer-message 文件路径
 */
export function getPeerMessageFilePath(claudetalkDir: string, botName: string): string {
  return path.join(claudetalkDir, 'feishu', `bot_${botName}.json`);
}

// ========== 读写操作 ==========

/**
 * 读取指定 botName 的 peer-messages
 */
export function loadPeerMessages(claudetalkDir: string, botName: string): PeerMessage[] {
  const filePath = getPeerMessageFilePath(claudetalkDir, botName);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as PeerMessage[];
    }
  } catch (error) {
    console.error(`[peer-message] Failed to load bot_${botName}.json:`, error);
  }
  return [];
}

/**
 * 原子写入 peer-messages 到指定 botName 的文件
 * 先写入临时文件，再 rename 替换，避免并发写覆盖
 */
function atomicWritePeerMessages(claudetalkDir: string, botName: string, messages: PeerMessage[]): void {
  const filePath = getPeerMessageFilePath(claudetalkDir, botName);
  const tmpFilePath = `${filePath}.tmp`;

  const feishuDir = path.join(claudetalkDir, 'feishu');
  if (!fs.existsSync(feishuDir)) {
    fs.mkdirSync(feishuDir, { recursive: true });
  }

  fs.writeFileSync(tmpFilePath, JSON.stringify(messages, null, 2), 'utf-8');
  fs.renameSync(tmpFilePath, filePath);
}

/**
 * 追加一条 peer-message 到指定 botName 的文件
 * 使用原子写入防止并发覆盖
 */
export function appendPeerMessage(claudetalkDir: string, botName: string, message: PeerMessage): void {
  const existingMessages = loadPeerMessages(claudetalkDir, botName);
  existingMessages.push(message);
  atomicWritePeerMessages(claudetalkDir, botName, existingMessages);
  console.log(`[peer-message] Appended message to bot_${botName}.json: id=${message.id}, from=${message.from}`);
}

/**
 * 删除已处理的 peer-messages（根据 id 集合过滤）
 * 使用原子写入防止并发覆盖
 */
export function removePeerMessages(claudetalkDir: string, botName: string, processedIds: Set<string>): void {
  const existingMessages = loadPeerMessages(claudetalkDir, botName);
  const remainingMessages = existingMessages.filter((msg) => !processedIds.has(msg.id));
  atomicWritePeerMessages(claudetalkDir, botName, remainingMessages);
  console.log(`[peer-message] Removed ${existingMessages.length - remainingMessages.length} processed messages from bot_${botName}.json`);
}

// ========== @标签解析 ==========

/**
 * 解析消息内容中的 @标签，返回被@的用户/机器人列表
 * 支持格式：<at user_id="ou_xxx">名称</at>
 */
export function parseAtMentions(content: string): Array<{ userId: string; name: string }> {
  const atPattern = /<at user_id="([^"]+)">([^<]+)<\/at>/g;
  const mentions: Array<{ userId: string; name: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = atPattern.exec(content)) !== null) {
    mentions.push({ userId: match[1], name: match[2] });
  }
  return mentions;
}

// ========== 写入 peer-message ==========

/**
 * 发送消息成功后，解析 @标签，将 peer-message 写入被@机器人的文件
 * 根据 chat-members 中的 appId 匹配被@的机器人，找到对应的 botName（profile名）
 *
 * @param claudetalkDir - .claudetalk 目录路径
 * @param chatId - 飞书群 chat_id
 * @param messageId - 发送成功后的飞书消息 ID
 * @param content - 发送的消息内容（包含 @标签）
 * @param fromProfile - 发送方 profile 名称
 * @param chatMembers - 当前群的成员列表（从 chat-members.json 读取）
 */
export function writePeerMessagesFromContent(
  claudetalkDir: string,
  chatId: string,
  messageId: string,
  content: string,
  fromProfile: string,
  chatMembers: Array<{ name: string; type: string; appId?: string }>
): void {
  const mentions = parseAtMentions(content);
  if (mentions.length === 0) return;

  for (const mention of mentions) {
    // 根据 appId 匹配被@的机器人（机器人的 user_id 就是 appId，cli_ 开头）
    const matchedBot = chatMembers.find(
      (member) => member.type === 'bot' && member.appId === mention.userId
    );

    if (!matchedBot) {
      console.log(`[peer-message] No bot matched for mention: userId=${mention.userId}, name=${mention.name}`);
      continue;
    }

    // botName 就是 profile 名称，约定：chat-members.json 中机器人的 name 就是其 profile 名称
    const botName = matchedBot.name;

    const peerMessage: PeerMessage = {
      id: randomUUID(),
      from: fromProfile,
      chatId,
      messageId,
      message: content,
      createdAt: Date.now(),
    };

    appendPeerMessage(claudetalkDir, botName, peerMessage);
    console.log(`[peer-message] Wrote peer message to bot_${botName}.json: messageId=${messageId}, from=${fromProfile}`);
  }
}