/**
 * Claude CLI 调用层 + Session 管理
 * 各 Channel（钉钉、飞书）共享此模块，各自独立处理消息后调用 callClaude
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ChannelType, ClaudeTalkConfig } from '../types.js'
import { createLogger, log } from './logger.js'
import { resolveConfigPath } from './global-config.js'

// Re-export for index.ts compatibility
export { createLogger, log } from './logger.js'

// ========== Session 持久化 ==========
// session 文件存放在工作目录下的 .claudetalk-sessions.json
// 注意：SESSION_FILE 在模块加载时还不知道 workDir，所以用函数动态获取路径

function getSessionFile(workDir: string): string {
  return join(workDir, '.claudetalk-sessions.json')
}

export interface SessionEntry {
  sessionId: string
  lastActiveAt: number
  isGroup: boolean
  conversationId: string
  userId: string
  channel: ChannelType
  needsCompact?: boolean
  /** 创建该 session 时的 systemPrompt hash；resume 时不匹配则清除重建 */
  systemPromptHash?: string
}

function parseSessionEntry(value: unknown): SessionEntry | null {
  if (value && typeof value === 'object' && 'sessionId' in value) {
    // 旧版本带 subagentEnabled 字段；保留检测以触发一次性迁移（清除老 session）
    const legacy = (value as Record<string, unknown>).subagentEnabled !== undefined
    const entry = value as SessionEntry & { subagentEnabled?: unknown }
    if (!entry.userId) entry.userId = ''
    if (!entry.channel) entry.channel = 'dingtalk'
    // 标记：legacy 字段保留在原对象上，caller 可探测；存盘时由调用方决定要不要剥
    if (legacy) {
      ;(entry as { _legacySubagentSession?: boolean })._legacySubagentSession = true
    }
    delete entry.subagentEnabled
    return entry
  }
  return null
}

function loadSessionMap(workDir: string): Map<string, SessionEntry> {
  const sessionFile = getSessionFile(workDir)
  if (!existsSync(sessionFile)) {
    return new Map()
  }
  try {
    const content = readFileSync(sessionFile, 'utf-8')
    const raw = JSON.parse(content) as Record<string, unknown>
    const entries = new Map<string, SessionEntry>()
    for (const [key, value] of Object.entries(raw)) {
      const entry = parseSessionEntry(value)
      if (entry) {
        entries.set(key, entry)
      }
    }
    return entries
  } catch (error) {
    log(`[session] Failed to load sessions: ${error}`)
    return new Map()
  }
}

