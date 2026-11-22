/** Feature-registered provider controls and their locale reader. */
/** English copy registered by the owning feature's locale namespace. */
export const providerSettingsEn = {
  'providers.add': 'Add provider', 'providers.edit': 'Edit', 'providers.remove': 'Delete', 'providers.cancel': 'Cancel',
  'providers.select': 'Use by default', 'providers.selected': 'Default', 'providers.builtin': 'Built in',
  'providers.name': 'Name', 'providers.nameHint': 'A name for this configuration.',
  'providers.key': 'API key', 'providers.keyHint': 'Leave blank to keep the saved key. Saving makes no service request.',
  'providers.configured': 'Key configured; connection not tested', 'providers.missing': 'No key configured',
  'providers.unknown': 'Credential status unavailable', 'providers.adapter': 'Provider',
  'providers.choose': 'Choose a provider', 'providers.configure': 'Configure',
  'providers.save': 'Save', 'providers.saving': 'Saving…', 'providers.saveFailed': 'Settings were not saved. Check the fields and connection.',
  'providers.unavailable': 'This provider is unavailable.', 'providers.readOnly': 'These settings are read-only.',
  'providers.invalid': 'Enter a valid value.', 'providers.reset': 'Reset', 'providers.overridden': 'Overridden',
  'providers.removeTitle': 'Delete this provider?', 'providers.removeHint': 'Only this configuration is removed. Its saved key is retained.',
  'providers.saved': 'Provider saved', 'providers.removed': 'Provider deleted', 'providers.chosen': 'Default provider updated',
  'providers.failed': 'The change was not completed. Check the settings and connection.',
} as const

/** Copy keys the feature must register. */
export type SettingsProviderCopyKey = keyof typeof providerSettingsEn
/** Complete localized provider controls. */
export type SettingsProviderLabels = Record<SettingsProviderCopyKey, string>

/**
 * Read provider control copy from the feature's active locale.
 * @param t - feature-owned locale reader.
 * @returns the complete labels for this render.
 */
export function settingsProviderLabels(t: (key: SettingsProviderCopyKey) => string): SettingsProviderLabels {
  return Object.fromEntries(Object.keys(providerSettingsEn).map(key => [key, t(key as SettingsProviderCopyKey)])) as SettingsProviderLabels
}

/** Simplified Chinese provider controls. */
export const providerSettingsZh: SettingsProviderLabels = {
  'providers.add': '添加提供商', 'providers.edit': '编辑', 'providers.remove': '删除', 'providers.cancel': '取消',
  'providers.select': '设为默认', 'providers.selected': '默认', 'providers.builtin': '内置',
  'providers.name': '名称', 'providers.nameHint': '为这份配置起一个便于识别的名称',
  'providers.key': 'API Key', 'providers.keyHint': '留空保留已保存的密钥，保存不会调用服务',
  'providers.configured': '密钥已配置，连接未验证', 'providers.missing': '尚未配置密钥', 'providers.unknown': '密钥状态暂不可用',
  'providers.adapter': '提供商', 'providers.save': '保存', 'providers.saving': '保存中…',
  'providers.choose': '选择提供商', 'providers.configure': '配置',
  'providers.saveFailed': '设置未保存，请检查输入与连接', 'providers.unavailable': '该提供商暂不可用',
  'providers.readOnly': '当前设置为只读', 'providers.invalid': '请输入有效值', 'providers.reset': '恢复默认', 'providers.overridden': '已覆盖',
  'providers.removeTitle': '删除这份提供商配置？', 'providers.removeHint': '仅删除这份配置，保留已保存的密钥',
  'providers.saved': '提供商已保存', 'providers.removed': '提供商已删除', 'providers.chosen': '默认提供商已更新',
  'providers.failed': '操作未完成，请检查设置与连接',
}
