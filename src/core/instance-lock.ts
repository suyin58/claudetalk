/**
 * 单实例运行时锁 —— 防止同一个 bot 凭据被多进程并发消费消息
 *
 * 锁文件位置：~/.claudetalk/locks/{channel}-{sha256(credential).slice(0,12)}.lock
 * - 凭据指纹避免明文存储
 * - 按凭据隔离：同一份配置在多目录启动时也会被拦下，这是想要的行为
 * - 探活清理 stale lock：上次进程被 SIGKILL 而未清理时不会卡死后续启动
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getGlobalLocksDir } from './global-config.js'

export interface LockInfo {
  pid: number
  workDir: string
  profile?: string
  channel: string
  startedAt: string
}

export type AcquireResult =
  | { ok: true; lockKey: string }
  | { ok: false; existing: LockInfo; lockKey: string }

function getLockKey(channel: string, credential: string): string {
  const digest = createHash('sha256').update(credential).digest('hex').slice(0, 12)
  return `${channel}-${digest}`
}

function getLockFilePath(lockKey: string): string {
  return join(getGlobalLocksDir(), `${lockKey}.lock`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLockFile(lockPath: string): LockInfo | null {
  try {
    const content = readFileSync(lockPath, 'utf-8')
    return JSON.parse(content) as LockInfo
  } catch {
    return null
  }
}

function writeLockAtomic(lockPath: string, info: LockInfo): void {
  const dir = getGlobalLocksDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmpPath = `${lockPath}.${process.pid}.tmp`
  writeFileSync(tmpPath, JSON.stringify(info, null, 2) + '\n', 'utf-8')
  renameSync(tmpPath, lockPath)
}

/**
 * O_EXCL 互斥创建：成功 = 文件原本不存在；EEXIST = 已有别人持锁
 * 用于消除 existsSync→write 之间的 TOCTOU 窗口
 */
function tryExclusiveCreate(lockPath: string, info: LockInfo): boolean {
  const dir = getGlobalLocksDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  try {
    writeFileSync(lockPath, JSON.stringify(info, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' })
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    throw error
  }
}

/**
 * 尝试为指定 bot 凭据获取实例锁
 * - 锁文件不存在 → O_EXCL 互斥创建，返回 ok
 * - 锁存在但进程已死 → 视为 stale，强制覆盖（tmp+rename），返回 ok
 * - 锁存在且进程在跑 → 返回 ok: false 含已有锁信息（由 caller 决定如何提示）
 */
export function acquireBotLock(params: {
  channel: string
  credential: string
  pid: number
  workDir: string
  profile?: string
}): AcquireResult {
  const lockKey = getLockKey(params.channel, params.credential)
  const lockPath = getLockFilePath(lockKey)
  const info: LockInfo = {
    pid: params.pid,
    workDir: params.workDir,
    profile: params.profile,
    channel: params.channel,
    startedAt: new Date().toISOString(),
  }

  // 首选：O_EXCL 互斥创建，规避 existsSync→write 间的 TOCTOU race
  if (tryExclusiveCreate(lockPath, info)) {
    return { ok: true, lockKey }
  }

  // 文件已存在：判断持有者是否还活着
  const existing = readLockFile(lockPath)
  if (existing && existing.pid !== params.pid && isProcessAlive(existing.pid)) {
    return { ok: false, existing, lockKey }
  }

  // stale lock（文件损坏或进程已死）→ 强制覆盖（仍用 tmp+rename 保证写入原子）
  writeLockAtomic(lockPath, info)
  return { ok: true, lockKey }
}

/**
 * 释放锁：仅当锁文件内 pid 匹配自己时才删
 * 防止误删 stale lock 被覆盖后属于其他进程的锁
 */
export function releaseBotLock(channel: string, credential: string, pid: number): void {
  const lockKey = getLockKey(channel, credential)
  const lockPath = getLockFilePath(lockKey)
  if (!existsSync(lockPath)) {
    return
  }
  const existing = readLockFile(lockPath)
  if (existing?.pid !== pid) {
    // 锁已被他人占据（理论上不会发生：我们 acquire 后只有自己会 release）
    return
  }
  try {
    unlinkSync(lockPath)
  } catch {
    // 并发删除等竞态忽略
  }
}

/**
 * 从 ClaudeTalk 配置中提取某个 channel 的凭据指纹来源字段
 * 返回 null 表示该 channel 配置中没有可用作锁 key 的凭据
 */
export function extractCredential(channel: string, channelConfig: Record<string, unknown> | undefined): string | null {
  if (!channelConfig) return null
  switch (channel) {
    case 'dingtalk': {
      const v = channelConfig['DINGTALK_CLIENT_ID']
      return typeof v === 'string' && v.length > 0 ? v : null
    }
    case 'feishu': {
      const v = channelConfig['FEISHU_APP_ID']
      return typeof v === 'string' && v.length > 0 ? v : null
    }
    default:
      return null
  }
}
