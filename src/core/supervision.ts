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

const RECENT_LIMIT = 10        // 给 LLM 的最近消息条数
const LLM_TIMEOUT_MS = 60_000  // 单次 LLM 调用超时；超时即 drop 本群，避免 busy 锁永远不释放
const TOKEN_REFRESH_BUFFER_MS = 60_000  // token 过期前 60s 视为失效，提前刷新

// 飞书 tenant_access_token 缓存（按 appId 维度；同进程内多 supervisor 共享）
const feishuTokenCache = new Map<string, { token: string; expiresAt: number }>()

interface RecentMessage {
  timestamp: number
  /** bot 发送时是 profileName；user 发送时是 null */
  senderProfile: string | null
  text: string
}

interface FollowUpDecision {
  shouldFollowUp: boolean
  /** 要 @ 的目标 profileName（仅是 key，<at> 标签由代码后置组装） */
  mention?: string
  /** 跟进文案正文（不含 @ 标签） */
  message?: string
  reason?: string
}

/**
 * BotInfo 携带所有 routing ID（不同 channel 用不同字段），不再强制 openId。
 * - feishu: openId + appId 都有
 * - dingtalk: clientId
 *
 * isSelf: 当前 supervisor 进程对应的 bot（即 pm 本身）。
 * 不再从列表里剔除，而是把信息透明给 LLM，由 LLM 基于历史判断要不要 @ 自己。
 * 自激保护已由 checkOneChat 里的「最后说话人是自己 → 跳过」兜底（最多 1 轮自答自答）。
 */
interface BotInfo {
  profileName: string
  displayName: string
  openId?: string
  appId?: string
  clientId?: string
  isSelf?: boolean
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
  let ticking = false  // busy 锁：上一轮未完成就跳过本轮，避免并发叠加

  logger(
    `监督循环已启动 (检查间隔 ${settings.checkIntervalMs / 60000} 分钟, ` +
    `停滞阈值 ${settings.staleThresholdMs / 60000} 分钟, ` +
    `冷却 ${settings.cooldownMs / 60000} 分钟)`
  )

  const tick = async () => {
    if (stopped) return
    if (ticking) {
      logger('上一轮检查仍在进行，跳过本轮')
      return
    }
    ticking = true
    try {
      await runOneCheck(params, settings, lastInterventionAt, logger)
    } catch (error) {
      logger(`[ERROR] 监督检查失败: ${error}`)
    } finally {
      ticking = false
    }
  }

  // 启动时延迟随机 5-15s 跑首次 tick：
  // - 不必等满 checkIntervalMs 才能检测停滞
  // - 多 bot 进程同时启动 / 单进程重启 时错峰，避免对 LLM 和 IM API 集中爆发
  const firstTickDelayMs = 5_000 + Math.floor(Math.random() * 10_000)
  const firstTickTimer = setTimeout(() => { void tick() }, firstTickDelayMs)
  const handle = setInterval(() => { void tick() }, settings.checkIntervalMs)

  return {
    stop() {
      stopped = true
      clearTimeout(firstTickTimer)
      clearInterval(handle)
      logger('监督循环已停止')
    }
  }
}

