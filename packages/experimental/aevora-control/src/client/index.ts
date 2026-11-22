/** Browser entry for the Aevora-specific Plugins page tab. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AevoraPluginsTab } from './AevoraPluginsTab.tsx'
import { AevoraControlController } from './controller.ts'
import { en, zh, type AevoraControlKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Aevora Plugins tab copy. */
    'settings.aevoraControl': AevoraControlKey
  }
}

/** Locale namespace owned by the Aevora Plugins tab. */
export const NS = 'settings.aevoraControl'

/** Services required by the existing Plugins page and its Remote control. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager', 'remoteAccess']

/** Register the Aevora tab while DSH exposes profile plugin management. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'aevora-control: dictionaries')
  const controller = new AevoraControlController(ctx)
  const t = ctx.locale.bind(NS)
  ctx.effect(() => () => { controller.dispose() }, 'aevora-control: controller')
  ctx.remoteAccess.whenAccess('pluginManager/listBundles', function* () {
    const stop = controller.start()
    yield ctx.slots.inject('plugins.tab', () => ctx.slots.register({
      name: 'plugins.tab', id: 'aevora', order: 5, label: () => t('tab'), locale: NS,
      inject: () => controller.face(),
    }, AevoraPluginsTab))
    yield () => { stop() }
  })
}
