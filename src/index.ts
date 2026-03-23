/**
 * Claude Code DingTalk Bot - 独立运行模式
 * 收到钉钉消息后，通过 claude -p CLI 调用 Claude Code 处理，并将回复发回钉钉
 * 支持多轮会话：每个 conversationId 维护独立的 session_id
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { DingTalkClient } from './dingtalk.js'
import type { DingTalkChannelConfig, DingTalkInboundCallback } from './types.js'

export interface StartBotOptions {
  clientId: string
  clientSecret: string
  workDir: string
  // 可选：角色名，用于隔离不同角色的 session（同一工作目录多角色互不干扰）
  profile?: string
  // 可选：角色描述，新建 session 时通过 --append-system-prompt 传给 Claude
  systemPrompt?: string
}

// ========== 日志 ==========
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.error(line)
}

// ========== 会话持久化 ==========
// 将 session 映射持久化到文件，重启后可恢复多轮对话
// key 格式: conversationId + '|' + workDir（区分不同工作目录的 session）
const SESSION_DIR = join(homedir(), '.claudetalk')
const SESSION_FILE = join(SESSION_DIR, 'sessions.json')

// session value 结构（兼容旧格式的纯字符串）
interface SessionEntry {
  sessionId: string
  lastActiveAt: number  // 时间戳，用于找最近活跃会话
  isGroup: boolean      // 是否群聊，发通知时需要
  conversationId: string
  userId: string        // 私聊时的发送者 userId，用于主动发消息
}

/**
 * 将旧格式（纯字符串 sessionId）或新格式统一解析为 SessionEntry
 */
function parseSessionEntry(value: unknown, key: string): SessionEntry | null {
  if (typeof value === 'string') {
    // 兼容旧格式：value 是纯 sessionId 字符串
    const conversationId = key.split('|')[0] || ''
    return { sessionId: value, lastActiveAt: 0, isGroup: false, conversationId, userId: '' }
  }
  if (value && typeof value === 'object' && 'sessionId' in value) {
    const entry = value as SessionEntry
    // 兼容没有 userId 字段的旧新格式
    if (!entry.userId) entry.userId = ''
    return entry
  }
  return null
}

function loadSessionMap(): Map<string, SessionEntry> {
  if (!existsSync(SESSION_FILE)) {
    return new Map()
  }
  try {
    const content = readFileSync(SESSION_FILE, 'utf-8')
    const raw = JSON.parse(content) as Record<string, unknown>
    const entries = new Map<string, SessionEntry>()
    for (const [key, value] of Object.entries(raw)) {
      const entry = parseSessionEntry(value, key)
      if (entry) {
        entries.set(key, entry)
      }
    }
    log(`[session] Loaded ${entries.size} sessions from ${SESSION_FILE}`)
    return entries
  } catch (error) {
    log(`[session] Failed to load sessions: ${error}`)
    return new Map()
  }
}

