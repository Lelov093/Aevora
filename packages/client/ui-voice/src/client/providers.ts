/** User-added voice profiles over native configuration and credential services. */
import type { Context } from '@deepseek-ai/cordis'
import { SettingsProviderDirectory, settingsTextField, settingsNumberField, type SettingsProviderProfiles } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

/**
 * Bind online voice configurations without changing native recognition or saved legacy settings.
 * @param ctx - feature-owned settings and credentials.
 * @returns provider directory owned by this plugin.
 */
export function createVoiceProviders(ctx: Context): SettingsProviderDirectory {
  const scope = ctx.configForms.get<SettingsProviderProfiles>('text-to-speech-qwen')
  const selection = ctx.configForms.get<{ defaultProvider: string }>('text-to-speech')
  const t = ctx.locale.bind('voice')
  const text = (field: 'endpoint' | 'model' | 'voice') => ({ ...settingsTextField(field), label: () => t(field), hint: () => t(`${field}Hint`),
    parse: (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return undefined
      if (field === 'endpoint') {
        try { const url = new URL(trimmed); if (url.protocol !== 'wss:' || url.username || url.password || url.hash) return undefined }
        catch (_invalidEndpoint) { return undefined }
      }
      return { kind: 'set' as const, value: trimmed }
    } })
  return new SettingsProviderDirectory({
    families: [{ id: 'qwen-online', label: 'Qwen', scope,
      defaults: { endpoint: '', model: 'qwen-audio-3.1-tts-flash', voice: 'longanhuan_v3.1', rate: 1 },
      fields: [text('endpoint'), text('model'), text('voice'), { ...settingsNumberField('rate'),
        label: () => t('rate'), hint: () => t('rateHint'), numeric: true,
        parse: value => Number.isFinite(Number(value)) && Number(value) >= 0.5 && Number(value) <= 2
          ? { kind: 'set', value: Number(value) } : undefined }],
    }], selection, selected: () => selection.getSnapshot().value?.defaultProvider ?? '',
    select: id => selection.set('defaultProvider', id), fallback: '', credentialPrefix: 'AEVORA_VOICE',
    describeKey: async (ref) => {
      const result = await ctx.remote.credentials.describe([ref]); return result.ok ? result.value[ref] : undefined
    },
    writeKey: async (ref, value) => (await ctx.remote.credentials.set(ref, value)).ok,
  })
}

/** Settings and root-overlay injected operations. */
export interface VoiceProvidersFace {
  directory: SettingsProviderDirectory
  hooks: { voiceProviders: SettingsProviderDirectory['state']; voiceProviderFeedback: SettingsProviderDirectory['feedback'] }
}
