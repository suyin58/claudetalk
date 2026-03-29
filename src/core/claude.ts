/**
 * Claude CLI 调用层 + Session 管理
 * 两个 Channel（钉钉、Discord）共享此模块，各自独立处理消息后调用 callClaude
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ChannelType, ClaudeTalkConfig } from '../types.js'

// ========== 日志 ==========

export function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] ${msg}`)
}

// ========== Session 持久化 ==========

const SESSION_DIR = join(homedir(), '.claudetalk')
const SESSION_FILE = join(SESSION_DIR, 'sessions.json')

export interface SessionEntry {
  sessionId: string
  lastActiveAt: number
  isGroup: boolean
  conversationId: string
  userId: string
  subagentEnabled: boolean
  channel: ChannelType
}

function parseSessionEntry(value: unknown, key: string): SessionEntry | null {
  if (value && typeof value === 'object' && 'sessionId' in value) {
    const entry = value as SessionEntry
    if (!entry.userId) entry.userId = ''
    if (entry.subagentEnabled === undefined) entry.subagentEnabled = false
    if (!entry.channel) entry.channel = 'dingtalk'
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

const sessionMap = loadSessionMap()

/**
 * 生成 session key
 * 格式：conversationId|workDir|profile|channel
 * 不同 profile、不同 channel 的 session 完全隔离
 */
export function getSessionKey(
  conversationId: string,
  workDir: string,
  profile?: string,
  channel?: ChannelType
): string {
  const parts = [conversationId, workDir]
  if (profile) parts.push(profile)
  if (channel) parts.push(channel)
  return parts.join('|')
}

/**
 * 清除指定会话的 session
 */
export function clearSession(
  conversationId: string,
  workDir: string,
  profile?: string,
  channel?: ChannelType
): boolean {
  const sessionKey = getSessionKey(conversationId, workDir, profile, channel)
  const hadSession = sessionMap.has(sessionKey)
  if (hadSession) {
    sessionMap.delete(sessionKey)
    saveSessionMap()
  }
  return hadSession
}

/**
 * 找当前 workDir 下最近活跃的私聊会话，用于发上线通知
 */
export function findLastActivePrivateSession(workDir: string): SessionEntry | null {
  let latestEntry: SessionEntry | null = null
  for (const [key, entry] of sessionMap) {
    const parts = key.split('|')
    if (parts[1] !== workDir) continue
    if (entry.isGroup) continue
    if (!latestEntry || entry.lastActiveAt > latestEntry.lastActiveAt) {
      latestEntry = entry
    }
  }
  return latestEntry
}

// ========== 配置加载 ==========

function loadConfigFromFile(filePath: string, profile?: string): ClaudeTalkConfig | null {
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const content = readFileSync(filePath, 'utf-8')
    const raw = JSON.parse(content)

    if (profile && !raw.profiles?.[profile]) {
      return null
    }

    const profileOverride = profile ? (raw.profiles?.[profile] ?? {}) : {}
    return {
      ...raw,
      ...profileOverride,
      profiles: undefined,
    }
  } catch {
    return null
  }
}

export function loadConfig(workDir: string, profile?: string): ClaudeTalkConfig | null {
  const GLOBAL_CONFIG_FILE = join(homedir(), '.claudetalk', 'claudetalk.json')
  const localConfigFile = join(workDir, '.claudetalk.json')

  return (
    loadConfigFromFile(localConfigFile, profile) ??
    loadConfigFromFile(GLOBAL_CONFIG_FILE, profile)
  )
}

// ========== SubAgent 构建 ==========

function buildAgentJson(profileName: string, config: ClaudeTalkConfig): string | null {
  const agentDef: Record<string, unknown> = {
    description: config.systemPrompt
      ? `${profileName} 角色助手。${config.systemPrompt}`
      : `${profileName} 角色助手，负责相关工作。`,
    prompt: config.systemPrompt || `你是 ${profileName} 角色，负责相关工作。`,
  }

  if (config.subagentModel) {
    agentDef.model = config.subagentModel
  }

  if (config.subagentPermissions?.allow || config.subagentPermissions?.deny) {
    agentDef.tools = config.subagentPermissions.allow ?? []
    if (config.subagentPermissions.deny?.length) {
      agentDef.disallowedTools = config.subagentPermissions.deny
    }
  }

  try {
    return JSON.stringify({ [profileName]: agentDef })
  } catch {
    return null
  }
}

// ========== Claude CLI 调用 ==========

interface ClaudeResponse {
  type: string
  subtype: string
  is_error: boolean
  result: string
  session_id: string
  duration_ms: number
  stop_reason: string
}

export interface CallClaudeOptions {
  message: string
  conversationId: string
  workDir: string
  isGroup?: boolean
  userId?: string
  profile?: string
  channel?: ChannelType
}

