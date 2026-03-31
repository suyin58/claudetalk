#!/usr/bin/env node
/**
 * ClaudeTalk CLI - 多 Channel 机器人接入 Claude Code
 * 通过 claudetalk 命令启动，自动管理配置文件
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import { getAllChannelDescriptors, getChannelDescriptor } from './channels/index.js'
import { startBot } from './index.js'
import type { ProfileConfig } from './types.js'

// ========== 配置文件路径 ==========
const LOCAL_CONFIG_FILENAME = '.claudetalk.json'

// ========== 配置类型 ==========

interface RawConfig {
  profiles?: Record<string, ProfileConfig>
}

// ========== 工具函数 ==========

function promptInput(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    readline.question(question, (answer) => {
      readline.close()
      resolve(answer.trim())
    })
  })
}

function loadRawConfig(filePath: string): RawConfig | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as RawConfig
  } catch {
    return null
  }
}

function saveRawConfig(config: RawConfig, filePath: string): void {
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

function parseProfileArg(): string | undefined {
  const index = process.argv.indexOf('--profile')
  if (index !== -1) {
    const next = process.argv[index + 1]
    if (next && !next.startsWith('--')) return next
  }
  return undefined
}

// ========== 交互式配置向导 ==========

async function interactiveSetup(workDir: string, profile?: string): Promise<void> {
  const targetFile = join(workDir, LOCAL_CONFIG_FILENAME)

  // 没有指定 profile 时使用 "default" 作为默认角色名
  const resolvedProfile = profile ?? 'default'

  const existingRaw = loadRawConfig(targetFile)
  const existingProfile = existingRaw?.profiles?.[resolvedProfile]

  console.log('')
  console.log('🤖 ClaudeTalk 配置向导')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`🎭 角色: ${resolvedProfile}`)
  console.log(`📁 配置文件: ${targetFile}`)
  console.log('')

  // 1. 选择 Channel 类型（从注册表动态生成选项）
  const allChannels = getAllChannelDescriptors()
  const existingChannel = existingProfile?.channel as string | undefined
  console.log('📡 消息通道选择:')
  allChannels.forEach((ch, index) => {
    console.log(`   ${index + 1}. ${ch.type.padEnd(10)} - ${ch.label}`)
  })
  const channelInput = await promptInput(
    existingChannel ? `请选择 (1-${allChannels.length}) [${existingChannel}]: ` : `请选择 (1-${allChannels.length}): `
  )
  let channelType: string
  const channelIndexInput = parseInt(channelInput, 10)
  if (!isNaN(channelIndexInput) && channelIndexInput >= 1 && channelIndexInput <= allChannels.length) {
    channelType = allChannels[channelIndexInput - 1].type
  } else if (!channelInput && existingChannel) {
    channelType = existingChannel
  } else if (channelInput && getChannelDescriptor(channelInput)) {
    channelType = channelInput
  } else {
    console.error(`❌ 请输入 1 到 ${allChannels.length} 之间的数字`)
    process.exit(1)
  }

  // 2. 根据 Channel 类型引导配置（从注册表 configFields 动态生成）
  const descriptor = getChannelDescriptor(channelType)!
  const existingChannelConfig = (existingProfile?.[channelType] ?? {}) as Record<string, string>
  const channelConfig: Record<string, string> = {}

  console.log('')
  console.log(`🔑 ${descriptor.label}配置`)
  if (descriptor.configFields.some(f => f.hint)) {
    console.log(`   ${descriptor.configFields.find(f => f.hint)?.hint}`)
  }

  for (const field of descriptor.configFields) {
    const existingValue = existingChannelConfig[field.key]
    let prompt: string
    if (existingValue) {
      const displayValue = field.secret
        ? `${existingValue.substring(0, 4)}****`
        : existingValue
      prompt = `${field.label} [${displayValue}]: `
    } else {
      prompt = `${field.label}: `
    }

    const inputValue = await promptInput(prompt)
    const finalValue = inputValue || existingValue || ''

    if (field.required && !finalValue) {
      console.error(`❌ ${field.label} 不能为空`)
      process.exit(1)
    }

    if (finalValue) {
      channelConfig[field.key] = finalValue
    }
  }

  // 3. 角色描述（systemPrompt）
  console.log('')
  console.log('📝 角色描述（可选，直接回车跳过）')
  const existingPrompt = existingProfile?.systemPrompt || ''
  const systemPromptInput = await promptInput(
    existingPrompt
      ? `systemPrompt [${existingPrompt.substring(0, 40)}${existingPrompt.length > 40 ? '...' : ''}]: `
      : 'systemPrompt: '
  )
  const systemPrompt = systemPromptInput === ' ' ? '' : (systemPromptInput || existingPrompt)

  // 4. SubAgent 配置
  console.log('')
  console.log('🤖 SubAgent 配置（可选）')
  console.log('   SubAgent 是 Claude Code 的原生角色机制，可以提供更精细的权限控制和模型选择。')
  const enableSubagentInput = await promptInput('是否配置 SubAgent？(Y/n): ')
  const enableSubagent = enableSubagentInput.toLowerCase() !== 'n'

  let subagentModel: string | undefined
  if (enableSubagent) {
    console.log('')
    console.log('  📦 模型选择（直接回车使用 Claude Code 默认模型）：')
    console.log('     1. claude-opus-4-5    - 最强推理（较慢，费用高）')
    console.log('     2. claude-sonnet-4-5  - 均衡性能（推荐）')
    console.log('     3. claude-haiku-4-5   - 速度最快（费用低）')
    console.log('     4. 手动输入其他模型名称')
    const modelChoice = await promptInput('  请输入选项 (1-4，直接回车使用默认): ')
    switch (modelChoice.trim()) {
      case '1': subagentModel = 'claude-opus-4-5'; break
      case '2': subagentModel = 'claude-sonnet-4-5'; break
      case '3': subagentModel = 'claude-haiku-4-5'; break
      case '4': {
        const customModel = await promptInput('  请输入模型名称: ')
        subagentModel = customModel.trim() || undefined
        break
      }
    }

    // 自动创建 SubAgent 文件
    await createSubagentFile(resolvedProfile, workDir, systemPrompt, subagentModel)
  }

  // 5. 保存配置
  const profileConfig: ProfileConfig = {
    channel: channelType,
    [channelType]: channelConfig,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(enableSubagent ? { subagentEnabled: true } : {}),
    ...(subagentModel ? { subagentModel } : {}),
  }

  const updatedConfig: RawConfig = {
    ...existingRaw,
    profiles: {
      ...(existingRaw?.profiles ?? {}),
      [resolvedProfile]: profileConfig,
    },
  }

  saveRawConfig(updatedConfig, targetFile)
  console.log('')
  console.log(`✅ 角色 [${resolvedProfile}] 配置已保存到 ${targetFile}`)
}

/**
 * 创建 SubAgent 配置文件
 */
