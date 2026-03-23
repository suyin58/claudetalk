#!/usr/bin/env node
/**
 * ClaudeTalk CLI - 钉钉机器人接入 Claude Code
 * 通过 claudetalk 命令启动，自动管理配置文件
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'

// ========== 配置文件管理 ==========
const GLOBAL_CONFIG_DIR = join(homedir(), '.claudetalk')
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'claudetalk.json')
// 兼容旧路径
const CONFIG_DIR = GLOBAL_CONFIG_DIR
const CONFIG_FILE = GLOBAL_CONFIG_FILE

// 工作目录下的本地配置文件名
const LOCAL_CONFIG_FILENAME = '.claudetalk.json'

interface ProfileConfig {
  DINGTALK_CLIENT_ID?: string
  DINGTALK_CLIENT_SECRET?: string
  systemPrompt?: string
}

interface ClaudeTalkConfig {
  DINGTALK_CLIENT_ID: string
  DINGTALK_CLIENT_SECRET: string
  systemPrompt?: string
  // 多角色配置：key 为角色名，value 为该角色的配置（会覆盖顶层字段）
  profiles?: Record<string, ProfileConfig>
}

/**
 * 从指定路径加载配置文件，按 profile 解析后返回有效配置或 null
 * @param filePath 配置文件路径
 * @param profile 角色名，不传则使用顶层默认配置
 */
function loadConfigFromFile(filePath: string, profile?: string): ClaudeTalkConfig | null {
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const content = readFileSync(filePath, 'utf-8')
    const raw = JSON.parse(content) as ClaudeTalkConfig

    // 指定了 profile 但该 profile 不存在时，直接返回 null（不降级到顶层默认配置）
    if (profile && !raw.profiles?.[profile]) {
      return null
    }

    // 合并顶层配置和指定 profile 的配置（profile 字段优先）
    const profileOverride = profile ? (raw.profiles?.[profile] ?? {}) : {}
    const merged: ClaudeTalkConfig = {
      ...raw,
      ...profileOverride,
      // profiles 字段本身不需要透传
      profiles: raw.profiles,
    }

    if (merged.DINGTALK_CLIENT_ID && merged.DINGTALK_CLIENT_SECRET) {
      return merged
    }
    return null
  } catch {
    return null
  }
}

/**
 * 按优先级加载配置：
 * 1. 工作目录下的 .claudetalk.json（最高优先级，支持多目录不同机器人）
 * 2. 全局 ~/.claudetalk/claudetalk.json
 * 返回配置内容和来源路径，方便启动时展示
 */
function loadConfig(workDir: string): { config: ClaudeTalkConfig; source: string } | null {
  // 优先级 1：工作目录本地配置
  const localConfigFile = join(workDir, LOCAL_CONFIG_FILENAME)
  const localConfig = loadConfigFromFile(localConfigFile)
  if (localConfig) {
    return { config: localConfig, source: localConfigFile }
  }

  // 优先级 2：全局配置
  const globalConfig = loadConfigFromFile(GLOBAL_CONFIG_FILE)
  if (globalConfig) {
    return { config: globalConfig, source: GLOBAL_CONFIG_FILE }
  }

  return null
}

/**
 * 保存配置到指定路径
 */
function saveConfigToFile(config: ClaudeTalkConfig, filePath: string, dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

function saveConfig(config: ClaudeTalkConfig): void {
  saveConfigToFile(config, GLOBAL_CONFIG_FILE, GLOBAL_CONFIG_DIR)
}

function promptInput(question: string): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((resolve) => {
    readline.question(question, (answer) => {
      readline.close()
      resolve(answer.trim())
    })
  })
}

/**
 * 将 profile 配置写入配置文件（合并到已有文件的 profiles 字段中）
 */
function saveProfileToFile(
  profileName: string,
  profileConfig: ProfileConfig,
  filePath: string,
  dirPath: string
): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }

  // 读取已有配置（如果存在），避免覆盖其他 profile
  let existing: ClaudeTalkConfig = { DINGTALK_CLIENT_ID: '', DINGTALK_CLIENT_SECRET: '' }
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, 'utf-8')) as ClaudeTalkConfig
    } catch {
      // 文件损坏则重建
    }
  }

  const updated: ClaudeTalkConfig = {
    ...existing,
    profiles: {
      ...(existing.profiles ?? {}),
      [profileName]: profileConfig,
    },
  }
  writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8')
}

