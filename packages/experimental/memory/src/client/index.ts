/** Global Memory management page backed by the optional Host Memory Remote. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-experimental-memory/remote'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-experimental-memory/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createMemoryRemoteController, type MemoryRemoteController } from './controller.ts'
import { MemoryPage, type MemoryPageInjected } from './MemoryPage.tsx'
import { MemoryPanelIcon } from './MemoryPanelIcon.tsx'
import { en, NS, zh, type MemoryKey } from './locales.ts'

export type { MemoryRemoteController } from './controller.ts'

/** Read-only reactive Memory face exposed to optional visual consumers. */
export type MemoryClientSnapshotSource = MemoryRemoteController['snapshot']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client-side snapshot of the Host-owned Memory Remote. */
    memorySnapshot: MemoryClientSnapshotSource
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Global Memory management page copy. */
    memory: MemoryKey
  }
}

/** Stable root-scoped panel identity. */
const PANEL_ID = 'memory' as MainPanelId

/** Services required for the global panel registration and Host Remote mount. */
export const inject = ['remote', 'slots', 'locale']

/** Register the Host-backed Memory management page and its global navigation entry. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(remote)
  let releaseSnapshot: (() => void) | undefined
  const ui = ctx.inject(['remote.memory', 'slots', 'locale'], async (child) => {
    const controller = createMemoryRemoteController(child.remote.memory)
    await controller.load()
    releaseSnapshot = ctx.provide('memorySnapshot', controller.snapshot)
    child.effect(() => () => { controller.dispose() }, 'memory: remote controller')
    child.effect(() => child.locale.register(NS, { en, zh }), 'memory: dictionaries')
    const t = child.locale.bind(NS)
    const injected: MemoryPageInjected = {
      hooks: controller.hooks,
      update: controller.update,
      createConfirmed: controller.createConfirmed,
      forget: controller.forget,
      recall: controller.recall,
      setPinned: controller.setPinned,
      delete: controller.delete,
    }
    child.slots.inject('main', () => child.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: () => injected,
    }, MemoryPage))
    child.slots.inject('sidebar.panellist', () => child.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      locale: NS,
      label: () => t('panel'),
    }, MemoryPanelIcon))
  })
  try {
    await ui
  } catch (error) {
    await unmountRemote()
    throw error
  }
  return async () => { await ui.dispose(); releaseSnapshot?.(); await unmountRemote() }
}