function saveSessionMap(): void {
  try {
    if (!existsSync(SESSION_DIR)) {
      mkdirSync(SESSION_DIR, { recursive: true })
    }
    const entries = Object.fromEntries(sessionMap)
    writeFileSync(SESSION_FILE, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
    log(`[session] Saved ${sessionMap.size} sessions to ${SESSION_FILE}`)
  } catch (error) {
    log(`[session] Failed to save sessions: ${error}`)
  }
}

// 每个 conversationId + workDir 维护一个 Claude Code session_id，实现多轮对话
// 不同工作目录的 session 不会互相干扰
const sessionMap = loadSessionMap()

// 生成 session key（包含工作目录和角色，不同角色的 session 互不干扰）
function getSessionKey(conversationId: string, workDir: string, profile?: string): string {
  return profile ? `${conversationId}|${workDir}|${profile}` : `${conversationId}|${workDir}`
}

/**
 * 找当前 workDir 下最近活跃的会话，用于连接成功后发上线通知
 */
function findLastActiveSession(workDir: string): SessionEntry | null {
  let latestEntry: SessionEntry | null = null
  for (const [key, entry] of sessionMap) {
    if (!key.endsWith(`|${workDir}`)) continue
    if (!latestEntry || entry.lastActiveAt > latestEntry.lastActiveAt) {
      latestEntry = entry
    }
  }
  return latestEntry
}

interface ClaudeResponse {
  type: string
  subtype: string
  is_error: boolean
  result: string
  session_id: string
  duration_ms: number
  stop_reason: string
}
/**
 * 调用 claude -p CLI 处理消息
 * 如果有已存在的 session_id，则用 --resume 继续会话
 * 新建 session 时，通过 --append-system-prompt 传入角色信息
 */
async function callClaude(
  message: string,
  conversationId: string,
  workDir: string,
  isGroup: boolean = false,
  userId: string = '',
  profile?: string,
  systemPrompt?: string
): Promise<string> {
  const sessionKey = getSessionKey(conversationId, workDir, profile)
  const existingEntry = sessionMap.get(sessionKey)
  const existingSessionId = existingEntry?.sessionId

  const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions']
  // 新建 session 时传入角色信息；resume 时 Claude 已有上下文，不需要重复传
  if (!existingSessionId && systemPrompt) {
    args.push('--append-system-prompt', systemPrompt)
  }
  if (existingSessionId) {
    args.push('--resume', existingSessionId)
  }

  if (existingSessionId) {
    log(`[claude] Resuming session: claude ${args.join(' ')}, cwd=${workDir}`)
  } else {
    // 新建 session，打印完整命令（含 --append-system-prompt 内容，方便确认角色是否生效）
    const fullCommand = `claude ${args.join(' ')}`
    log(`[claude] New session: ${fullCommand}, cwd=${workDir}`)
  }

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      env: { ...process.env },
      shell: process.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    // 将消息写入 stdin
    child.stdin.write(message)
    child.stdin.end()

    child.on('close', (code: number | null) => {
      log(`[claude] Process exited with code ${code}`)
      if (stdout) {
        log(`[claude] stdout (first 500 chars): ${stdout.substring(0, 500)}`)
      }
      if (stderr) {
        log(`[claude] stderr (full): ${stderr}`)
      }

      if (code !== 0) {
        log(`[claude] Non-zero exit code detected, classifying error...`)

        // 错误分类 1：session 无效，自动降级为新建会话
        const isSessionInvalid =
          stderr.includes('No conversation found') ||
          stderr.includes('session ID') ||
          stderr.includes('Invalid session') ||
          stderr.includes('Session not found') ||
          stderr.includes('--resume')
        if (isSessionInvalid) {
          log(`[claude] [ERROR_TYPE: SESSION_INVALID] Session ${existingSessionId} is invalid, clearing and retrying without resume`)
          sessionMap.delete(sessionKey)
          saveSessionMap()
          callClaude(message, conversationId, workDir, isGroup, userId).then(resolve).catch(reject)
          return
        }

        // 错误分类 2：权限错误
        const isPermissionError =
          stderr.includes('Permission denied') ||
          stderr.includes('EACCES') ||
          stderr.includes('not permitted')
        if (isPermissionError) {
          log(`[claude] [ERROR_TYPE: PERMISSION_ERROR] Permission denied`)
          reject(new Error(`Claude CLI 权限错误: ${stderr}`))
          return
        }

        // 错误分类 3：命令不存在
        const isCommandNotFound =
          stderr.includes('command not found') ||
          stderr.includes('not recognized') ||
          stderr.includes('ENOENT')
        if (isCommandNotFound) {
          log(`[claude] [ERROR_TYPE: COMMAND_NOT_FOUND] Claude CLI not found`)
          reject(new Error(`Claude CLI 未找到，请确认已安装: ${stderr}`))
          return
        }

        // 错误分类 4：其他未知错误
        log(`[claude] [ERROR_TYPE: UNKNOWN] Unclassified error, exit code=${code}`)
        log(`[claude] stdout: ${stdout}`)
        reject(new Error(`claude exited with code ${code}. stderr: ${stderr || '(empty)'}, stdout: ${stdout.substring(0, 200) || '(empty)'}`))
        return
      }

      try {
        // claude -p --output-format json 可能输出多行，取最后一个 JSON
        const lines = stdout.trim().split('\n')
        const lastJsonLine = lines.filter(line => line.startsWith('{')).pop()
        if (!lastJsonLine) {
          // 如果没有 JSON 输出，直接返回原始文本
          resolve(stdout.trim())
          return
        }

        const response = JSON.parse(lastJsonLine) as ClaudeResponse
        log(`[claude] Response: session_id=${response.session_id}, duration=${response.duration_ms}ms, stop_reason=${response.stop_reason}`)

        // 保存 session_id 用于后续多轮对话，并持久化到文件
        if (response.session_id) {
          sessionMap.set(sessionKey, {
            sessionId: response.session_id,
            lastActiveAt: Date.now(),
            isGroup,
            conversationId,
            userId,
          })
          saveSessionMap()
          log(`[claude] Saved session_id=${response.session_id} for sessionKey=${sessionKey}`)
        }

        if (response.is_error) {
          reject(new Error(`Claude error: ${response.result}`))
          return
        }

        resolve(response.result || stdout.trim())
      } catch (parseError) {
        log(`[claude] Failed to parse JSON, returning raw output: ${parseError}`)
        resolve(stdout.trim())
      }
    })

    child.on('error', (error: Error) => {
      log(`[claude] Spawn error: ${error.message}`)
      reject(error)
    })
  })
}