/**
 * 给 Promise 加超时；超时抛错由 caller catch
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
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
  // profileName 比对 case-insensitive，防止配置大小写不一致影响 self 标记
  const selfKey = params.profile.toLowerCase()
  // 按 profileName 去重：多次注册可能写入重复条目，保留第一条即可
  const seen = new Set<string>()
  const botInfos: BotInfo[] = botSelf
    .map((b): BotInfo | null => {
      const x = b as { profileName?: string; name?: string; openId?: string; appId?: string; clientId?: string }
      if (!x.profileName || !x.name) return null
      const profileLower = x.profileName.toLowerCase()
      if (seen.has(profileLower)) return null
      seen.add(profileLower)
      return {
        profileName: x.profileName,
        displayName: x.name,
        openId: x.openId,
        appId: x.appId,
        clientId: x.clientId,
        isSelf: profileLower === selfKey,
      }
    })
    .filter((x): x is BotInfo => x !== null)

  if (botInfos.length === 0) {
    logger('暂无任何 agent（_bot_self 为空），跳过本轮')
    return
  }
  if (botInfos.every(b => b.isSelf)) {
    logger('_bot_self 中仅有 supervisor 自己，无其他 agent 可调度，跳过本轮')
    return
  }

  const now = Date.now()
  for (const chatId of chatIds) {
    await checkOneChat(chatId, params, settings, lastInterventionAt, botInfos, now, logger)
  }
}

async function checkOneChat(
  chatId: string,
  params: StartSupervisionParams,
  settings: { staleThresholdMs: number; cooldownMs: number },
  lastInterventionAt: Map<string, number>,
  botInfos: BotInfo[],
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
    let decision: FollowUpDecision
    try {
      decision = await withTimeout(
        askLLMForDecision(params, chatId, recent, botInfos, idle),
        LLM_TIMEOUT_MS,
        `[${chatId}] LLM 调用`
      )
    } catch (error) {
      logger(`[${chatId}] LLM 调用超时或失败，drop: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let validation = validateDecision(decision, botInfos)
    if (!validation.ok) {
      logger(`[${chatId}] LLM 输出校验失败 (${validation.reason ?? 'unknown'})，重试一次...`)
      try {
        decision = await withTimeout(
          askLLMForDecision(params, chatId, recent, botInfos, idle),
          LLM_TIMEOUT_MS,
          `[${chatId}] LLM 重试`
        )
      } catch (error) {
        logger(`[${chatId}] LLM 重试超时或失败，drop: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      validation = validateDecision(decision, botInfos)
      if (!validation.ok) {
        logger(`[${chatId}] LLM 输出校验仍失败 (${validation.reason ?? 'unknown'})，drop`)
        return
      }
    }

    if (!decision.shouldFollowUp) {
      logger(`[${chatId}] LLM 判定无需跟进: ${decision.reason ?? '(no reason)'}`)
      return
    }

    // validateDecision 已确保 target 必存在；这里 ! 断言简化代码
    const target = botInfos.find(b => b.profileName === decision.mention)!
    // 若 LLM 选了 self（pm 自己），单独打一条 log 便于审计（不阻拦，由 LLM 自主判断）
    if (target.isSelf) {
      logger(`[${chatId}] LLM 选择 @ self (${target.profileName})，将触发一轮自答；reason=${decision.reason ?? '(no reason)'}`)
    }
    // 由代码组装 channel 专属 @ 标签，LLM 的 message 只是纯文本正文
    const tag = params.channel.formatMention({
      profileName: target.profileName,
      displayName: target.displayName,
      openId: target.openId,
      appId: target.appId,
      clientId: target.clientId,
    })
    const finalMessage = `${tag} ${decision.message!.trim()}`
    logger(`[${chatId}] 介入: @${target.displayName}(${target.profileName}) -> ${finalMessage.substring(0, 100)}`)
    await params.channel.sendMessage(chatId, finalMessage, true)
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

  const token = await getFeishuToken(appId, appSecret)
  if (!token) return []

  // 2. 拉历史（按创建时间倒序）；chatId 走 encodeURIComponent 防特殊字符破坏 query
  const historyResp = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&page_size=${limit}&sort_type=ByCreateTimeDesc`,
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
    // 飞书 create_time 是毫秒字符串，偶发返回空/非数字时退回 now，避免下游 NaN 比较把停滞群静默吞掉
    const tsParsed = parseInt(item.create_time, 10)
    const ts = Number.isFinite(tsParsed) ? tsParsed : Date.now()
    return {
      timestamp: ts,
      senderProfile,
      text,
    }
  })
}

async function askLLMForDecision(
  params: StartSupervisionParams,
  chatId: string,
  recent: RecentMessage[],
  botInfos: BotInfo[],
  idleMs: number
): Promise<FollowUpDecision> {
  if (botInfos.length === 0) {
    throw new Error('askLLMForDecision called with empty botInfos')
  }
  const idleMinutes = Math.round(idleMs / 60000)
  const recentLines = recent.map(r => {
    const sender = r.senderProfile ? `@${r.senderProfile}` : '(用户)'
    const time = new Date(r.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    return `[${time}] ${sender}: ${r.text}`
  }).join('\n')

  // 给 LLM 看的 agent 列表只暴露选择必需的两个字段：profileName + 显示名
  // routing ID（openId/appId/clientId）由代码内部组装 <at> 标签，LLM 不需要也不应触碰
  const memberLines = botInfos
    .map(b => b.isSelf
      ? `- profileName=${b.profileName}（显示名：${b.displayName}）⚠️ **这是你自己**（项目监督者本人）`
      : `- profileName=${b.profileName}（显示名：${b.displayName}）`
    )
    .join('\n')
  const selfBot = botInfos.find(b => b.isSelf)
  const selfProfile = selfBot?.profileName ?? '(未知)'

  const prompt = `你是项目监督者，负责检测群聊是否卡住并补一刀 @。下面是某 IM 群的最近消息记录，已停滞 ${idleMinutes} 分钟。

## 群里可被 @ 的 agent

${memberLines}

### 关于 @ 你自己（mention=${selfProfile}）的特殊说明

如果你判断流程下一步该由项目经理本人推进，可以选 mention=${selfProfile}，但要意识到这条 @ 的实际效果：
1. ${selfProfile} 收到 @ → 给出一次回复 → 群里"最后说话人"变成 ${selfProfile}
2. 你下次 tick 时会因「最后一条是项目经理自己发的」而自动跳过该轮（这是已有的自激保护）
3. 即：最多 1 轮"自答自"，之后流程暂停等下一个外部输入

请基于历史**自行判断**该选哪种：
- 若对话状态是「需要项目经理给出阶段性指令 / 总结 / 决定下一步」 → 选 mention=${selfProfile} 是合理的，那 1 轮自答能起到推进作用
- 若对话状态是「等外部人类决策 / 等甲方回复 / 等不可控的外部输入」 → 选 mention=${selfProfile} 没意义（自己也答不了），**应输出 shouldFollowUp: false**
- 若某个具体业务 agent（如 front/back/test/...）有明显未交付的工作 → 优先 @ 那个 agent，比 @ ${selfProfile} 更直接

最近消息（按时间正序）：
${recentLines}

请判断：
1. 当前对话流程是否真的"卡住了"需要监督者介入（例如某 agent 漏 @ 下一个 agent；或用户提了问题没人接），还是已经自然结束/暂停（用户说"算了/结束"等）。
2. 如果需要介入，该 @ 哪个 agent 把流程续上。从上表 profileName 中选一个填到 mention 字段（含上文「特殊说明」的考量）。
3. 给出简短跟进文案放到 message 字段，**纯文本正文即可，不要写 @ 标签**——@ 标签会由系统按当前频道（飞书/钉钉）的规范自动组装并前置到你的文案前。

仅输出一段 JSON，严格遵守以下格式，不要任何额外文字、说明或代码块标记：

{"shouldFollowUp": true 或 false, "mention": "<profileName>", "message": "<跟进正文，纯文本>", "reason": "<判断理由，简短>"}

**⚠️ JSON 字符串格式约束（极重要）**：
message 与 reason 字段是 JSON 字符串，内部若需引用某段话，**严禁使用半角双引号 "**——必须改用中文引号 「」 或英文单引号 ''。半角双引号会让 JSON 解析失败、消息发不出去。
- ✘ 错误："message": "他说"已完成"了" ← 内部双引号会断开 JSON 字符串
- ✓ 正确："message": "他说「已完成」了"
- ✓ 正确："message": "他说'已完成'了"

示例：

{"shouldFollowUp": true, "mention": "${botInfos[0].profileName}", "message": "请补充上次评审的待澄清项。", "reason": "已停滞 30 分钟，需求评审待${botInfos[0].displayName}接力。"}

若 shouldFollowUp 为 false，mention 与 message 可省略。`

  // 监督判断本质无状态。每次都用同一 conversationId（避免 session 文件无限累积），
  // 但调用前 clearSession 一次，确保上一次的输出/重试错误不会作为上下文污染本次判断。
  //
  // 关键：profile 显式传 undefined —— 不希望主循环被注入 PM 角色 systemPrompt（否则 LLM
  // 同时被告知「你是项目经理」和「你是严格输出 JSON 的监督判官」，回答会偏散文 → JSON 解析必失败）。
  // clearSession 也必须用 undefined 才能命中 callClaude 即将使用的 sessionKey。
  const conversationId = `supervision-${chatId}`
  clearSession(conversationId, params.workDir, undefined, params.channelType)

  const response = await callClaude({
    message: prompt,
    conversationId,
    workDir: params.workDir,
    isGroup: false,
    profile: undefined,
    channel: params.channelType,
  })

  return parseDecision(response)
}

/**
 * 取飞书 tenant_access_token，命中且未过期则复用
 * token TTL ~ 2h；每个监督 tick 都重申会浪费配额并可能被风控
 */
