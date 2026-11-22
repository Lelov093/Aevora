/** Aevora character-card Settings page. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ROLE_CARD_NAMESPACE } from '../types.ts'
import { createRoleCardController, type RoleCardInjected } from './controller.ts'
import { en, zh, type AevoraIdentityKey } from './locales.ts'
import { RoleCardPage } from './RoleCardPage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Aevora Identity character-card Settings copy. */
    'settings.aevoraIdentity': AevoraIdentityKey
  }
}

/** Locale namespace owned by this page. */
export const NS = 'settings.aevoraIdentity'

/** Client services needed for the Settings page and its shared form mirror. */
export const inject = ['configForms', 'locale', 'slots']

/** Mount the Aevora character-card page while its Host Settings namespace is served.
 * @param ctx - Client context that owns the shared Settings form and slot services.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'aevora-identity: dictionaries')
  ctx.effect(
    () => ctx.configForms.whileServed(
      [ROLE_CARD_NAMESPACE],
      () => ctx.slots.inject('settings.section', () => {
        const controller = createRoleCardController(ctx)
        const t = ctx.locale.bind(NS)
        const disposeSlot = ctx.slots.register({
          name: 'settings.section', id: 'aevora-identity', order: 10, label: () => t('title'), locale: NS,
          inject: () => controller as RoleCardInjected,
        }, RoleCardPage)
        return () => { disposeSlot(); controller.dispose() }
      }),
    ),
    'aevora-identity: settings page',
  )
}