function saveSessionMap(workDir: string, sessionMap: Map<string, SessionEntry>): void {
  const sessionFile = getSessionFile(workDir)
  try {
    // 剥掉内部追踪字段（如 _legacySubagentSession）和遗留字段（如 subagentEnabled）
    // 只持久化 SessionEntry 显式定义的字段
    const entries: Record<string, SessionEntry> = {}
    for (const [key, entry] of sessionMap) {
      const clean: SessionEntry = {
        sessionId: entry.sessionId,
        lastActiveAt: entry.lastActiveAt,
        isGroup: entry.isGroup,
        conversationId: entry.conversationId,
        userId: entry.userId,
        channel: entry.channel,
      }
      if (entry.needsCompact !== undefined) clean.needsCompact = entry.needsCompact
      if (entry.systemPromptHash !== undefined) clean.systemPromptHash = entry.systemPromptHash
      entries[key] = clean
    }
    writeFileSync(sessionFile, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
  } catch (error) {
    log(`[session] Failed to save sessions: ${error}`)
  }
}

// 按 workDir 缓存 session map，避免每次都读文件
const sessionMapCache = new Map<string, Map<string, SessionEntry>>()

function getSessionMap(workDir: string): Map<string, SessionEntry> {
  if (!sessionMapCache.has(workDir)) {
    sessionMapCache.set(workDir, loadSessionMap(workDir))
  }
  return sessionMapCache.get(workDir)!
}

/**
 * 生成 session key
 * 格式：conversationId\x00workDir\x00profile\x00channel
 * 使用 \x00（NUL 字符）作为分隔符，避免路径或 ID 中含有 | 导致解析错误
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
  return parts.join('\x00')
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
  const sessionMap = getSessionMap(workDir)
  const sessionKey = getSessionKey(conversationId, workDir, profile, channel)
  const hadSession = sessionMap.has(sessionKey)
  if (hadSession) {
    sessionMap.delete(sessionKey)
    saveSessionMap(workDir, sessionMap)
  }
  return hadSession
}

/**
 * 找当前 workDir、channel、profile 下最近活跃的私聊会话，用于发上线通知
 * @param workDir - 工作目录
 * @param channel - 消息通道类型，避免跨 channel 通知
 * @param profile - profile 名称，避免同一 channel 下不同飞书应用（AppId 不同）互相通知
 */
export function findLastActivePrivateSession(
  workDir: string,
  channel: ChannelType,
  profile?: string
): SessionEntry | null {
  const sessionMap = getSessionMap(workDir)
  let latestEntry: SessionEntry | null = null
  for (const [key, entry] of sessionMap) {
    const parts = key.split('\x00')
    if (parts[1] !== workDir) continue
    if (entry.isGroup) continue
    if (entry.channel !== channel) continue
    // 过滤 profile：同一 channel 下不同飞书应用的 open_id 不能互用
    if (profile && parts[2] !== profile) continue
    if (!latestEntry || entry.lastActiveAt > latestEntry.lastActiveAt) {
      latestEntry = entry
    }
  }
  return latestEntry
}

// ========== 配置加载 ==========

// 与 cli.ts 的 LINE_SEPARATOR 对齐：systemPrompt 在 setup 时把 \n 替换成 U+2028 存盘，
// 加载时统一在 loadConfig 还原，避免下游（--append-system-prompt / 模板）拿到塌缩成一行的 prompt
const LINE_SEPARATOR = ' '
function restoreLineBreaks(text: string): string {
  return text.replace(new RegExp(LINE_SEPARATOR, 'g'), '\n')
}

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
    const merged: ClaudeTalkConfig = {
      ...raw,
      ...profileOverride,
      profiles: undefined,
    }
    if (typeof merged.systemPrompt === 'string') {
      merged.systemPrompt = restoreLineBreaks(merged.systemPrompt)
    }
    return merged
  } catch {
    return null
  }
}

export function loadConfig(workDir: string, profile?: string): ClaudeTalkConfig | null {
  const resolved = resolveConfigPath(workDir)
  if (!resolved) return null
  return loadConfigFromFile(resolved.path, profile)
}

// SubAgent 调度模式已废弃。
// 现在 Claude Code 主循环本身就是角色：systemPrompt 通过 --append-system-prompt 注入。
// 旧的 buildAgentJson / parseAgentMdFile 已删除。

/** 哈希 systemPrompt，用于 session 漂移检测；改用简单的 djb2，避免引入 crypto 依赖 */
function hashSystemPrompt(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0  // hash * 33 + c
  }
  return (hash >>> 0).toString(16)
}

// ========== 引擎配置 ==========

interface EngineConfig {
  command: string
  skipPermissionsFlag: string[]
}

function getEngineConfig(engine?: string): EngineConfig {
  if (engine === 'qodercli') {
    return { command: 'qodercli', skipPermissionsFlag: ['--yolo'] }
  }
  return { command: 'claude', skipPermissionsFlag: ['--dangerously-skip-permissions'] }
}

// ========== Claude CLI 调用 ==========

interface ClaudeUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface ClaudeModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
}

interface ClaudeResponse {
  type: string
  subtype: string
  is_error: boolean
  result: string
  session_id: string
  duration_ms: number
  stop_reason: string
  usage?: ClaudeUsage
  // 实际 token 消耗在 modelUsage 中，按模型名称索引
  modelUsage?: Record<string, ClaudeModelUsage>
}

export interface CallClaudeOptions {
  message: string
  conversationId: string
  workDir: string
  isGroup?: boolean
  userId?: string
  profile?: string
  channel?: ChannelType
  /** 执行引擎：claude（默认）或 qodercli */
  engine?: string
  /** 加工后的消息（由 Channel 处理后生成），有值时替换原始 message 发送给 Claude */
  processedMessage?: string
}

const MAX_SESSION_RETRY_COUNT = 2