async function getFeishuToken(appId: string, appSecret: string): Promise<string | null> {
  const now = Date.now()
  const cached = feishuTokenCache.get(appId)
  if (cached && cached.expiresAt - now > TOKEN_REFRESH_BUFFER_MS) {
    return cached.token
  }
  try {
    const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const tokenData = await tokenResp.json() as {
      code: number
      tenant_access_token?: string
      expire?: number  // 秒
    }
    if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
      return null
    }
    const ttlMs = (tokenData.expire ?? 7200) * 1000
    feishuTokenCache.set(appId, {
      token: tokenData.tenant_access_token,
      expiresAt: now + ttlMs,
    })
    return tokenData.tenant_access_token
  } catch {
    return null
  }
}

/**
 * 从文本里扫出所有 top-level {...} 段，正确处理字符串内的 {/} 和转义
 * 用于替代非贪婪正则——后者在 message 里出现 {bug-123} 等字面量时会截断
 */
function extractTopLevelObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (escape) { escape = false; continue }
    if (c === '\\') { escape = true; continue }
    if (c === '"') { inString = !inString; continue }
    if (inString) continue
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start !== -1) {
          out.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  return out
}

// parse 失败的标记前缀：validateDecision 据此触发重试，避免被当成 LLM 真的判 "无需跟进" 而静默吞掉
const PARSE_FAIL_REASON_PREFIX = '[parse-failed]'

