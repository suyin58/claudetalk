/**
 * 项目经理监督循环 —— 检测群聊停滞并自动 @ 跟进
 *
 * 每 checkIntervalMs 跑一次：
 *   1. 遍历 chat-members.json 中所有已知群
 *   2. 取每个群最近 N 条消息，判断是否停滞（最后一条 ≥ staleThresholdMs 前，且不是自己发的）
 *   3. 处于冷却期内的群跳过
 *   4. 命中 → 调 callClaude（独立 supervision session）让 LLM 输出 {shouldFollowUp, mention, message}
 *   5. @ 校验失败重试一次再 drop；通过则 channel.sendMessage 发出
 *
 * 模块完全独立运行在项目经理这个 profile 的进程内，不影响其他 channel/agent。
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Channel, SupervisionConfig } from '../types.js'
import { createLogger } from './logger.js'
import { callClaude, clearSession } from './claude.js'
import { loadChatHistory } from '../channels/dingtalk/chat-history.js'

const DEFAULTS = {
  checkIntervalMs: 20 * 60 * 1000,  // 20 分钟轮询
  staleThresholdMs: 10 * 60 * 1000, // 10 分钟无消息算停滞
  cooldownMs: 20 * 60 * 1000,       // 介入后 20 分钟冷却
}

const RECENT_LIMIT = 10  // 给 LLM 的最近消息条数

interface RecentMessage {
  timestamp: number
  /** bot 发送时是 profileName；user 发送时是 null */
  senderProfile: string | null
  text: string
}

interface FollowUpDecision {
  shouldFollowUp: boolean
  mention?: string
  message?: string
  reason?: string
}

export interface SupervisionRuntime {
  stop(): void
}

export interface StartSupervisionParams {
  workDir: string
  profile: string
  channelType: string
  channel: Channel
  /** profile 配置中该 channel 的嵌套配置（飞书需要 appId/secret 拉历史） */
  channelConfig: Record<string, unknown>
  config: SupervisionConfig
}

export function startSupervision(params: StartSupervisionParams): SupervisionRuntime {
  const settings = {
    checkIntervalMs: params.config.checkIntervalMs ?? DEFAULTS.checkIntervalMs,
    staleThresholdMs: params.config.staleThresholdMs ?? DEFAULTS.staleThresholdMs,
    cooldownMs: params.config.cooldownMs ?? DEFAULTS.cooldownMs,
  }
  const logger = createLogger('supervisor', params.profile)
  const lastInterventionAt = new Map<string, number>()
  let stopped = false

  logger(
    `监督循环已启动 (检查间隔 ${settings.checkIntervalMs / 60000} 分钟, ` +
    `停滞阈值 ${settings.staleThresholdMs / 60000} 分钟, ` +
    `冷却 ${settings.cooldownMs / 60000} 分钟)`
  )

  const tick = async () => {
    if (stopped) return
    try {
      await runOneCheck(params, settings, lastInterventionAt, logger)
    } catch (error) {
      logger(`[ERROR] 监督检查失败: ${error}`)
    }
  }

  const handle = setInterval(() => { void tick() }, settings.checkIntervalMs)

  return {
    stop() {
      stopped = true
      clearInterval(handle)
      logger('监督循环已停止')
    }
  }
}

async function runOneCheck(
  params: StartSupervisionParams,
  settings: { checkIntervalMs: number; staleThresholdMs: number; cooldownMs: number },
  lastInterventionAt: Map<string, number>,
  logger: (msg: string) => void
): Promise<void> {
  const chatMembers = loadChatMembersConfig(params.workDir, params.channelType)
  const chatIds = Object.keys(chatMembers).filter(k => k !== '_bot_self')
  if (chatIds.length === 0) {
    logger('暂无已知群，跳过本轮')
    return
  }

  const botSelf = chatMembers['_bot_self'] || []
  const botProfiles = botSelf
    .map(b => (b as { profileName?: string }).profileName)
    .filter((p): p is string => !!p && p !== params.profile)

  if (botProfiles.length === 0) {
    logger('暂无其他 agent profile，跳过本轮')
    return
  }

  const now = Date.now()
  for (const chatId of chatIds) {
    await checkOneChat(chatId, params, settings, lastInterventionAt, botProfiles, now, logger)
  }
}

