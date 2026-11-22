/** Locale bundles for the Aevora character-card Settings page. */

/** Keys rendered by the character-card page. */
export type AevoraIdentityKey =
  | 'title' | 'description' | 'displayName' | 'displayNameHint' | 'identity' | 'identityHint'
  | 'personality' | 'personalityHint' | 'values' | 'valuesHint' | 'relationship' | 'relationshipHint'
  | 'expression' | 'expressionHint' | 'boundaries' | 'boundariesHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable' | 'save' | 'saving' | 'saveFailed'
  | 'active' | 'draft' | 'version' | 'history' | 'preview' | 'previewHint' | 'rollback' | 'deletionScope'

/** English copy. */
export const en: Record<AevoraIdentityKey, string> = {
  title: 'Aevora role card',
  description: 'Edit the stable character card that gives Aevora a consistent identity.',
  displayName: 'Name', displayNameHint: 'The name Aevora uses in its stable identity.',
  identity: 'Identity', identityHint: 'The enduring identity description. Keep temporary mood and task state elsewhere.',
  personality: 'Personality', personalityHint: 'Stable traits, temperament, and judgment tendencies.',
  values: 'Values', valuesHint: 'Principles that guide decisions and conversation.',
  relationship: 'Relationship', relationshipHint: 'How Aevora understands its relationship with the user.',
  expression: 'Expression', expressionHint: 'Language, tone, detail, and conversational style.',
  boundaries: 'Boundaries', boundariesHint: 'Behaviors Aevora must avoid or confirm before taking.',
  overridden: 'Overridden', reset: 'Reset to default', readOnly: 'This deployment stores settings read-only.',
  unavailable: 'The Aevora Identity plugin is not loaded, so it cannot be configured right now.',
  save: 'Save', saving: 'Saving…', saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  active: 'Active', draft: 'Draft', version: 'Version', history: 'Previous versions',
  preview: 'Prompt preview', previewHint: 'Unsaved text appears here for review and stays out of model requests until you save.',
  rollback: 'Restore this version', deletionScope: 'The active card is deployment-scoped. Session snapshots keep the version captured when each Session was created.',
}

/** Simplified Chinese copy. */
export const zh: Record<AevoraIdentityKey, string> = {
  title: 'Aevora 角色卡',
  description: '编辑用于保持 Aevora 身份连续性的稳定角色卡。',
  displayName: '名称', displayNameHint: 'Aevora 稳定身份中使用的名称。',
  identity: '身份', identityHint: '长期身份描述。临时情绪和任务状态应保存在其他位置。',
  personality: '性格', personalityHint: '稳定性格、气质和判断倾向。',
  values: '价值观', valuesHint: '指导判断、行动和交流的原则。',
  relationship: '关系', relationshipHint: 'Aevora 如何理解自己与用户的关系。',
  expression: '表达方式', expressionHint: '语言、语气、详细程度和交流风格。',
  boundaries: '边界', boundariesHint: 'Aevora 必须避免或先确认的行为。',
  overridden: '已覆盖', reset: '恢复默认', readOnly: '本部署的设置为只读。',
  unavailable: 'Aevora Identity 插件当前未加载，暂时无法配置。',
  save: '保存', saving: '保存中…', saveFailed: '本部署没有接受这些值，已保留供你修改。',
  active: '当前生效', draft: '草稿', version: '版本', history: '历史版本',
  preview: '提示词预览', previewHint: '未保存的文字会显示在这里供检查，保存前不会进入模型请求。',
  rollback: '恢复此版本', deletionScope: '当前生效角色卡属于部署级设置。每个 Session 的快照保留其创建时捕获的版本。',
}

/** Labels used by the shared settings form frame.
 * @param t - page-owned locale lookup.
 * @returns localized labels for the shared form frame.
 */
export function formLabels(t: (key: AevoraIdentityKey) => string): {
  unavailable: string
  readOnly: string
  saveFailed: string
  save: string
  saving: string
} {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
