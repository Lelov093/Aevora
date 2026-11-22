/**
 * Provider settings over the native web service: the built-in DeepSeek editor
 * and named provider configurations, using native forms and credentials.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { WebSearchCard, SearchProvidersToast } from './WebSearchCard.tsx'
import { createSearchProviders, type SearchProvidersFace } from './providers.ts'
import { WEB_API_NS, WEB_NS, WEB_SEARCH_NS, WebSearchCardController } from './web-search-card-controller.ts'
import { en, ja, es, fr, de, ru, pt, zh, type WebSearchSettingsLocaleKey } from './locales.ts'

export type { WebSearchCardProps } from './WebSearchCard.tsx'
export type {
  WebApiSettings, WebProviderSelection, WebSearchCardFace, WebSearchCardScopes, WebSearchCardState, WebSearchSettings,
} from './web-search-card-controller.ts'
export type { WebSearchSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Web-search settings page copy. */
    'settings.webSearch': WebSearchSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.webSearch'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/**
 * Mount the web-search settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-settings-web-search: dictionaries')
  const card = new WebSearchCardController({
    web: ctx.configForms.get(WEB_NS), messages: ctx.configForms.get(WEB_SEARCH_NS), api: ctx.configForms.get(WEB_API_NS),
  }, ctx)
  const directory = createSearchProviders(ctx)
  const providers: SearchProvidersFace = { directory,
    hooks: { searchProviders: directory.state, searchProviderFeedback: directory.feedback } }
  ctx.effect(() => () => { directory.dispose() }, 'ui-settings-web-search: provider profiles')
  ctx.on('connection/reset', () => { void directory.refresh() })
  ctx.effect(() => () => { card.dispose() }, 'ui-settings-web-search: form subscription')
  // The credential the page reports is not part of any settings section, so
  // no scope publishes when one is written. This is the only signal
  // that a key written on another surface reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { card.refreshCredential(ref); void directory.refresh() }),
    'ui-settings-web-search: credential invalidations',
  )
  ctx.effect(() => ctx.configForms.whileServed([WEB_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'web-search', order: 20, label: () => t('aevora.search.title'), locale: NS,
    inject: () => { const face = card.inject(); return { ...face, ...providers, hooks: { ...face.hooks, ...providers.hooks } } },
  }, WebSearchCard))), 'ui-settings-web-search: page')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'search-provider-feedback', locale: NS, inject: () => providers }, SearchProvidersToast))
}
