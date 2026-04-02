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

// 自动配置文件中的 Agent 配置结构
interface AgentAutoConfig {
  name: string
  description: string
  chinese_name: string
  english_name: string
  prompt: string
}

// agent_auto_config.json 是一个数组，每个元素结构为：
// { "<agent_key>": { name, description, chinese_name, english_name }, "prompt": "..." }
type AutoConfigData = Array<Record<string, AgentAutoConfig | string>>

/**
 * 将数组格式的 AutoConfigData 转换为有序的 AgentAutoConfig 列表
 * 每个数组元素中，除 "prompt" 之外的 key 就是 agent key，对应的值是 agent 元信息
 */
function parseAutoConfigItems(data: AutoConfigData): Array<{ key: string; config: AgentAutoConfig }> {
  return data.map((item) => {
    const agentKey = Object.keys(item).find((k) => k !== 'prompt')!
    const meta = item[agentKey] as AgentAutoConfig
    const prompt = item['prompt'] as string
    return {
      key: agentKey,
      config: { ...meta, prompt },
    }
  })
}

// ========== 工具函数 ==========

// 使用特殊不可见字符标记换行（U+2028 行分隔符）
const LINE_SEPARATOR = '\u2028'

/**
 * 读取单行输入（用于普通字段）
 */
function promptInput(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    readline.question(question, (answer) => {
      readline.close()
      resolve(answer.trim())
    })
  })
}

/**
 * 读取多行输入（仅用于 systemPrompt）
 * 支持粘贴多行内容，用户输入完成后在新的一行单独输入 END 结束输入
 */
function promptMultiLineInput(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  
  return new Promise((resolve) => {
    console.log(question)
    console.log('(输入完成后，在新的一行单独输入 END 结束)')
    const lines: string[] = []
    
    readline.on('line', (line: string) => {
      // 遇到单独一行的 END 标记时结束输入（不使用 trim，必须完全匹配）
      if (line === 'END' && lines.length > 0) {
        readline.close()
        // 将换行符替换为特殊的不可见字符
        const normalized = lines.join('\n').replace(/\n/g, LINE_SEPARATOR).trim()
        resolve(normalized)
      } else {
        lines.push(line)
      }
    })
  })
}

