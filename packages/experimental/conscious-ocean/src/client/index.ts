/** Optional Session-scoped right-Sidebar entry for the Conscious Ocean interface. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-experimental-memory/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { OceanTab } from './OceanTab.tsx'
import { en, NS, zh } from './locales.ts'
import { createConsciousOceanClientSceneBridge, createConsciousOceanClientSceneSource } from './scene-source.ts'
import { createThreeWebGL2RendererFactory } from './scene/renderer-factory.ts'
import type { ConsciousOceanClientSessions } from './scene-source.ts'

export type {
  OceanCameraState,
  OceanRendererBackend,
  OceanRendererCallbacks,
  OceanRendererCapabilities,
  OceanRendererCreateOptions,
  OceanRendererFactory,
  OceanRendererFailure,
  OceanRendererHandle,
  OceanRendererLifecycle,
  OceanRendererSnapshot,
  OceanRendererViewport,
  OceanVisualSettings,
  OceanVector3,
} from './renderer.ts'
export { createThreeWebGL2RendererFactory } from './scene/renderer-factory.ts'
export { createConsciousOceanClientSceneBridge, createConsciousOceanClientSceneSource } from './scene-source.ts'
export type {
  ConsciousOceanClientEventWindow,
  ConsciousOceanClientSceneBridge,
  ConsciousOceanClientSceneSource,
  ConsciousOceanClientSessionBinding,
  ConsciousOceanClientSessions,
} from './scene-source.ts'

declare global {
  interface Window {
    __AEVORA_CONSCIOUS_OCEAN__?: import('./scene-source.ts').ConsciousOceanClientSceneBridge
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Conscious Ocean right-Sidebar copy. */
    consciousOcean: import('./locales.ts').ConsciousOceanKey
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Conscious Ocean's retained Session event-window source. */
    consciousOcean: unknown
  }
}

/** Stable Tab identity for the optional right-Sidebar entry. */
export const CONSCIOUS_OCEAN_TAB_ID = '@deepseek-ai/dsh-experimental-conscious-ocean'

/** Stable navigation kind used by the right-Sidebar registry. */
export const CONSCIOUS_OCEAN_TAB_KIND = 'conscious-ocean'

/** Services required for the optional right-Sidebar registration. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sessions', 'memorySnapshot']

const rendererFactory = createThreeWebGL2RendererFactory()

function hasClientSessionSource(value: object): value is ConsciousOceanClientSessions {
  return 'binding' in value && typeof value.binding === 'function'
    && 'retain' in value && typeof value.retain === 'function'
}

/**
 * Register the localized Session Tab and the right-Sidebar body for this plugin's lifetime.
 * @param ctx - Client plugin context owning the locale and slot registrations.
 */
export function apply(ctx: Context): void {
  const emptySceneSource = {
    getSnapshot: (): undefined => undefined,
    subscribe: (): (() => void) => () => {},
  }
  const sessionService = ctx.get('sessions')
  const sceneSource = sessionService !== undefined && typeof sessionService === 'object' && hasClientSessionSource(sessionService)
    ? createConsciousOceanClientSceneSource(sessionService, ctx.memorySnapshot)
    : undefined
  const sceneBridge = sceneSource === undefined ? undefined : createConsciousOceanClientSceneBridge(sceneSource)
  const previousBridge = typeof window === 'undefined' ? undefined : window.__AEVORA_CONSCIOUS_OCEAN__
  ctx.effect(() => {
    if (sceneBridge !== undefined && typeof window !== 'undefined') window.__AEVORA_CONSCIOUS_OCEAN__ = sceneBridge
    return () => {
      sceneBridge?.dispose()
      sceneSource?.dispose()
      if (typeof window !== 'undefined' && window.__AEVORA_CONSCIOUS_OCEAN__ === sceneBridge) {
        if (previousBridge === undefined) delete window.__AEVORA_CONSCIOUS_OCEAN__
        else window.__AEVORA_CONSCIOUS_OCEAN__ = previousBridge
      }
    }
  }, 'conscious-ocean: scene source and runtime bridge')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'conscious-ocean: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: CONSCIOUS_OCEAN_TAB_ID,
    kind: CONSCIOUS_OCEAN_TAB_KIND,
    title: () => t('tabTitle'),
    guide: [{ id: 'open', order: 40, title: () => t('tabTitle'), description: () => t('guideDescription') }],
  }), 'conscious-ocean: sidebar tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: CONSCIOUS_OCEAN_TAB_ID,
    locale: NS,
    inject: (sessionId: SessionId) => {
      return {
        rendererFactory,
        sessionKey: sessionId,
        hooks: {
          scene: sceneSource?.forSession(sessionId) ?? emptySceneSource,
          world: sceneSource?.world ?? emptySceneSource,
          eventWindow: sceneSource?.eventWindowForSession(sessionId) ?? emptySceneSource,
        },
      }
    },
  }, OceanTab))
}
