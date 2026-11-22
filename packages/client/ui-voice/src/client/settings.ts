/** Staged native settings form and write-only credential control. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SettingsFormModel, settingsTextField, settingsNumberField } from '@deepseek-ai/dsh-client-ui-primitives'

/** Editable provider settings; secrets are stored by the credential domain. */
export interface VoiceSettings { endpoint: string; model: string; voice: string; rate: number; apiKeyEnv: string }

/** Owns form subscriptions and credential presence; never reads secret values. */
export class VoiceSettingsController {
  private readonly scope
  private readonly form
  private readonly credential = createSnapshotStore({ configured: false, writable: false, known: false })
  private disposed = false
  private revision = 0
  private reference: string | undefined
  private readonly off
  /** Native slot actions and observable form data. */
  readonly face

  constructor(private readonly ctx: Context) {
    this.scope = ctx.configForms.get<VoiceSettings>('text-to-speech-qwen')
    const endpoint = settingsTextField('endpoint')
    this.form = new SettingsFormModel(this.scope, [
      { ...endpoint, parse: (text) => {
        if (text.trim() === '') return { kind: 'clear' }
        try { const url = new URL(text); return url.protocol === 'wss:' && !url.username && !url.password && !url.hash
          ? { kind: 'set', value: text.trim() } : undefined } catch (_invalidUrl) { return undefined }
      } },
      settingsTextField('model'), settingsTextField('voice'),
      { ...settingsNumberField('rate'), parse: (text) => {
        if (text.trim() === '') return { kind: 'clear' }
        const value = Number(text)
        return Number.isFinite(value) && value >= 0.5 && value <= 2 ? { kind: 'set', value } : undefined
      } },
    ], [{ field: 'apiKey', write: async (text) => {
      const ref = this.scope.getSnapshot().value?.apiKeyEnv
      if (!ref) return false
      const result = await ctx.remote.credentials.set(ref, text)
      await this.refresh()
      return result.ok
    } }])
    this.off = this.scope.subscribe(() => { void this.refresh() })
    this.face = { ...this.form.actions(), hooks: { voiceForm: this.form.bind(() => ({ ...this.form.shell(),
      endpoint: this.form.field('endpoint'), model: this.form.field('model'), voice: this.form.field('voice'),
      rate: this.form.field('rate'), apiKey: this.form.field('apiKey') })), voiceCredential: this.credential },
    openRecognition: () => { ctx.get('pluginNavigation')?.openBundle('@deepseek-ai/dsh-experimental-voice-input-bundle') } }
    void this.refresh()
  }

  /** Refresh presence after native credential updates or reconnects. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    const revision = ++this.revision
    const ref = this.scope.getSnapshot().value?.apiKeyEnv
    if (ref !== this.reference) {
      this.reference = ref
      this.credential.set({ configured: false, writable: false, known: false })
    }
    if (!ref) return
    try {
      const result = await this.ctx.remote.credentials.describe([ref])
      if (revision !== this.revision) return
      const value = result.ok ? result.value[ref] : undefined
      this.credential.set({ configured: value?.configured ?? false, writable: value?.writable ?? false, known: value !== undefined })
    } catch (_unavailableCredentials) {
      if (revision === this.revision) this.credential.set({ configured: false, writable: false, known: false })
    }
  }

  /** Stop form observation and invalidate pending presence reads. */
  dispose(): void { this.disposed = true; ++this.revision; this.off(); this.form.dispose() }
}

/** Plain injected settings data and callbacks. */
export type VoiceSettingsFace = VoiceSettingsController['face']
