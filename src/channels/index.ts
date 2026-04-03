/**
 * Channel 清单 - 唯一需要修改的文件
 * 新增 Channel 时，只需在此处添加一行 export，其余文件无需改动
 */

// 导出触发各 Channel 的自注册（registerChannel 调用在各文件末尾）
export * from './dingtalk/index_dingtalk.js'
export * from './feishu/index_feishu.js'
// 新增 Channel 示例：
// export * from './discord/index_discord.js'
// export * from './wechat/index.js'

// 导出注册表查询 API，供 index.ts 和 cli.ts 使用
export { getChannelDescriptor, getAllChannelDescriptors } from './registry.js'
export type { ChannelDescriptor, ChannelConfigField } from './registry.js'