async function createSubagentFile(
  profileName: string,
  workDir: string,
  systemPrompt?: string,
  model?: string
): Promise<void> {
  // SubAgent 文件放在工作目录的 .claude/agents 下
  // 符合 Claude Code 的标准 SubAgent 目录结构
  // 每个项目可以有独立的 SubAgent 配置，与 profile 配置保持一致
  const agentsDir = join(workDir, '.claude', 'agents')
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true })

  const agentFile = join(agentsDir, `${profileName}.md`)
  const lines: string[] = ['---']
  lines.push(`name: "${profileName}"`)
  lines.push(`description: "ClaudeTalk 角色: ${profileName}"`)
  if (model) lines.push(`model: "${model}"`)
  lines.push('---')
  lines.push('')
  lines.push(systemPrompt ?? `你是 ${profileName} 角色，负责相关工作。`)

  writeFileSync(agentFile, lines.join('\n') + '\n', 'utf-8')
  console.log(`✅ SubAgent 文件已创建: ${agentFile}`)
}

// ========== 主流程 ==========

async function main(): Promise<void> {
  const workDir = process.cwd()
  const profile = parseProfileArg()

  // --help
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
ClaudeTalk - 通过钉钉/Discord 机器人与 Claude Code 对话

用法:
  claudetalk                                           启动机器人（使用默认角色）
  claudetalk --profile <name>                          启动指定角色机器人
  claudetalk --setup                                   配置当前目录默认角色
  claudetalk --setup --profile <name>                  配置当前目录指定角色
  claudetalk --help                                    显示帮助信息

默认角色规则:
  - 不指定 --profile 时，优先使用名为 "default" 的角色
  - 如果没有 "default" 角色，但配置中只有一个角色，则自动使用该角色
  - 如果有多个角色且没有 "default"，则必须通过 --profile 指定

配置文件示例 (.claudetalk.json):
  {
    "profiles": {
      "default": {
        "channel": "dingtalk",
        "dingtalk": {
          "DINGTALK_CLIENT_ID": "xxx",
          "DINGTALK_CLIENT_SECRET": "xxx"
        },
        "systemPrompt": "你是产品经理，负责需求分析",
        "subagentEnabled": true
      },
      "dev": {
        "channel": "discord",
        "discord": {
          "TOKEN": "xxx"
        },
        "systemPrompt": "你是全栈工程师，擅长 SQL 编写",
        "subagentEnabled": true
      }
    }
  }

配置文件:
  .claudetalk.json              当前工作目录
`)
    process.exit(0)
  }

  // --setup
  if (process.argv.includes('--setup')) {
    await interactiveSetup(workDir, profile)
    const resolvedSetupProfile = profile ?? 'default'
    console.log(`配置完成！运行 claudetalk --profile ${resolvedSetupProfile} 启动机器人。`)
    process.exit(0)
  }

  // 没有指定 profile 时，自动从配置中推断：优先 "default"，其次唯一角色
  let resolvedProfile = profile
  if (!resolvedProfile) {
    const localConfig = loadRawConfig(join(workDir, LOCAL_CONFIG_FILENAME))
    const profiles = localConfig?.profiles ?? {}
    const profileNames = Object.keys(profiles)

    if (profileNames.includes('default')) {
      resolvedProfile = 'default'
    } else if (profileNames.length === 1) {
      resolvedProfile = profileNames[0]
      console.log(`ℹ️  自动使用角色: ${resolvedProfile}`)
    } else if (profileNames.length > 1) {
      console.error('❌ 存在多个角色，请通过 --profile <name> 指定，例如：')
      console.error(`   claudetalk --profile ${profileNames[0]}`)
      console.error('')
      console.error(`可用角色: ${profileNames.join(', ')}`)
      process.exit(1)
    } else {
      console.error('❌ 未找到任何配置，请先运行：')
      console.error('   claudetalk --setup --profile <name>')
      console.error('')
      console.error('运行 claudetalk --help 查看完整用法。')
      process.exit(1)
    }
  }

  // 启动 Bot
  console.log('')
  console.log('🚀 ClaudeTalk 启动中...')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`📁 工作目录: ${workDir}`)
  console.log(`🎭 角色: ${resolvedProfile}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')

  await startBot({ workDir, profile: resolvedProfile })
}

main().catch((error) => {
  console.error('❌ 启动失败:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
