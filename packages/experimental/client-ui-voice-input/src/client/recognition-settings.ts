/** Online ASR cards over the native profile editor and independent credential references. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-voice/client'
import { SettingsProviderDirectory, settingsTextField, type SettingsProviderProfiles } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { NS } from './locales.ts'

/** Create a directory without preparing models, acquiring a microphone, or calling ASR.
 * @param ctx - optional voice input plugin lifetime.
 * @returns native settings directory; caller owns disposal.
 */
export function createRecognitionSettings(ctx: Context): SettingsProviderDirectory {
  const selection = ctx.configForms.get<{ defaultProvider: string }>('speech-to-text')
  const scope = ctx.configForms.get<SettingsProviderProfiles>('speech-to-text-qwen')
  const t = ctx.locale.bind(NS)
  return new SettingsProviderDirectory({ families: [{ id: 'qwen-asr', label: 'Qwen', scope,
    defaults: { endpoint: '', model: 'qwen-audio-3.1-asr-flash-streaming' },
    fields: (['endpoint', 'model'] as const).map(field => ({ ...settingsTextField(field), label: () => t(`asr.${field}`), hint: () => t(`asr.${field}Hint`),
      parse: (text) => {
        const value = text.trim()
        if (!value) return undefined
        if (field === 'endpoint') {
          try { const url = new URL(value); if (url.protocol !== 'wss:' || url.username || url.password || url.hash) return undefined }
          catch (_invalidEndpoint) { return undefined }
        }
        return { kind: 'set' as const, value }
      } })),
  }], selection, selected: () => selection.getSnapshot().value?.defaultProvider ?? '',
  select: async id => (await ctx.remote.speech.configure({ providerId: id as SpeechProviderId, language: 'auto' })).ok,
  fallback: 'sensevoice-local', credentialPrefix: 'AEVORA_ASR',
  describeKey: async (ref) => {
    const result = await ctx.remote.credentials.describe([ref]); return result.ok ? result.value[ref] : undefined
  },
  writeKey: async (ref, value) => (await ctx.remote.credentials.set(ref, value)).ok,
  })
}

/** Native ASR form observations and plain directory callbacks. */
export interface RecognitionSettingsFace {
  recognitionDirectory: SettingsProviderDirectory
  hooks: { recognitionProfiles: SettingsProviderDirectory['state']; recognitionFeedback: SettingsProviderDirectory['feedback'] }
}