/**
 * 交互式配置向导
 * @param saveToLocal 是否保存到工作目录（true）还是全局目录（false）
 * @param workDir 当前工作目录（saveToLocal 为 true 时使用）
 * @param profile 角色名，不传则配置默认角色
 */
async function interactiveSetup(saveToLocal: boolean, workDir: string, profile?: string): Promise<ClaudeTalkConfig> {
  const targetFile = saveToLocal
    ? join(workDir, LOCAL_CONFIG_FILENAME)
    : GLOBAL_CONFIG_FILE
  const targetDir = saveToLocal ? workDir : GLOBAL_CONFIG_DIR

  // 读取已有配置（如果存在），用于展示现有值和保留原值
  const existingRaw = existsSync(targetFile)
    ? (() => { try { return JSON.parse(readFileSync(targetFile, 'utf-8')) as ClaudeTalkConfig } catch { return null } })()
    : null
  const existingConfig = profile
    ? (existingRaw?.profiles?.[profile] ?? null)
    : existingRaw

  console.log('')
  console.log('🤖 ClaudeTalk 配置向导')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  if (profile) {
    console.log(`🎭 角色: ${profile}`)
  }
  if (saveToLocal) {
    console.log(`📁 配置将保存到当前工作目录: ${targetFile}`)
    console.log('   （此配置仅对当前目录生效，优先级高于全局配置）')
  } else {
    console.log(`🌐 配置将保存到全局目录: ${targetFile}`)
    console.log('   （此配置对所有未设置本地配置的目录生效）')
  }

  if (existingConfig) {
    const existingId = (existingConfig as ClaudeTalkConfig).DINGTALK_CLIENT_ID || (existingConfig as ProfileConfig).DINGTALK_CLIENT_ID || ''
    const existingSecret = (existingConfig as ClaudeTalkConfig).DINGTALK_CLIENT_SECRET || (existingConfig as ProfileConfig).DINGTALK_CLIENT_SECRET || ''
    const existingPrompt = (existingConfig as ClaudeTalkConfig).systemPrompt || (existingConfig as ProfileConfig).systemPrompt || ''
    console.log('')
    console.log('📋 当前已有配置（直接回车保留原值）:')
    if (existingId) console.log(`   DINGTALK_CLIENT_ID    : ${existingId}`)
    if (existingSecret) console.log(`   DINGTALK_CLIENT_SECRET: ${existingSecret.substring(0, 4)}****`)
    if (existingPrompt) console.log(`   systemPrompt          : ${existingPrompt.substring(0, 60)}${existingPrompt.length > 60 ? '...' : ''}`)
  } else {
    console.log('')
    console.log('请提供钉钉机器人的 AppKey 和 AppSecret。')
    console.log('你可以在钉钉开放平台 (https://open-dev.dingtalk.com) 创建应用并获取。')
  }
  console.log('')

  const existingId = (existingConfig as ClaudeTalkConfig | null)?.DINGTALK_CLIENT_ID || (existingConfig as ProfileConfig | null)?.DINGTALK_CLIENT_ID || ''
  const existingSecret = (existingConfig as ClaudeTalkConfig | null)?.DINGTALK_CLIENT_SECRET || (existingConfig as ProfileConfig | null)?.DINGTALK_CLIENT_SECRET || ''
  const existingPrompt = (existingConfig as ClaudeTalkConfig | null)?.systemPrompt || (existingConfig as ProfileConfig | null)?.systemPrompt || ''

  const clientIdInput = await promptInput(
    existingId
      ? `DINGTALK_CLIENT_ID (AppKey) [${existingId}]: `
      : '请输入 DINGTALK_CLIENT_ID (AppKey): '
  )
  const clientId = clientIdInput || existingId
  if (!clientId) {
    console.error('❌ DINGTALK_CLIENT_ID 不能为空')
    process.exit(1)
  }

  const clientSecretInput = await promptInput(
    existingSecret
      ? `DINGTALK_CLIENT_SECRET (AppSecret) [${existingSecret.substring(0, 4)}****]: `
      : '请输入 DINGTALK_CLIENT_SECRET (AppSecret): '
  )
  const clientSecret = clientSecretInput || existingSecret
  if (!clientSecret) {
    console.error('❌ DINGTALK_CLIENT_SECRET 不能为空')
    process.exit(1)
  }

  console.log('')
  console.log('📝 角色描述（可选）')
  console.log('   设置后，Claude 在每次新建会话时会了解你的要求。')
  console.log('   示例: "你在这里面负责什么？有什么特别的要求？"')
  if (existingPrompt) {
    console.log('   直接回车保留原值，输入空格后回车可清除。')
  } else {
    console.log('   直接回车跳过。')
  }
  const systemPromptInput = await promptInput(
    existingPrompt
      ? `systemPrompt [${existingPrompt.substring(0, 40)}${existingPrompt.length > 40 ? '...' : ''}]: `
      : 'systemPrompt: '
  )
  const systemPrompt = systemPromptInput === ' ' ? '' : (systemPromptInput || existingPrompt)

  if (profile) {
    // 保存到 profiles.<profile> 字段
    const profileConfig: ProfileConfig = { DINGTALK_CLIENT_ID: clientId, DINGTALK_CLIENT_SECRET: clientSecret }
    if (systemPrompt) profileConfig.systemPrompt = systemPrompt
    saveProfileToFile(profile, profileConfig, targetFile, targetDir)
    console.log('')
    console.log(`✅ 角色 [${profile}] 配置已保存到 ${targetFile}`)
    console.log('')
    // 返回合并后的完整配置（兼容调用方）
    return { DINGTALK_CLIENT_ID: clientId, DINGTALK_CLIENT_SECRET: clientSecret, systemPrompt }
  } else {
    // 保存为顶层默认配置
    const existingFull = existingRaw ?? { DINGTALK_CLIENT_ID: '', DINGTALK_CLIENT_SECRET: '' }
    const config: ClaudeTalkConfig = {
      ...existingFull,
      DINGTALK_CLIENT_ID: clientId,
      DINGTALK_CLIENT_SECRET: clientSecret,
    }
    if (systemPrompt) config.systemPrompt = systemPrompt
    else delete config.systemPrompt
    saveConfigToFile(config, targetFile, targetDir)
    console.log('')
    console.log(`✅ 配置已保存到 ${targetFile}`)
    console.log('')
    return config
  }
}

