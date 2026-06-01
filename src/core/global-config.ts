/**
 * 全局配置路径与解析
 * 全局配置存放在 ~/.claudetalk/，跨工作目录复用
 * 加载优先级：本地 {workDir}/.claudetalk.json > 全局 ~/.claudetalk/config.json
 */

import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const LOCAL_CONFIG_FILENAME = '.claudetalk.json'
export const GLOBAL_DIR_NAME = '.claudetalk'
export const GLOBAL_CONFIG_FILENAME = 'config.json'

export type ConfigSource = 'local' | 'global'

export interface ResolvedConfig {
  path: string
  source: ConfigSource
}

export function getGlobalDir(): string {
  return join(homedir(), GLOBAL_DIR_NAME)
}

export function getGlobalConfigPath(): string {
  return join(getGlobalDir(), GLOBAL_CONFIG_FILENAME)
}

export function getGlobalAgentsDir(): string {
  return join(getGlobalDir(), 'agents')
}

export function getGlobalLocksDir(): string {
  return join(getGlobalDir(), 'locks')
}

export function getLocalConfigPath(workDir: string): string {
  return join(workDir, LOCAL_CONFIG_FILENAME)
}

/**
 * 按优先级查找配置文件位置
 * 本地存在 → local；否则全局存在 → global；都不存在 → null
 * 不做合并；定位即返回
 */
export function resolveConfigPath(workDir: string): ResolvedConfig | null {
  const localPath = getLocalConfigPath(workDir)
  if (existsSync(localPath)) {
    return { path: localPath, source: 'local' }
  }
  const globalPath = getGlobalConfigPath()
  if (existsSync(globalPath)) {
    return { path: globalPath, source: 'global' }
  }
  return null
}