// 将存储的换行符还原为真实的换行符
function restoreLineBreaks(text: string): string {
  return text.replace(new RegExp(LINE_SEPARATOR, 'g'), '\n')
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

// ========== 自动配置向导 ==========

/**
 * 自动配置向导 - 根据 agent_auto_config.json 批量配置多个 Agent
 */
async function autoSetup(workDir: string): Promise<void> {
  const targetFile = join(workDir, LOCAL_CONFIG_FILENAME)
  // 从用户主目录读取自动配置文件
  const userHomeDir = process.env.HOME || process.env.USERPROFILE || ''
  const autoConfigFile = join(userHomeDir, '.claudetalk', 'agent_auto_config.json')

  // 1. 检查 .claudetalk.json 是否已存在
  if (existsSync(targetFile)) {
    console.error('❌ 检测到已存在配置文件: .claudetalk.json')
    console.error(`   绝对路径: ${targetFile}`)
    console.error('   无法执行自动配置。')
    console.error('   如需重新配置，请手动删除 .claudetalk.json 文件。')
    process.exit(1)
  }

  // 2. 检查 agent_auto_config.json 是否存在
  if (!existsSync(autoConfigFile)) {
    console.error('❌ 未找到自动配置文件: .claudetalk/agent_auto_config.json')
    console.error(`   期望路径: ${autoConfigFile}`)
    console.error('   请确保该文件存在于用户主目录的 .claudetalk/ 目录下。')
    process.exit(1)
  }

  // 3. 读取自动配置文件
  let autoConfigData: AutoConfigData
  try {
    const rawContent = readFileSync(autoConfigFile, 'utf-8')
    autoConfigData = JSON.parse(rawContent) as AutoConfigData
  } catch (error) {
    console.error('❌ 读取自动配置文件失败:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  // 4. 解析配置数组
  const agentItems = parseAutoConfigItems(autoConfigData)

  console.log('')
  console.log('🤖 ClaudeTalk 自动配置向导')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`📁 配置文件: ${targetFile}`)
  console.log(`📋 将配置 ${agentItems.length} 个 Agent`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')

  // 5. 按顺序逐个配置 Agent
  const allChannels = getAllChannelDescriptors()
  const updatedConfig: RawConfig = { profiles: {} }

  for (const { key: agentKey, config: agentConfig } of agentItems) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`🎯 现在开始配置: ${agentConfig.chinese_name}`)
    console.log(`   ${agentConfig.english_name} - ${agentConfig.description}`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('')

    // 4.1 输入 profile 名称
    const defaultProfileName = agentConfig.name
    const profileInput = await promptInput(`输入 profile 名称 [${defaultProfileName}]: `)
    const profileName = profileInput.trim() || defaultProfileName

    // 4.2 选择 Channel 类型
    console.log('')
    console.log('📡 消息通道选择:')
    allChannels.forEach((ch, index) => {
      console.log(`   ${index + 1}. ${ch.type.padEnd(10)} - ${ch.label}`)
    })
    let channelType: string
    while (true) {
      const channelInput = await promptInput(`请选择 (1-${allChannels.length}): `)
      const channelIndexInput = parseInt(channelInput, 10)
      if (!isNaN(channelIndexInput) && channelIndexInput >= 1 && channelIndexInput <= allChannels.length) {
        channelType = allChannels[channelIndexInput - 1].type
        break
      } else if (channelInput && getChannelDescriptor(channelInput)) {
        channelType = channelInput
        break
      } else {
        console.error(`❌ 请输入 1 到 ${allChannels.length} 之间的数字，请重新输入`)
      }
    }

    // 4.3 配置 Channel 参数
    const descriptor = getChannelDescriptor(channelType)!
    const channelConfig: Record<string, string> = {}

    console.log('')
    console.log(`🔑 ${descriptor.label}配置`)
    if (descriptor.configFields.some(f => f.hint)) {
      console.log(`   ${descriptor.configFields.find(f => f.hint)?.hint}`)
    }

    for (const field of descriptor.configFields) {
      const prompt = `${field.label}: `
      let inputValue = ''
      while (true) {
        inputValue = await promptInput(prompt)
        if (field.required && !inputValue) {
          console.error(`❌ ${field.label} 不能为空，请重新输入`)
          continue
        }
        break
      }

      if (inputValue) {
        channelConfig[field.key] = inputValue
      }
    }

    // 4.4 询问是否使用默认 prompt
    console.log('')
    const useDefaultPromptInput = await promptInput('是否使用默认 prompt？(Y/n): ')
    const useDefaultPrompt = useDefaultPromptInput.toLowerCase() !== 'n'

    let systemPrompt: string
    if (useDefaultPrompt) {
      // 使用默认 prompt，将换行符替换为特殊字符
      systemPrompt = agentConfig.prompt.replace(/\n/g, LINE_SEPARATOR)
    } else {
      // 自定义 prompt
      console.log(`默认 prompt: ${agentConfig.prompt.substring(0, 100)}...`)
      systemPrompt = await promptMultiLineInput('请输入自定义 prompt: ')
    }

    // 4.5 询问是否配置 SubAgent
    console.log('')
    console.log('🤖 SubAgent 配置（可选）')
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
      await createSubagentFile(profileName, workDir, systemPrompt, subagentModel)
    }

    // 4.6 保存配置
    const profileConfig: ProfileConfig = {
      channel: channelType,
      [channelType]: channelConfig,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(enableSubagent ? { subagentEnabled: true } : {}),
      ...(subagentModel ? { subagentModel } : {}),
    }

    updatedConfig.profiles![profileName] = profileConfig

    console.log('')
    console.log(`✅ [${agentConfig.chinese_name}] 配置完成`)
    console.log('')
  }

  // 5. 保存所有配置
  saveRawConfig(updatedConfig, targetFile)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`✅ 所有 Agent 配置已保存到 ${targetFile}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log('配置完成！运行以下命令启动机器人：')
  console.log(`  claudetalk --profile <profile_name>`)
  console.log('')
  console.log('可用的 profile 名称:')
  Object.keys(updatedConfig.profiles!).forEach(name => {
    console.log(`  - ${name}`)
  })
}

// ========== 编辑已有配置向导 ==========

/**
 * 编辑已有配置 - 列出已有 profile，用户选择后重新配置（支持修改 profile 名称）
 */
async function editSetup(workDir: string): Promise<void> {
  const targetFile = join(workDir, LOCAL_CONFIG_FILENAME)

  // 1. 检查 .claudetalk.json 是否存在
  if (!existsSync(targetFile)) {
    console.error('❌ 未找到配置文件: .claudetalk.json')
    console.error(`   期望路径: ${targetFile}`)
    console.error('   请先运行 claudetalk --setup 或 claudetalk --setup auto 进行初始配置。')
    process.exit(1)
  }

  const existingRaw = loadRawConfig(targetFile)
  const profiles = existingRaw?.profiles ?? {}
  const profileNames = Object.keys(profiles)

  if (profileNames.length === 0) {
    console.error('❌ 配置文件中没有任何 profile，请先运行 claudetalk --setup 进行配置。')
    process.exit(1)
  }

  // 2. 列出已有 profile，让用户选择
  console.log('')
  console.log('✏️  ClaudeTalk 配置编辑')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`📁 配置文件: ${targetFile}`)
  console.log('')
  console.log('已有 profile 列表:')
  profileNames.forEach((name, index) => {
    const profileConfig = profiles[name] as ProfileConfig
    const channel = profileConfig.channel ?? '未知'
    console.log(`   ${index + 1}. ${name.padEnd(20)} (channel: ${channel})`)
  })
  console.log('')

  let selectedProfileName: string
  while (true) {
    const selectionInput = await promptInput(`请选择要编辑的 profile (1-${profileNames.length}): `)
    const selectionIndex = parseInt(selectionInput, 10)
    if (!isNaN(selectionIndex) && selectionIndex >= 1 && selectionIndex <= profileNames.length) {
      selectedProfileName = profileNames[selectionIndex - 1]
      break
    }
    console.error(`❌ 请输入 1 到 ${profileNames.length} 之间的数字，请重新输入`)
  }

  // 3. 询问是否修改 profile 名称
  console.log('')
  console.log(`📝 当前 profile 名称: ${selectedProfileName}`)
  const newProfileNameInput = await promptInput(`新的 profile 名称 [${selectedProfileName}]: `)
  const newProfileName = newProfileNameInput.trim() || selectedProfileName

  // 4. 走完整的交互式配置流程（复用 interactiveSetup 的逻辑）
  await interactiveSetup(workDir, selectedProfileName)

  // 5. 如果 profile 名称有变更，执行重命名
  if (newProfileName !== selectedProfileName) {
    const updatedRaw = loadRawConfig(targetFile)
    if (updatedRaw?.profiles) {
      const oldProfileConfig = updatedRaw.profiles[selectedProfileName]
      if (oldProfileConfig) {
        updatedRaw.profiles[newProfileName] = oldProfileConfig
        delete updatedRaw.profiles[selectedProfileName]
        saveRawConfig(updatedRaw, targetFile)
        console.log(`✅ Profile 已从 [${selectedProfileName}] 重命名为 [${newProfileName}]`)
      }
    }
  }

  console.log('')
  console.log(`✅ Profile [${newProfileName}] 编辑完成！`)
  console.log(`   运行 claudetalk --profile ${newProfileName} 启动机器人。`)
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
  let channelType: string
  while (true) {
    const channelInput = await promptInput(
      existingChannel ? `请选择 (1-${allChannels.length}) [${existingChannel}]: ` : `请选择 (1-${allChannels.length}): `
    )
    const channelIndexInput = parseInt(channelInput, 10)
    if (!isNaN(channelIndexInput) && channelIndexInput >= 1 && channelIndexInput <= allChannels.length) {
      channelType = allChannels[channelIndexInput - 1].type
      break
    } else if (!channelInput && existingChannel) {
      channelType = existingChannel
      break
    } else if (channelInput && getChannelDescriptor(channelInput)) {
      channelType = channelInput
      break
    } else {
      console.error(`❌ 请输入 1 到 ${allChannels.length} 之间的数字，请重新输入`)
    }
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

    let inputValue = ''
    let finalValue = ''
    while (true) {
      inputValue = await promptInput(prompt)
      finalValue = inputValue || existingValue || ''
      if (field.required && !finalValue) {
        console.error(`❌ ${field.label} 不能为空，请重新输入`)
        continue
      }
      break
    }

    if (finalValue) {
      channelConfig[field.key] = finalValue
    }
  }

  // 3. 角色描述（systemPrompt）
  console.log('')
  console.log('📝 角色描述（可选，直接回车跳过）')
  const existingPrompt = existingProfile?.systemPrompt || ''
  
  let systemPrompt: string
  if (existingPrompt) {
    // 如果有现有值，先询问是否修改
    const shouldModify = await promptInput(`是否修改 systemPrompt？(Y/n): `)
    if (shouldModify.toLowerCase() === 'n') {
      systemPrompt = existingPrompt
    } else {
      console.log(`当前值: ${existingPrompt.substring(0, 100)}${existingPrompt.length > 100 ? '...' : ''}`)
      const systemPromptInput = await promptMultiLineInput('systemPrompt: ')
      systemPrompt = systemPromptInput || existingPrompt
    }
  } else {
    const systemPromptInput = await promptMultiLineInput('systemPrompt: ')
    systemPrompt = systemPromptInput || ''
  }

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
  // 将存储的换行符还原为真实的换行符
  const restoredPrompt = systemPrompt ? restoreLineBreaks(systemPrompt) : `你是 ${profileName} 角色，负责相关工作。`
  lines.push(restoredPrompt)

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
  claudetalk --setup                                   配置当前目录默认角色（交互式）
  claudetalk --setup --profile <name>                  配置当前目录指定角色（交互式）
  claudetalk --setup auto                              自动配置多个角色（根据 ~/.claudetalk/agent_auto_config.json）
  claudetalk --setup edit                              编辑已有角色配置（支持修改 profile 名称）
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
    const setupArgIndex = process.argv.indexOf('--setup')
    const setupSubCommand = process.argv[setupArgIndex + 1]

    if (setupSubCommand === 'auto') {
      // --setup auto 模式
      await autoSetup(workDir)
    } else if (setupSubCommand === 'edit') {
      // --setup edit 模式
      await editSetup(workDir)
    } else {
      // --setup 交互式模式
      await interactiveSetup(workDir, profile)
      const resolvedSetupProfile = profile ?? 'default'
      console.log(`配置完成！运行 claudetalk --profile ${resolvedSetupProfile} 启动机器人。`)
    }
    process.exit(0)
  }

  // 指定了 --profile 时，只启动该角色
  if (profile) {
    console.log('')
    console.log('🚀 ClaudeTalk 启动中...')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`📁 工作目录: ${workDir}`)
    console.log(`🎭 角色: ${profile}`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('')
    await startBot({ workDir, profile })
    return
  }

  // 未指定 --profile 时，读取配置文件中所有 profile 并全部启动
  const localConfig = loadRawConfig(join(workDir, LOCAL_CONFIG_FILENAME))
  const profiles = localConfig?.profiles ?? {}
  const profileNames = Object.keys(profiles)

  if (profileNames.length === 0) {
    console.error('❌ 未找到任何 profile 配置，请先运行：')
    console.error('   claudetalk --setup --profile <name>')
    console.error('')
    console.error('运行 claudetalk --help 查看完整用法。')
    process.exit(1)
  }

  console.log('')
  console.log('🚀 ClaudeTalk 启动中...')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`📁 工作目录: ${workDir}`)
  console.log(`🎭 启动所有角色: ${profileNames.join(', ')}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')

  // 并发启动所有 profile，每个 startBot 内部持有独立的 Channel 实例，互不干扰
  await Promise.all(
    profileNames.map((profileName) =>
      startBot({ workDir, profile: profileName }).catch((error) => {
        console.error(`❌ [${profileName}] 启动失败: ${error instanceof Error ? error.message : String(error)}`)
      })
    )
  )
}

main().catch((error) => {
  console.error('❌ 启动失败:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
