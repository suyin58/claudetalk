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
const CONFIG_DIR = join(homedir(), '.claudetalk')
const CONFIG_FILE = join(CONFIG_DIR, 'claudetalk.json')

interface ClaudeTalkConfig {
  DINGTALK_CLIENT_ID: string
  DINGTALK_CLIENT_SECRET: string
}

function loadConfig(): ClaudeTalkConfig | null {
  if (!existsSync(CONFIG_FILE)) {
    return null
  }
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8')
    const config = JSON.parse(content) as ClaudeTalkConfig
    if (config.DINGTALK_CLIENT_ID && config.DINGTALK_CLIENT_SECRET) {
      return config
    }
    return null
  } catch {
    return null
  }
}

function saveConfig(config: ClaudeTalkConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8')
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

async function interactiveSetup(): Promise<ClaudeTalkConfig> {
  console.log('')
  console.log('🤖 ClaudeTalk 首次配置')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log('请提供钉钉机器人的 AppKey 和 AppSecret。')
  console.log('你可以在钉钉开放平台 (https://open-dev.dingtalk.com) 创建应用并获取。')
  console.log('')

  const clientId = await promptInput('请输入 DINGTALK_CLIENT_ID (AppKey): ')
  if (!clientId) {
    console.error('❌ DINGTALK_CLIENT_ID 不能为空')
    process.exit(1)
  }

  const clientSecret = await promptInput('请输入 DINGTALK_CLIENT_SECRET (AppSecret): ')
  if (!clientSecret) {
    console.error('❌ DINGTALK_CLIENT_SECRET 不能为空')
    process.exit(1)
  }

  const config: ClaudeTalkConfig = {
    DINGTALK_CLIENT_ID: clientId,
    DINGTALK_CLIENT_SECRET: clientSecret,
  }

  saveConfig(config)
  console.log('')
  console.log(`✅ 配置已保存到 ${CONFIG_FILE}`)
  console.log('')

  return config
}

// ========== 主流程 ==========
async function main(): Promise<void> {
  // 处理 --help
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
ClaudeTalk - 钉钉机器人接入 Claude Code

用法:
  claudetalk              启动钉钉机器人（在当前目录作为工作目录）
  claudetalk --setup      重新配置钉钉凭据
  claudetalk --help       显示帮助信息

配置文件:
  ~/.claudetalk/claudetalk.json

环境变量（优先级高于配置文件）:
  DINGTALK_CLIENT_ID      钉钉应用 AppKey
  DINGTALK_CLIENT_SECRET  钉钉应用 AppSecret
`)
    process.exit(0)
  }

  // 处理 --setup：强制重新配置
  if (process.argv.includes('--setup')) {
    await interactiveSetup()
    console.log('配置完成！运行 claudetalk 启动机器人。')
    process.exit(0)
  }

  // 1. 优先从环境变量读取
  let clientId = process.env.DINGTALK_CLIENT_ID || ''
  let clientSecret = process.env.DINGTALK_CLIENT_SECRET || ''

  // 2. 如果环境变量没有，从配置文件读取
  if (!clientId || !clientSecret) {
    const fileConfig = loadConfig()
    if (fileConfig) {
      clientId = clientId || fileConfig.DINGTALK_CLIENT_ID
      clientSecret = clientSecret || fileConfig.DINGTALK_CLIENT_SECRET
    }
  }

  // 3. 如果都没有，引导用户设置
  if (!clientId || !clientSecret) {
    console.log('⚠️  未找到钉钉配置。')
    console.log('')
    console.log('你可以通过以下方式配置：')
    console.log('  1. 运行交互式配置（现在）')
    console.log('  2. 设置环境变量: export DINGTALK_CLIENT_ID=xxx && export DINGTALK_CLIENT_SECRET=xxx')
    console.log(`  3. 手动创建配置文件: ${CONFIG_FILE}`)
    console.log('')

    const answer = await promptInput('是否现在进行交互式配置？(Y/n): ')
    if (answer.toLowerCase() === 'n') {
      process.exit(0)
    }

    const config = await interactiveSetup()
    clientId = config.DINGTALK_CLIENT_ID
    clientSecret = config.DINGTALK_CLIENT_SECRET
  }

  // 设置环境变量，供后续模块使用
  process.env.DINGTALK_CLIENT_ID = clientId
  process.env.DINGTALK_CLIENT_SECRET = clientSecret

  // 显示启动信息
  const workDir = process.cwd()
  console.log('')
  console.log('🚀 ClaudeTalk 启动中...')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`📁 工作目录: ${workDir}`)
  console.log(`🔑 AppKey: ${clientId.substring(0, 8)}...`)
  console.log(`📄 配置文件: ${CONFIG_FILE}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')

  // 动态导入并启动 bot
  const { startBot } = await import('./index.js')
  await startBot({
    clientId,
    clientSecret,
    workDir,
  })
}

main().catch((error) => {
  console.error('❌ 启动失败:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