// 这一轮调用让模型实际消化的 token 总量阈值（input + cache_creation + cache_read）。
// 超过即认为 session 已显著增长，异步触发 /compact 压缩历史。
//
// 注：旧实现只看 usage.input_tokens，但 Claude Code 中 usage.input_tokens 仅统计"非缓存"
// 的新增 input；长跑 agent 几乎所有上下文都走 cache_read，input_tokens 永远是个位数 ——
// 导致 200K 阈值永远不达标、压缩从未触发，session 滚到 1M+ 才被模型 400 拒绝。
// 改成按"这一轮模型实际处理的 token 总量"判断，阈值上调到 1M（模型 200K 窗口的 5 倍），
// 兼顾"真的该压缩了"与"不要每次都压缩"。
const AUTO_COMPACT_TOKEN_THRESHOLD = 1_000_000

// 按 sessionKey 存储正在进行的压缩 Promise，用于防止并发操作同一 session
const compactingPromises = new Map<string, Promise<void>>()

// 按 sessionKey 串行化同一会话的入站消息，避免两条消息同时 spawn `claude --resume`
// 导致 session 历史互相覆盖。仅外层调用 (retryCount === 0) 入队；内部 retry 复用同一槽位。
const inFlightBySession = new Map<string, Promise<string>>()

/**
 * 对指定 session 执行 /compact 压缩
 * 压缩完成后更新 sessionMap 中的 session_id（Claude CLI 压缩后会返回新的 session_id）
 */
async function compactSession(
  sessionKey: string,
  sessionId: string,
  workDir: string,
  profile: string | undefined,
  baseArgs: string[],
  engineConfig: EngineConfig
): Promise<void> {
  const logger = createLogger(profile)
  logger(`[compact] Starting auto compact for session: ${sessionId}`)

  return new Promise<void>((resolve) => {
    // 复用相同的 args（含 --resume），发送 /compact 命令
    const compactArgs = [...baseArgs]
    const child = spawn(engineConfig.command, compactArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      env: { ...process.env },
      shell: process.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    child.stdin.write('/compact')
    child.stdin.end()

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        logger(`[compact] Compact failed with code ${code}, stderr: ${stderr}`)
        resolve()
        return
      }

      try {
        const lines = stdout.trim().split('\n')
        const lastJsonLine = lines.filter(line => line.startsWith('{')).pop()
        if (lastJsonLine) {
          const response = JSON.parse(lastJsonLine) as ClaudeResponse
          if (response.session_id) {
            // 更新 sessionMap 中的 session_id
            const sessionMap = getSessionMap(workDir)
            const existingEntry = sessionMap.get(sessionKey)
            if (existingEntry) {
              existingEntry.sessionId = response.session_id
              existingEntry.needsCompact = false
              saveSessionMap(workDir, sessionMap)
              logger(`[compact] Compact done, resume session_id: ${response.session_id}`)
            }
          }
        }
      } catch (parseError) {
        logger(`[compact] Failed to parse compact response: ${parseError}`)
      }

      resolve()
    })

    child.on('error', (error: Error) => {
      logger(`[compact] Spawn error: ${error.message}`)
      resolve()
    })
  })
}

/**
 * 调用 claude -p CLI 处理消息，支持多轮会话
 *
 * 新建 session 策略：
 * - 有 profile 且配了 systemPrompt → 通过 --append-system-prompt 注入角色，主循环本身就是该角色
 * - 配了 model → 通过 --model 注入到主循环
 * - resume session 时若 systemPrompt 已变更（hash 不一致）或检测到旧版 subagent session 残留，自动清除重建
 */
export async function callClaude(options: CallClaudeOptions): Promise<string> {
  // 串行化同一 session 的入站消息，避免并发 spawn `claude --resume` 互相覆盖历史
  const channel = options.channel ?? 'dingtalk'
  const sessionKey = getSessionKey(options.conversationId, options.workDir, options.profile, channel)
  const previous = inFlightBySession.get(sessionKey)
  const work = (async () => {
    if (previous) {
      try { await previous } catch { /* 上一条的错误不影响当前 */ }
    }
    return callClaudeImpl(options, 0)
  })()
  inFlightBySession.set(sessionKey, work)
  work.finally(() => {
    if (inFlightBySession.get(sessionKey) === work) {
      inFlightBySession.delete(sessionKey)
    }
  }).catch(() => { /* 防止 .finally 链产生 unhandled rejection */ })
  return work
}

