/**
 * Claude Code DingTalk Bot - 独立运行模式
 * 收到钉钉消息后，通过 claude -p CLI 调用 Claude Code 处理，并将回复发回钉钉
 * 支持多轮会话：每个 conversationId 维护独立的 session_id
 */

import { spawn } from 'child_process'
import { appendFileSync } from 'fs'
import { DingTalkClient } from './dingtalk.js'
import type { DingTalkChannelConfig, DingTalkInboundCallback } from './types.js'

export interface StartBotOptions {
  clientId: string
  clientSecret: string
  workDir: string
}

// ========== 日志 ==========
const LOG_FILE = '/tmp/dingtalk_debug.log'
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.error(line)
  appendFileSync(LOG_FILE, line + '\n')
}

// ========== 会话管理 ==========
// 每个 conversationId 维护一个 Claude Code session_id，实现多轮对话
const sessionMap = new Map<string, string>()

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
 */
async function callClaude(message: string, conversationId: string, workDir: string): Promise<string> {
  const existingSessionId = sessionMap.get(conversationId)

  const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions']
  if (existingSessionId) {
    args.push('--resume', existingSessionId)
  }

  log(`[claude] Calling claude CLI with args: ${args.join(' ')}, sessionId=${existingSessionId || 'new'}, cwd=${workDir}`)

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      env: { ...process.env },
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
      if (stderr) {
        log(`[claude] stderr: ${stderr.substring(0, 500)}`)
      }

      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`))
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

        // 保存 session_id 用于后续多轮对话
        if (response.session_id) {
          sessionMap.set(conversationId, response.session_id)
          log(`[claude] Saved session_id=${response.session_id} for conversationId=${conversationId}`)
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

    try {
      // 调用 Claude Code CLI 处理消息，传入工作目录
      const replyText = await callClaude(messageText, chatId, options.workDir)
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

  await dingtalkClient.start()
  log('=== DingTalk Bot Running ===')
}