/**
 * Best-effort 修复 LLM 写中文 JSON 时常见的「内嵌半角双引号未转义」错误。
 * 例：{"message": "请别再回复"催办已生成"了"} → {"message": "请别再回复\"催办已生成\"了"}
 *
 * 启发式：扫描每个字符串，遇到内嵌 `"` 时 peek 下一个非空白字符——
 * - 是 `:` `,` `}` `]` 或 EOF：判定为真正的字符串结束引号，不动
 * - 否则：视为内嵌引号，替换为 `\"`
 *
 * 对中文自然语言场景几乎无误判风险；纯英文/代码片段值里如果合法包含 `,"` 序列可能误识别，
 * 因此仅在 JSON.parse 失败时作为兜底使用。
 */
function tryFixUnescapedQuotes(text: string): string {
  let result = ''
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (escape) { result += c; escape = false; continue }
    if (c === '\\') { result += c; escape = true; continue }
    if (!inString) {
      result += c
      if (c === '"') inString = true
      continue
    }
    if (c === '"') {
      // peek 下一个非空白字符
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      const next = j < text.length ? text[j] : ''
      if (next === ':' || next === ',' || next === '}' || next === ']' || next === '') {
        result += c          // 真正的字符串结束引号
        inString = false
      } else {
        result += '\\"'      // 内嵌引号，转义
      }
      continue
    }
    result += c
  }
  return result
}

