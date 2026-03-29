/**
 * Channel 注册表
 * 每个 Channel 实现文件末尾调用 registerChannel 完成自注册
 * 新增 Channel 只需在 src/channels/index.ts 中 export 对应文件即可
 */

import type { Channel } from '../types.js'

/** Channel 配置字段定义，用于 CLI 配置向导自动生成引导 */
export interface ChannelConfigField {
  /** 配置 key，对应 ProfileConfig 中该 Channel 配置对象的字段名 */
  key: string
  /** 显示给用户的字段名称 */
  label: string
  /** 是否必填 */
  required: boolean
  /** 是否为密钥（显示时打码） */
  secret?: boolean
  /** 可选的帮助说明 */
  hint?: string
}

/** Channel 描述符，每个 Channel 实现文件通过 registerChannel 注册 */
export interface ChannelDescriptor {
  /** Channel 类型标识，对应配置文件中的 channel 字段值 */
  type: string
  /** 显示名称，用于 CLI 选项列表 */
  label: string
  /** 配置字段定义，CLI 向导按此列表逐个引导用户输入 */
  configFields: ChannelConfigField[]
  /** 工厂方法，根据配置创建 Channel 实例 */
  create(config: Record<string, string>): Channel
}

const channelRegistry = new Map<string, ChannelDescriptor>()

/** 注册一个 Channel 实现 */
export function registerChannel(descriptor: ChannelDescriptor): void {
  channelRegistry.set(descriptor.type, descriptor)
}

/** 根据类型获取 Channel 描述符 */
export function getChannelDescriptor(type: string): ChannelDescriptor | undefined {
  return channelRegistry.get(type)
}

/** 获取所有已注册的 Channel 列表（按注册顺序） */
export function getAllChannelDescriptors(): ChannelDescriptor[] {
  return [...channelRegistry.values()]
}