// ========== 启动函数 ==========
export async function startBot(options: StartBotOptions): Promise<void> {
  const config: DingTalkChannelConfig = {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    robotCode: process.env.DINGTALK_ROBOT_CODE || options.clientId,
    corpId: process.env.DINGTALK_CORP_ID || '',
    agentId: process.env.DINGTALK_AGENT_ID || '',
    dmPolicy: (process.env.DINGTALK_DM_POLICY as 'open' | 'pairing' | 'allowlist') || 'open',
    groupPolicy: (process.env.DINGTALK_GROUP_POLICY as 'open' | 'allowlist' | 'disabled') || 'open',
    allowFrom: process.env.DINGTALK_ALLOW_FROM?.split(',').filter(Boolean) || [],
    messageType: (process.env.DINGTALK_MESSAGE_TYPE as 'markdown' | 'card') || 'markdown',
    cardTemplateId: process.env.DINGTALK_CARD_TEMPLATE_ID || '',
    cardTemplateKey: process.env.DINGTALK_CARD_TEMPLATE_KEY || 'content',
  }

  const dingtalkClient = new DingTalkClient(config)

  dingtalkClient.onMessage(async (callback: DingTalkInboundCallback) => {
    const messageText = callback.text?.content?.trim() || callback.content || ''
    const isGroup = callback.conversationType === '2'
    const chatId = callback.conversationId

    log(`[onMessage] From ${callback.senderId}, chatId=${chatId}, isGroup=${isGroup}, text="${messageText}"`)

    if (!messageText) {
      log('[onMessage] Empty message, ignoring')
      return
    }

    // ========== 内置指令处理 ==========
    const command = messageText.toLowerCase()
    if (command === '新会话' || command === '清空记忆' || command === '/new' || command === '/reset') {
      const sessionKey = getSessionKey(chatId, options.workDir, options.profile)
      const hadSession = sessionMap.has(sessionKey)
      if (hadSession) {
        sessionMap.delete(sessionKey)
        saveSessionMap()
        log(`[command] Cleared session for sessionKey=${sessionKey}`)
      }
      const replyContent = hadSession
        ? '🔄 已清空当前会话记忆，下次发消息将开启全新对话。'
        : '💡 当前没有活跃的会话记忆，发消息即可开始新对话。'
      if (callback.sessionWebhook) {
        await fetch(callback.sessionWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: replyContent } }),
        })
      }
      return
    }

    if (command === '/help' || command === '帮助') {
      const helpText = [
        '🤖 **ClaudeTalk 指令帮助**',
        '',
        '- **新会话** 或 **/new** — 清空当前会话记忆，开启全新对话',
        '- **清空记忆** 或 **/reset** — 同上',
        '- **帮助** 或 **/help** — 显示本帮助信息',
        '',
        '发送其他任意消息将由 Claude Code 处理。',
      ].join('\n')
      if (callback.sessionWebhook) {
        await fetch(callback.sessionWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'markdown', markdown: { title: '帮助', text: helpText } }),
        })
      }
      return
    }

    try {
      // 立即回复"收到"，让用户知道消息已被接收，避免等待焦虑
      if (callback.sessionWebhook) {
        await fetch(callback.sessionWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: '👍 收到，正在处理...' } }),
        }).catch((error) => log(`[reply] Failed to send ack: ${error}`))
      }

      // 调用 Claude Code CLI 处理消息，传入工作目录和会话类型
      // 使用 senderStaffId 作为私聊发消息的 userId（staffId 格式，非 senderId）
      const staffId = callback.senderStaffId || ''
      const replyText = await callClaude(messageText, chatId, options.workDir, isGroup, staffId, options.profile, options.systemPrompt)
      log(`[onMessage] Claude reply (first 200 chars): "${replyText.substring(0, 200)}"`)

      // 优先用 sessionWebhook 回复（最简单可靠）
      if (callback.sessionWebhook) {
        log(`[reply] Using sessionWebhook`)
        const resp = await fetch(callback.sessionWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { title: 'Claude Code', text: replyText },
          }),
        })
        const result = await resp.json()
        log(`[reply] sessionWebhook response: ${JSON.stringify(result)}`)
      } else {
        // 降级用 API 发送
        log(`[reply] Using API sendMessage`)
        await dingtalkClient.sendMessage(chatId, replyText, isGroup)
        log(`[reply] API sendMessage done`)
      }
    } catch (error) {
      log(`[ERROR] ${error}`)

      // 发送错误提示给用户
      if (callback.sessionWebhook) {
        await fetch(callback.sessionWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'text',
            text: { content: `处理消息时出错: ${error instanceof Error ? error.message : String(error)}` },
          }),
        }).catch(() => {})
      }
    }
  })

  log('=== DingTalk Bot (CLI Mode) Starting ===')
  log(`Config: clientId=${config.clientId.substring(0, 8)}...`)
  log(`WorkDir: ${options.workDir}`)
  log(`Sessions: ${SESSION_FILE} (${sessionMap.size} loaded)`)

  await dingtalkClient.start()
  log('=== DingTalk Bot Running ===')

  // 连接成功后，找当前 workDir 最近活跃的会话，发送上线通知
  const lastActiveSession = findLastActiveSession(options.workDir)
  if (lastActiveSession) {
    const notifyText = [
      '✅ **ClaudeTalk 已上线**',
      '',
      `📁 工作目录: \`${options.workDir}\``,
    ].join('\n')

    if (!lastActiveSession.isGroup && lastActiveSession.userId) {
      // 仅对私聊发上线通知，使用 staffId 和纯文本格式
      const notifyPlainText = `✅ ClaudeTalk 已上线\n📁 工作目录: ${options.workDir}`
      log(`[notify] Sending online notification to staffId=${lastActiveSession.userId}`)
      dingtalkClient.sendPrivateMessage(lastActiveSession.userId, notifyPlainText, 'sampleText')
        .then((result) => log(`[notify] Online notification sent, response: ${JSON.stringify(result)}`))
        .catch((error: Error) => log(`[notify] Failed to send online notification: ${error.message}`))
    } else {
      log('[notify] No private session found, skipping online notification')
    }
  } else {
    log('[notify] No previous session found, skipping online notification')
  }
}