async function checkOneChat(
  chatId: string,
  params: StartSupervisionParams,
  settings: { staleThresholdMs: number; cooldownMs: number },
  lastInterventionAt: Map<string, number>,
  botProfiles: string[],
  now: number,
  logger: (msg: string) => void
): Promise<void> {
  try {
    // 冷却期检查先做（最便宜）
    const lastIntervention = lastInterventionAt.get(chatId) ?? 0
    if (now - lastIntervention < settings.cooldownMs) {
      logger(`[${chatId}] 在冷却期内，跳过`)
      return
    }

    const recent = await fetchRecentMessages(params, chatId, RECENT_LIMIT)
    if (recent.length === 0) {
      logger(`[${chatId}] 无历史消息，跳过`)
      return
    }
    const last = recent[recent.length - 1]
    if (last.senderProfile === params.profile) {
      logger(`[${chatId}] 最后一条是项目经理自己发的，跳过`)
      return
    }
    const idle = now - last.timestamp
    if (idle < settings.staleThresholdMs) {
      logger(`[${chatId}] 仅停滞 ${Math.round(idle / 60000)} 分钟，未达阈值，跳过`)
      return
    }

    logger(`[${chatId}] 停滞 ${Math.round(idle / 60000)} 分钟，调用 LLM 判断是否跟进...`)
    let decision = await askLLMForDecision(params, chatId, recent, botProfiles, idle)
    if (!validateDecision(decision, botProfiles)) {
      logger(`[${chatId}] LLM 输出校验失败 (${decision.reason ?? 'unknown'})，重试一次...`)
      decision = await askLLMForDecision(params, chatId, recent, botProfiles, idle)
      if (!validateDecision(decision, botProfiles)) {
        logger(`[${chatId}] LLM 输出校验仍失败 (${decision.reason ?? 'unknown'})，drop`)
        return
      }
    }

    if (!decision.shouldFollowUp) {
      logger(`[${chatId}] LLM 判定无需跟进: ${decision.reason ?? '(no reason)'}`)
      return
    }

    logger(`[${chatId}] 介入: @${decision.mention} -> ${decision.message!.substring(0, 80)}`)
    await params.channel.sendMessage(chatId, decision.message!, true)
    lastInterventionAt.set(chatId, now)
  } catch (error) {
    logger(`[${chatId}] 检查失败: ${error}`)
  }
}

function loadChatMembersConfig(workDir: string, channelType: string): Record<string, unknown[]> {
  const filePath = join(workDir, '.claudetalk', channelType, 'chat-members.json')
  if (!existsSync(filePath)) return {}
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown[]>
  } catch {
    return {}
  }
}

async function fetchRecentMessages(
  params: StartSupervisionParams,
  chatId: string,
  limit: number
): Promise<RecentMessage[]> {
  if (params.channelType === 'dingtalk') {
    const claudetalkDir = join(params.workDir, '.claudetalk')
    const entries = loadChatHistory(claudetalkDir, chatId)
    return entries.slice(-limit).map(e => ({
      timestamp: e.timestamp,
      senderProfile: e.role === 'bot' ? e.senderId : null,
      text: e.content,
    }))
  }
  if (params.channelType === 'feishu') {
    return fetchFeishuRecent(params, chatId, limit)
  }
  return []
}