async function callClaudeImpl(options: CallClaudeOptions, retryCount: number): Promise<string> {
  const {
    message,
    conversationId,
    workDir,
    isGroup = false,
    userId = '',
    profile,
    channel = 'dingtalk',
    engine,
    processedMessage,
  } = options

  const logger = createLogger(profile)
  const engineConfig = getEngineConfig(engine)
  const sessionMap = getSessionMap(workDir)
  const sessionKey = getSessionKey(conversationId, workDir, profile, channel)

  // 如果当前 session 正在压缩，等待压缩完成后再处理新消息
  const pendingCompact = compactingPromises.get(sessionKey)
  if (pendingCompact) {
    logger(`[claude] Waiting for ongoing compact to finish before processing new message`)
    await pendingCompact
  }

  const existingEntry = sessionMap.get(sessionKey)
  const existingSessionId = existingEntry?.sessionId

  const currentConfig = loadConfig(workDir, profile)
  const currentSystemPrompt = currentConfig?.systemPrompt
  const currentSystemPromptHash = currentSystemPrompt ? hashSystemPrompt(currentSystemPrompt) : undefined
  const currentModel = currentConfig?.model

  const args = ['-p', '--output-format', 'json', ...engineConfig.skipPermissionsFlag]

  // resume 前的两道清除：(1) 旧版本 subagent 模式留下的 session、(2) systemPrompt 已变更的 session
  // 命中任一则清除 + 重建（递归调用，最多 MAX_SESSION_RETRY_COUNT 次）
  if (existingSessionId && existingEntry) {
    const isLegacySubagent = (existingEntry as { _legacySubagentSession?: boolean })._legacySubagentSession === true
    const promptDrifted =
      existingEntry.systemPromptHash !== undefined &&
      currentSystemPromptHash !== undefined &&
      existingEntry.systemPromptHash !== currentSystemPromptHash
    if (isLegacySubagent || promptDrifted) {
      if (retryCount >= MAX_SESSION_RETRY_COUNT) {
        throw new Error(`[session] 升级/配置变更后重建 session 失败，已超过最大重试 (${MAX_SESSION_RETRY_COUNT})`)
      }
      const reason = isLegacySubagent ? '旧 subagent 模式残留 session' : 'systemPrompt 已变更'
      logger(`[session] 清除并重建: ${reason} (conversationId=${conversationId})`)
      sessionMap.delete(sessionKey)
      saveSessionMap(workDir, sessionMap)
      return callClaudeImpl(options, retryCount + 1)
    }
    args.push('--resume', existingSessionId)
  } else if (profile && currentSystemPrompt) {
    // 新 session：把角色 systemPrompt 注入主循环
    args.push('--append-system-prompt', currentSystemPrompt)
  }

  // model 注入仅对新 session 有意义（resume 不能改模型），但加在 resume 上 claude CLI 也会忽略
  if (currentModel) {
    args.push('--model', currentModel)
  }

  if (existingSessionId) {
    logger(`[claude] Resuming session: conversationId=${conversationId}`)
  } else {
    logger(`[claude] New session: conversationId=${conversationId}, profile=${profile ?? '(none)'}, model=${currentModel ?? '(default)'}`)
  }

  return new Promise((resolve, reject) => {
    const child = spawn(engineConfig.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      env: { ...process.env },
      shell: process.platform === 'win32',
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    // 优先使用加工后的消息（包含历史消息和角色信息），否则使用原始消息。
    // 角色身份通过 --append-system-prompt 注入，主循环本身就是该角色，无需再包装 "Use the X agent..."
    const actualMessage = processedMessage ?? message

    // 打印完整 prompt，便于调试
    logger(`[claude] ===== Full Prompt =====`)
    logger(`[claude] engine: ${engineConfig.command}, args: ${JSON.stringify(args)}`)
    logger(`[claude] prompt (${actualMessage.length} chars):\n${actualMessage}`)
    logger(`[claude] ========================`)

    child.stdin.write(actualMessage)
    child.stdin.end()

    child.on('close', (code: number | null) => {

      if (code !== 0) {
        const isSessionInvalid =
          stderr.includes('No conversation found') ||
          stderr.includes('session ID') ||
          stderr.includes('Invalid session') ||
          stderr.includes('Session not found') ||
          stderr.includes('--resume')
        if (isSessionInvalid) {
          if (retryCount >= MAX_SESSION_RETRY_COUNT) {
            reject(new Error(`[session] Session 无效且重试次数已达上限 (${MAX_SESSION_RETRY_COUNT})，请发送"新会话"重置后重试`))
            return
          }
          logger(`[claude] Session invalid, clearing and retrying (attempt ${retryCount + 1}/${MAX_SESSION_RETRY_COUNT})`)
          sessionMap.delete(sessionKey)
          saveSessionMap(workDir, sessionMap)
          callClaudeImpl({ ...options, channel }, retryCount + 1).then(resolve).catch(reject)
          return
        }

        if (stderr.includes('Permission denied') || stderr.includes('EACCES')) {
          reject(new Error(`${engineConfig.command} CLI 权限错误: ${stderr}`))
          return
        }

        if (stderr.includes('command not found') || stderr.includes('ENOENT')) {
          reject(new Error(`${engineConfig.command} CLI 未找到，请确认已安装: ${stderr}`))
          return
        }

        reject(new Error(`${engineConfig.command} exited with code ${code}. stderr: ${stderr || '(empty)'}, stdout: ${stdout || '(empty)'}`))
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

        // 真实 token 消耗在 modelUsage 中（usage.input_tokens 通常为 0）
        const modelUsageValues = response.modelUsage ? Object.values(response.modelUsage) : []
        const inputTokens = modelUsageValues.reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0)
        const cacheReadTokens = modelUsageValues.reduce((sum, usage) => sum + (usage.cacheReadInputTokens ?? 0), 0)
        const cacheCreationTokens = modelUsageValues.reduce((sum, usage) => sum + (usage.cacheCreationInputTokens ?? 0), 0)
        const effectiveContextTokens = inputTokens + cacheReadTokens + cacheCreationTokens
        logger(`[claude] Done: duration=${response.duration_ms}ms, session_id=${response.session_id}, input_tokens=${inputTokens}, cache_read_tokens=${cacheReadTokens}, cache_creation_tokens=${cacheCreationTokens}, effective_total=${effectiveContextTokens}`)

        if (response.session_id) {
          sessionMap.set(sessionKey, {
            sessionId: response.session_id,
            lastActiveAt: Date.now(),
            isGroup,
            conversationId,
            userId,
            channel,
            systemPromptHash: currentSystemPromptHash,
          })
          saveSessionMap(workDir, sessionMap)
        }

        if (response.is_error) {
          reject(new Error(`Claude error: ${response.result}`))
          return
        }

        // 先返回结果给用户，再异步触发压缩（用户无感知）
        // 注意：response.result 可能是空字符串（agent 只做了工具调用没有文字回复）
        // 不能 fallback 到 stdout.trim()，否则会把整个原始 JSON 返回给 IM
        resolve(response.result || '任务执行完成，无需特殊提醒')

        // 响应后检查"这一轮实际处理的总 token"，超过阈值则异步触发压缩
        if (response.session_id && effectiveContextTokens > AUTO_COMPACT_TOKEN_THRESHOLD) {
          logger(`[compact] effective_total (${effectiveContextTokens}) exceeded threshold (${AUTO_COMPACT_TOKEN_THRESHOLD}), triggering async compact`)
          // 构建压缩用的 args（复用当前 args，但确保含 --resume）
          const compactArgs = ['-p', '--output-format', 'json', ...engineConfig.skipPermissionsFlag, '--resume', response.session_id]
          const compactPromise = compactSession(sessionKey, response.session_id, workDir, profile, compactArgs, engineConfig)
            .finally(() => {
              compactingPromises.delete(sessionKey)
            })
          compactingPromises.set(sessionKey, compactPromise)
        }
      } catch (parseError) {
        logger(`[claude] Failed to parse JSON, returning raw output: ${parseError}`)
        resolve(stdout.trim())
      }
    })

    child.on('error', (error: Error) => {
      logger(`[claude] Spawn error: ${error.message}`)
      reject(error)
    })
  })
}