/**
 * 调用 claude -p CLI 处理消息，支持多轮会话
 *
 * 新建 session 策略：
 * - 有 profile 且启用 SubAgent → 通过 --agents 传入 SubAgent 定义
 * - 有 profile 但未启用 SubAgent → 通过 --append-system-prompt 传入角色信息
 * - 无 profile → 不传额外参数，Claude 自动委托
 */
export async function callClaude(options: CallClaudeOptions): Promise<string> {
  const {
    message,
    conversationId,
    workDir,
    isGroup = false,
    userId = '',
    profile,
    channel = 'dingtalk',
  } = options

  const sessionKey = getSessionKey(conversationId, workDir, profile, channel)
  const existingEntry = sessionMap.get(sessionKey)
  const existingSessionId = existingEntry?.sessionId

  const currentConfig = loadConfig(workDir, profile)
  const currentSubagentEnabled = currentConfig?.subagentEnabled ?? false
  const currentSystemPrompt = currentConfig?.systemPrompt

  const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions']

  if (existingSessionId && existingEntry) {
    // 配置变化时清除旧 session，重建
    if (existingEntry.subagentEnabled !== currentSubagentEnabled) {
      log(`[session] Config changed for profile=${profile} (subagentEnabled: ${existingEntry.subagentEnabled} -> ${currentSubagentEnabled}), clearing old session`)
      sessionMap.delete(sessionKey)
      saveSessionMap()
      return callClaude(options)
    }

    // 恢复 session 时也需要传入 --agents，否则 Claude Code 找不到 SubAgent 定义
    if (profile && currentSubagentEnabled && currentConfig) {
      const agentJson = buildAgentJson(profile, currentConfig)
      if (agentJson) args.push('--agents', agentJson)
    }
    args.push('--resume', existingSessionId)
  } else {
    if (profile && currentSubagentEnabled && currentConfig) {
      const agentJson = buildAgentJson(profile, currentConfig)
      if (agentJson) args.push('--agents', agentJson)
    } else if (profile && !currentSubagentEnabled && currentSystemPrompt) {
      args.push('--append-system-prompt', currentSystemPrompt)
    }
  }

  if (existingSessionId) {
    log(`[claude] Resuming session: claude ${args.join(' ')}, cwd=${workDir}`)
  } else {
    log(`[claude] New session: claude ${args.join(' ')}, cwd=${workDir}`)
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

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    const actualMessage =
      profile && currentSubagentEnabled
        ? `Use the ${profile} agent to handle this: ${message}`
        : message
    child.stdin.write(actualMessage)
    child.stdin.end()

    child.on('close', (code: number | null) => {
      log(`[claude] Process exited with code ${code}`)
      if (stdout) log(`[claude] stdout (first 500 chars): ${stdout.substring(0, 500)}`)
      if (stderr) log(`[claude] stderr: ${stderr}`)

      if (code !== 0) {
        const isSessionInvalid =
          stderr.includes('No conversation found') ||
          stderr.includes('session ID') ||
          stderr.includes('Invalid session') ||
          stderr.includes('Session not found') ||
          stderr.includes('--resume')
        if (isSessionInvalid) {
          log(`[claude] Session invalid, clearing and retrying`)
          sessionMap.delete(sessionKey)
          saveSessionMap()
          callClaude({ ...options, channel }).then(resolve).catch(reject)
          return
        }

        if (stderr.includes('Permission denied') || stderr.includes('EACCES')) {
          reject(new Error(`Claude CLI 权限错误: ${stderr}`))
          return
        }

        if (stderr.includes('command not found') || stderr.includes('ENOENT')) {
          reject(new Error(`Claude CLI 未找到，请确认已安装: ${stderr}`))
          return
        }

        reject(new Error(`claude exited with code ${code}. stderr: ${stderr || '(empty)'}, stdout: ${stdout.substring(0, 200) || '(empty)'}`))
        return
      }

      try {
        const lines = stdout.trim().split('\n')
        const lastJsonLine = lines.filter(line => line.startsWith('{')).pop()
        if (!lastJsonLine) {
          resolve(stdout.trim())
          return
        }

        const response = JSON.parse(lastJsonLine) as ClaudeResponse
        log(`[claude] Response: session_id=${response.session_id}, duration=${response.duration_ms}ms`)

        if (response.session_id) {
          sessionMap.set(sessionKey, {
            sessionId: response.session_id,
            lastActiveAt: Date.now(),
            isGroup,
            conversationId,
            userId,
            subagentEnabled: currentSubagentEnabled,
            channel,
          })
          saveSessionMap()
          log(`[claude] Saved session for sessionKey=${sessionKey}`)
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