/**
 * 从 process.argv 中解析 --profile <name> 的值
 */
function parseProfileArg(): string | undefined {
  const index = process.argv.indexOf('--profile')
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1]
  }
  return undefined
}

// ========== 主流程 ==========
async function main(): Promise<void> {
  const workDir = process.cwd()
  const isSetupLocal = process.argv.includes('--local')
  const profile = parseProfileArg()

  // 处理 --help
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
ClaudeTalk - 钉钉机器人接入 Claude Code

用法:
  claudetalk                              启动默认角色机器人
  claudetalk --profile <name>             启动指定角色机器人
  claudetalk --setup                      配置全局默认凭据
  claudetalk --setup --local              配置当前目录默认凭据
  claudetalk --setup --local --profile <name>  配置当前目录指定角色
  claudetalk --help                       显示帮助信息

多角色配置示例（.claudetalk.json）:
  {
    "DINGTALK_CLIENT_ID": "默认机器人 AppKey",
    "DINGTALK_CLIENT_SECRET": "默认机器人 AppSecret",
    "profiles": {
      "pm": {
        "DINGTALK_CLIENT_ID": "PM 机器人 AppKey",
        "DINGTALK_CLIENT_SECRET": "PM 机器人 AppSecret",
        "systemPrompt": "你在这里面负责产品需求，还负责任务拆解，按照业务要求制定工作计划"
      },
      "dev": {
        "DINGTALK_CLIENT_ID": "Dev 机器人 AppKey",
        "DINGTALK_CLIENT_SECRET": "Dev 机器人 AppSecret",
        "systemPrompt": "你在这里面负责服务端架构设计和开发，依据系统间的依赖关系制定开发计划"
      }
    }
  }

配置文件（优先级从高到低）:
  .claudetalk.json              当前工作目录配置（优先）
  ~/.claudetalk/claudetalk.json 全局配置（兜底）

环境变量（优先级最低）:
  DINGTALK_CLIENT_ID      钉钉应用 AppKey
  DINGTALK_CLIENT_SECRET  钉钉应用 AppSecret
`)
    process.exit(0)
  }

  // 处理 --setup：配置钉钉凭据
  if (process.argv.includes('--setup')) {
    await interactiveSetup(isSetupLocal, workDir, profile)
    console.log('配置完成！运行 claudetalk 启动机器人。')
    process.exit(0)
  }

  // 1. 按 profile 加载配置（本地优先，全局兜底）
  let clientId = ''
  let clientSecret = ''
  let systemPrompt = ''
  let configSource = '环境变量'

  const localConfigFile = join(workDir, LOCAL_CONFIG_FILENAME)
  const localConfig = loadConfigFromFile(localConfigFile, profile)
  const globalConfig = loadConfigFromFile(GLOBAL_CONFIG_FILE, profile)

  if (localConfig) {
    clientId = localConfig.DINGTALK_CLIENT_ID
    clientSecret = localConfig.DINGTALK_CLIENT_SECRET
    systemPrompt = localConfig.systemPrompt || ''
    configSource = localConfigFile
  } else if (globalConfig) {
    clientId = globalConfig.DINGTALK_CLIENT_ID
    clientSecret = globalConfig.DINGTALK_CLIENT_SECRET
    systemPrompt = globalConfig.systemPrompt || ''
    configSource = GLOBAL_CONFIG_FILE
  }

  // 2. 指定了 profile 但找不到对应配置时，直接报错退出（不降级到环境变量）
  if (profile && !clientId) {
    console.error(`❌ 未找到角色 [${profile}] 的配置。`)
    console.error('')
    console.error(`请先运行以下命令配置此角色：`)
    console.error(`  claudetalk --setup --local --profile ${profile}`)
    console.error('')
    console.error(`或查看当前配置文件: ${join(workDir, LOCAL_CONFIG_FILENAME)}`)
    process.exit(1)
  }

  // 3. 配置文件都没有时，从环境变量读取
  if (!clientId) clientId = process.env.DINGTALK_CLIENT_ID || ''
  if (!clientSecret) clientSecret = process.env.DINGTALK_CLIENT_SECRET || ''

  // 4. 如果都没有，引导用户设置
  if (!clientId || !clientSecret) {
    console.log('⚠️  未找到任何钉钉配置。')
    console.log('')
    if (profile) {
      console.log(`当前角色: ${profile}`)
      console.log(`你可以运行: claudetalk --setup --local --profile ${profile}`)
    } else {
      console.log('你可以通过以下方式配置：')
      console.log('  1. 运行交互式配置（现在）')
      console.log('  2. 全局配置: claudetalk --setup')
      console.log('  3. 当前目录配置: claudetalk --setup --local')
      console.log('  4. 设置环境变量: export DINGTALK_CLIENT_ID=xxx && export DINGTALK_CLIENT_SECRET=xxx')
    }
    console.log('')

    const answer = await promptInput('是否现在进行交互式配置？(Y/n): ')
    if (answer.toLowerCase() === 'n') {
      process.exit(0)
    }

    const config = await interactiveSetup(false, workDir, profile)
    clientId = config.DINGTALK_CLIENT_ID
    clientSecret = config.DINGTALK_CLIENT_SECRET
    systemPrompt = config.systemPrompt || ''
    configSource = GLOBAL_CONFIG_FILE
  }

  // 设置环境变量，供后续模块使用
  process.env.DINGTALK_CLIENT_ID = clientId
  process.env.DINGTALK_CLIENT_SECRET = clientSecret

  // 显示启动信息
  console.log('')
  console.log('🚀 ClaudeTalk 启动中...')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`📁 工作目录: ${workDir}`)
  if (profile) console.log(`🎭 角色: ${profile}`)
  console.log(`🔑 AppKey: ${clientId.substring(0, 8)}...`)
  console.log(`📄 配置来源: ${configSource}`)
  if (profile) {
    console.log(`💡 配置此角色: claudetalk --setup --local --profile ${profile}`)
  } else {
    console.log(`💡 工作目录专属机器人: claudetalk --setup --local`)
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')

  // 动态导入并启动 bot
  const { startBot } = await import('./index.js')
  await startBot({
    clientId,
    clientSecret,
    workDir,
    profile,
    systemPrompt,
  })
}

main().catch((error) => {
  console.error('❌ 启动失败:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