function tryParseOne(candidate: string): FollowUpDecision | null {
  try { return JSON.parse(candidate) as FollowUpDecision } catch { /* try fixer */ }
  try {
    const fixed = tryFixUnescapedQuotes(candidate)
    if (fixed !== candidate) return JSON.parse(fixed) as FollowUpDecision
  } catch { /* fixer didn't help */ }
  return null
}

function parseDecision(text: string): FollowUpDecision {
  // 从后向前找第一个能 JSON.parse 通过的 top-level {...}。
  // 选最后一段而非最长，避免误选 prompt 中的示例 JSON（LLM 偶尔会先 echo 示例再吐真实结果）。
  const candidates = extractTopLevelObjects(text)
  // 截 500 字给 log，长 prompt 不要把日志撑爆
  const rawSnippet = text.trim().substring(0, 500)
  if (candidates.length === 0) {
    return { shouldFollowUp: false, reason: `${PARSE_FAIL_REASON_PREFIX} 返回中找不到 JSON; raw=${rawSnippet}` }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParseOne(candidates[i])
    if (parsed !== null) return parsed
  }
  return { shouldFollowUp: false, reason: `${PARSE_FAIL_REASON_PREFIX} 所有 JSON 段都解析失败（含 fixer 兜底）; raw=${rawSnippet}` }
}

interface ValidationResult {
  ok: boolean
  reason?: string
}

/** 把 decision 序列化进 reason，方便所有 validation 失败时把 LLM 原始输出落盘排查 */
function withDecision(reason: string, decision: FollowUpDecision): string {
  let payload: string
  try { payload = JSON.stringify(decision) }
  catch { payload = String(decision) }
  if (payload.length > 800) payload = payload.substring(0, 800) + '...(truncated)'
  return `${reason}; decision=${payload}`
}

function validateDecision(decision: FollowUpDecision, botInfos: BotInfo[]): ValidationResult {
  // 优先识别 parse 失败：当成 validation 失败 → 触发已有的重试链路（区别于 LLM 真的判 "无需跟进"）
  if (decision.reason?.startsWith(PARSE_FAIL_REASON_PREFIX)) {
    return { ok: false, reason: decision.reason }  // parse-fail 的 reason 已自带 raw 文本
  }
  if (decision.shouldFollowUp === false) return { ok: true }
  if (decision.shouldFollowUp !== true) {
    return { ok: false, reason: withDecision('shouldFollowUp 字段缺失或非布尔', decision) }
  }
  if (!decision.mention || typeof decision.mention !== 'string') {
    return { ok: false, reason: withDecision('mention 缺失', decision) }
  }
  const target = botInfos.find(b => b.profileName === decision.mention)
  if (!target) {
    return {
      ok: false,
      reason: withDecision(
        `mention "${decision.mention}" 不在 agent 列表 [${botInfos.map(b => b.profileName).join(', ')}] 中`,
        decision
      ),
    }
  }
  if (!decision.message || typeof decision.message !== 'string') {
    return { ok: false, reason: withDecision('message 缺失', decision) }
  }
  if (!decision.message.trim()) {
    return { ok: false, reason: withDecision('message 为空字符串', decision) }
  }
  // 不再校验 <at> 标签 —— 标签由代码在 checkOneChat 内用 channel.formatMention 后置组装。
  // 这避免了 LLM 把标签写错（单引号、空白、HTML 转义、跨 channel 格式差异）导致的误 drop。
  return { ok: true }
}
