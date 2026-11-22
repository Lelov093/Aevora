/** Localized copy for the Aevora Plugins tab. */

/** Keys used by the Aevora Plugins tab. */
export type AevoraControlKey =
  | 'tab' | 'title' | 'description' | 'refresh' | 'loading' | 'error' | 'unavailable'
  | 'enabled' | 'disabled' | 'running' | 'stopped' | 'failed' | 'unavailableFeature'
  | 'toggle' | 'identityTitle' | 'identityDescription' | 'memoryTitle' | 'memoryDescription'
  | 'consciousTitle' | 'consciousDescription'

/** English copy. */
export const en: Record<AevoraControlKey, string> = {
  tab: 'Aevora',
  title: 'Aevora capabilities',
  description: 'Choose which Aevora capabilities are active in this app.',
  refresh: 'Refresh',
  loading: 'Reading Aevora capabilities…',
  error: 'Aevora capabilities are temporarily unavailable.',
  unavailable: 'This Aevora build does not expose plugin controls.',
  enabled: 'Enabled', disabled: 'Disabled', running: 'Running', stopped: 'Stopped', failed: 'Failed',
  unavailableFeature: 'Not loaded in this Profile', toggle: 'Enable {name}',
  identityTitle: 'Identity and role card',
  identityDescription: 'Edit Aevora’s stable identity and role card.',
  memoryTitle: 'Memory',
  memoryDescription: 'Store and recall Aevora memory through the existing Memory service.',
  consciousTitle: 'Conscious Space',
  consciousDescription: 'Open the Aevora projection surface for memory and activation context.',
}

/** Simplified Chinese copy. */
export const zh: Record<AevoraControlKey, string> = {
  tab: 'Aevora',
  title: 'Aevora 能力',
  description: '选择当前应用中启用的 Aevora 能力。',
  refresh: '刷新',
  loading: '正在读取 Aevora 能力…',
  error: '暂时无法读取 Aevora 能力。',
  unavailable: '当前 Aevora 构建没有提供插件控制。',
  enabled: '已启用', disabled: '已停用', running: '运行中', stopped: '已停止', failed: '启动失败',
  unavailableFeature: '当前 Profile 未加载', toggle: '启用 {name}',
  identityTitle: 'Identity 与角色卡',
  identityDescription: '编辑 Aevora 的稳定身份和角色卡。',
  memoryTitle: 'Memory',
  memoryDescription: '通过现有 Memory 服务保存和召回 Aevora 记忆。',
  consciousTitle: '意识空间',
  consciousDescription: '打开 Aevora 的记忆与激活上下文 Projection 空间。',
}