async function fetchFeishuRecent(
  params: StartSupervisionParams,
  chatId: string,
  limit: number
): Promise<RecentMessage[]> {
  const appId = params.channelConfig['FEISHU_APP_ID'] as string | undefined
  const appSecret = params.channelConfig['FEISHU_APP_SECRET'] as string | undefined
  if (!appId || !appSecret) return []

  // 1. 拿 tenant access token（短期 ttl，每轮拉一次足够；监督频率 20 分钟，不缓存也 OK）
  const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const tokenData = await tokenResp.json() as { code: number; tenant_access_token?: string }
  if (tokenData.code !== 0 || !tokenData.tenant_access_token) return []
  const token = tokenData.tenant_access_token

  // 2. 拉历史（按创建时间倒序）
  const historyResp = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${limit}&sort_type=ByCreateTimeDesc`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const historyData = await historyResp.json() as {
    code: number
    data?: {
      items?: Array<{
        message_id: string
        create_time: string
        sender: { id: string; id_type: string; sender_type: string }
        body: { content: string }
        msg_type: string
      }>
    }
  }
  if (historyData.code !== 0) return []
  const items = historyData.data?.items || []

  // 3. 反查 bot profile：用 sender.id 比对 chat-members._bot_self
  const chatMembers = loadChatMembersConfig(params.workDir, 'feishu')
  const botSelf = (chatMembers['_bot_self'] || []) as Array<{
    profileName?: string
    openId?: string
    appId?: string
  }>

  // 飞书返回是 desc，反转成正序（最新在最后）
  return items.slice().reverse().map(item => {
    const senderId = item.sender.id
    const isBot = item.sender.sender_type === 'app' || item.sender.sender_type === 'bot'
    let senderProfile: string | null = null
    if (isBot) {
      const bot = botSelf.find(b => b.openId === senderId || b.appId === senderId)
      senderProfile = bot?.profileName ?? null
    }
    let text = ''
    if (item.msg_type === 'text') {
      try {
        const parsed = JSON.parse(item.body.content) as { text?: string }
        text = parsed.text ?? ''
      } catch {
        text = item.body.content
      }
    } else {
      text = `(${item.msg_type})`
    }
    return {
      timestamp: parseInt(item.create_time, 10),  // 飞书 create_time 是毫秒字符串
      senderProfile,
      text,
    }
  })
}

async function askLLMForDecision(
  params: StartSupervisionParams,
  chatId: string,
  recent: RecentMessage[],
  botProfiles: string[],
  idleMs: number
): Promise<FollowUpDecision> {
  const idleMinutes = Math.round(idleMs / 60000)
  const recentLines = recent.map(r => {
    const sender = r.senderProfile ? `@${r.senderProfile}` : '(用户)'
    const time = new Date(r.timestamp).toLocaleString('zh-CN')
    return `[${time}] ${sender}: ${r.text}`
  }).join('\n')

  const prompt = `你是项目监督者，负责检测群聊是否卡住并补一刀 @。下面是某 IM 群的最近消息记录，已停滞 ${idleMinutes} 分钟。

群里可被 @ 的 agent 列表：${botProfiles.join(', ')}

最近消息（按时间正序）：
${recentLines}

请判断：
1. 当前对话流程是否真的"卡住了"需要监督者介入（例如某 agent 漏 @ 下一个 agent；或用户提了问题没人接），还是已经自然结束/暂停（用户说"算了/结束"等）。
2. 如果需要介入，该 @ 列表里哪个 agent 把流程续上。
3. 给出简短的跟进文案，**必须包含字面 @{agent_name}**。

仅输出一段 JSON，严格遵守以下格式，不要任何额外文字、说明或代码块标记：

{"shouldFollowUp": true 或 false, "mention": "<agent_name>", "message": "<跟进文案，含 @{agent_name}>", "reason": "<判断理由，简短>"}

若 shouldFollowUp 为 false，mention 与 message 可省略。`

  // 监督判断本质无状态。每次都用同一 conversationId（避免 session 文件无限累积），
  // 但调用前 clearSession 一次，确保上一次的输出/重试错误不会作为上下文污染本次判断。
  const conversationId = `supervision-${chatId}`
  clearSession(conversationId, params.workDir, params.profile, params.channelType)

  const response = await callClaude({
    message: prompt,
    conversationId,
    workDir: params.workDir,
    isGroup: false,
    profile: params.profile,
    channel: params.channelType,
  })

  return parseDecision(response)
}

function parseDecision(text: string): FollowUpDecision {
  // 宽松匹配：取最末一个 {...} 段
  const matches = text.match(/\{[\s\S]*?\}/g)
  if (!matches || matches.length === 0) {
    return { shouldFollowUp: false, reason: 'LLM 返回中找不到 JSON' }
  }
  // 偏好最长的（最完整）；若简单匹配错误，取最后一个
  let best = matches[matches.length - 1]
  for (const m of matches) {
    if (m.length > best.length) best = m
  }
  try {
    return JSON.parse(best) as FollowUpDecision
  } catch {
    return { shouldFollowUp: false, reason: 'LLM JSON 解析失败' }
  }
}

function validateDecision(decision: FollowUpDecision, botProfiles: string[]): boolean {
  if (decision.shouldFollowUp === false) return true
  if (decision.shouldFollowUp !== true) {
    decision.reason = 'shouldFollowUp 字段缺失或非布尔'
    return false
  }
  if (!decision.mention || typeof decision.mention !== 'string') {
    decision.reason = 'mention 缺失'
    return false
  }
  if (!botProfiles.includes(decision.mention)) {
    decision.reason = `mention "${decision.mention}" 不在 agent 列表 [${botProfiles.join(', ')}] 中`
    return false
  }
  if (!decision.message || typeof decision.message !== 'string') {
    decision.reason = 'message 缺失'
    return false
  }
  if (!decision.message.includes(`@${decision.mention}`)) {
    decision.reason = `message 中缺少字面 @${decision.mention}`
    return false
  }
  return true
}
