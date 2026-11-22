/** Saved search configurations reuse the existing search-provider directory. */
import type { Context } from '@deepseek-ai/cordis'
import { SettingsProviderDirectory, settingsTextField, type SettingsProviderProfiles } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

/**
 * Bind per-provider configuration and explicit execution selection.
 * @param ctx - plugin-owned native forms and credential operations.
 * @returns the saved-provider directory.
 */
export function createSearchProviders(ctx: Context): SettingsProviderDirectory {
  const selection = ctx.configForms.get<{ searchProvider?: string; fetchProvider?: string }>('web')
  const t = ctx.locale.bind('settings.webSearch')
  const endpoint = { ...settingsTextField('endpoint'), label: () => t('providerEndpoint'), hint: () => t('providerEndpointHint'),
    parse: (text: string) => {
      try {
        const url = new URL(text.trim())
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
          ? { kind: 'set' as const, value: text.trim() } : undefined
      } catch (_invalidEndpoint) { return undefined }
    } }
  return new SettingsProviderDirectory({
    families: [
      { id: 'exa', label: 'Exa', scope: ctx.configForms.get<SettingsProviderProfiles>('web-search-exa'),
        defaults: { endpoint: 'https://api.exa.ai' }, fields: [endpoint] },
      { id: 'perplexity', label: 'Perplexity', scope: ctx.configForms.get<SettingsProviderProfiles>('web-search-perplexity'),
        defaults: { endpoint: 'https://api.perplexity.ai', model: 'sonar' },
        fields: [endpoint, { ...settingsTextField('model'), label: () => t('providerModel'), hint: () => t('providerModelHint'),
          parse: text => text.trim() ? { kind: 'set', value: text.trim() } : undefined }] },
      { id: 'tavily', label: 'Tavily', scope: ctx.configForms.get<SettingsProviderProfiles>('web-search-tavily'),
        defaults: { endpoint: 'https://api.tavily.com', searchDepth: 'basic', topic: 'general' },
        fields: [endpoint,
          { ...settingsTextField('searchDepth'), label: () => t('providerSearchDepth'), hint: () => t('providerSearchDepthHint'),
            parse: text => ['basic', 'fast', 'ultra-fast', 'advanced'].includes(text.trim()) ? { kind: 'set', value: text.trim() } : undefined },
          { ...settingsTextField('topic'), label: () => t('providerTopic'), hint: () => t('providerTopicHint'),
            parse: text => ['general', 'news', 'finance'].includes(text.trim()) ? { kind: 'set', value: text.trim() } : undefined },
        ] },
    ], selection, selected: () => selection.getSnapshot().value?.searchProvider ?? '',
    select: id => selection.mutate([{ op: 'set', path: ['searchProvider'], value: id }, { op: 'set', path: ['fetchProvider'], value: 'http' }]),
    fallback: 'deepseek-official', credentialPrefix: 'AEVORA_SEARCH',
    describeKey: async (ref) => {
      const result = await ctx.remote.credentials.describe([ref]); return result.ok ? result.value[ref] : undefined
    },
    writeKey: async (ref, value) => (await ctx.remote.credentials.set(ref, value)).ok,
  })
}

/** Shared page and root-overlay injected operations. */
export interface SearchProvidersFace {
  directory: SettingsProviderDirectory
  hooks: { searchProviders: SettingsProviderDirectory['state']; searchProviderFeedback: SettingsProviderDirectory['feedback'] }
}
