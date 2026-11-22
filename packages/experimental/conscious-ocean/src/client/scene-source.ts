/** Client adapter from one live Session event window to a read-only scene source. */

import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CognitiveWorldSnapshot } from '../types.ts'
import type { MemoryClientSnapshotSource } from '@deepseek-ai/dsh-experimental-memory/client'
import type { OceanSceneProjection } from '../scene-projection.ts'
import { buildMemoryCognitiveWorld } from '../memory-world.ts'
import { loadSessionSceneProjection } from '../session-scene-loader.ts'
import {
  createSessionProjectionProvider,
  createSessionSceneProjectionOwner,
  createTraceProjectionProvider,
  type ReadonlySnapshotSource,
} from '../provider.ts'

/** The durable entry branch exposed by the Client Session event window. */
interface ClientEventEntry {
  readonly type: 'event'
  readonly event: SessionEvent
}

interface ClientTransientEntry {
  readonly type: 'transient'
  readonly event: object
}

/** Minimal Client Session binding needed by the scene adapter. */
export interface ConsciousOceanClientSessionBinding {
  readonly eventSource: ReadonlySnapshotSource<SessionEventWindow>
}

/** The complete read-only event window paired with one selected Session. */
export type ConsciousOceanClientEventWindow = SessionEventWindow

/** Existing Client Session reference retained by the scene source owner. */
export interface ConsciousOceanClientSessionReference {
  readonly binding: ConsciousOceanClientSessionBinding
  readonly ready: Promise<ConsciousOceanClientSessionBinding>
  readonly release: () => void
}

/** Session lookup owned by the existing DSH Client Session Controller. */
export interface ConsciousOceanClientSessions {
  /** @param sessionId - Session identity to borrow without retaining it. @returns live binding, if present. */
  readonly binding: (sessionId: SessionId) => ConsciousOceanClientSessionBinding | undefined
  /**
   * @param sessionId - Session identity to retain for event-window hydration.
   * @param options - source label owned by this plugin.
   * @returns retained binding and readiness promise.
   */
  readonly retain: (sessionId: SessionId, options: { readonly source: 'consciousOcean' }) => ConsciousOceanClientSessionReference
}

/** Session-scoped read source consumed by the existing `hooks.scene` slot face. */
export interface ConsciousOceanClientSceneSource {
  /** @param sessionId - Session identity rendered by the slot. @returns stable scene source for that Session. */
  readonly forSession: (sessionId: SessionId) => ReadonlySnapshotSource<OceanSceneProjection | undefined>
  /** @param sessionId - Session identity whose current contiguous event window is read. */
  readonly eventWindowForSession: (sessionId: SessionId) => ReadonlySnapshotSource<ConsciousOceanClientEventWindow | undefined>
  /** Shared world read face used by a host bridge that pairs it with one Session scene. */
  readonly world: ReadonlySnapshotSource<CognitiveWorldSnapshot>
  /** Release event-window subscriptions and derived scene state. */
  readonly dispose: () => void
}

/** Read-only bridge for an external visual review surface. */
export interface ConsciousOceanClientSceneBridge {
  /** Currently selected Session identity, if a host selected one. */
  readonly sessionId: string | undefined
  /** @returns the selected Session scene, world, and complete current event window. */
  readonly read: () => {
    readonly sessionId: string
    readonly world: CognitiveWorldSnapshot
    readonly scene: OceanSceneProjection
    readonly eventWindow: ConsciousOceanClientEventWindow
  } | undefined
  /** @returns the selected Session event window even before a scene trace exists. */
  readonly readEventWindow: () => { readonly sessionId: string; readonly eventWindow: ConsciousOceanClientEventWindow } | undefined
  /** @param listener - called after the selected world or scene changes. @returns unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void
  /** @param sessionId - Session identity to expose through the bridge. */
  readonly selectSession: (sessionId: SessionId) => void
  /** Release bridge subscriptions. */
  readonly dispose: () => void
}

function headerOf(sessionId: SessionId): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false }
}

function durableEventsOf(entries: readonly (ClientEventEntry | ClientTransientEntry)[]): readonly SessionEvent[] {
  return entries.filter((entry): entry is ClientEventEntry => entry.type === 'event').map(entry => entry.event)
}

function isMemorySource(
  value: CognitiveWorldSnapshot | MemoryClientSnapshotSource,
): value is MemoryClientSnapshotSource {
  return 'getSnapshot' in value && 'subscribe' in value
}

/**
 * Bind the existing Client Session event windows to the Conscious Ocean scene owner.
 *
 * The adapter folds only the currently supplied event window. It does not perform a
 * cold log read, call a Provider, or create a second Session or Trace runtime.
 * @param sessions - existing DSH Client Session lookup.
 * @param worldOrMemory - immutable world snapshot or the existing Memory snapshot face.
 * @returns Session-scoped scene sources and their lifecycle owner.
 */
export function createConsciousOceanClientSceneSource(
  sessions: ConsciousOceanClientSessions,
  worldOrMemory: CognitiveWorldSnapshot | MemoryClientSnapshotSource,
): ConsciousOceanClientSceneSource {
  let memory: MemoryClientSnapshotSource | undefined
  let worldVersion: number
  let world: CognitiveWorldSnapshot
  if (isMemorySource(worldOrMemory)) {
    memory = worldOrMemory
    worldVersion = 1
    world = buildMemoryCognitiveWorld(memory.getSnapshot(), worldVersion)
  } else {
    memory = undefined
    worldVersion = worldOrMemory.worldVersion
    world = worldOrMemory
  }
  const sessionOwner = createSessionProjectionProvider()
  const traceOwner = createTraceProjectionProvider()
  const sceneOwner = createSessionSceneProjectionOwner(world, sessionOwner.provider, traceOwner.provider)
  const sources = new Map<string, ReadonlySnapshotSource<OceanSceneProjection | undefined>>()
  const eventWindowSources = new Map<string, ReadonlySnapshotSource<ConsciousOceanClientEventWindow | undefined>>()
  const references = new Map<string, {
    reference: ConsciousOceanClientSessionReference
    stop: () => void
    subscribers: number
    loaded?: ConsciousOceanClientEventWindow
  }>()
  let disposed = false
  const stopMemory = memory?.subscribe(() => {
    if (disposed) return
    worldVersion += 1
    world = buildMemoryCognitiveWorld(memory.getSnapshot(), worldVersion)
    sceneOwner.replaceWorld(world)
  })

  const retainSession = (sessionId: SessionId): (() => void) => {
    const key = String(sessionId)
    const existing = references.get(key)
    const owner = existing ?? {
      reference: sessions.retain(sessionId, { source: 'consciousOcean' }),
      stop: () => {},
      subscribers: 0,
    }
    owner.subscribers += 1
    if (existing === undefined) {
      references.set(key, owner)
      const load = () => {
        if (references.get(key) !== owner) return
        const window = owner.reference.binding.eventSource.getSnapshot()
        if (owner.loaded === window) return
        const loaded = loadSessionSceneProjection(headerOf(sessionId), durableEventsOf(window.entries))
        owner.loaded = window
        sessionOwner.replace(sessionId, loaded.session)
        if (loaded.trace === undefined) traceOwner.remove(sessionId)
        else traceOwner.replace(sessionId, loaded.trace)
      }
      owner.stop = owner.reference.binding.eventSource.subscribe(load)
      load()
      void owner.reference.ready.then(load).catch((_error: unknown) => {
        // The Session controller owns hydration failures and the current event window.
      })
    }
    let active = true
    return () => {
      if (!active || references.get(key) !== owner) return
      active = false
      owner.subscribers -= 1
      if (owner.subscribers > 0) return
      references.delete(key)
      owner.stop()
      owner.reference.release()
      traceOwner.remove(sessionId)
      sessionOwner.remove(sessionId)
    }
  }

  const forSession = (sessionId: SessionId): ReadonlySnapshotSource<OceanSceneProjection | undefined> => {
    const key = String(sessionId)
    const existing = sources.get(key)
    if (existing !== undefined) return existing
    const source: ReadonlySnapshotSource<OceanSceneProjection | undefined> = {
      getSnapshot: () => disposed ? undefined : sceneOwner.scenes.get(sessionId),
      subscribe: (listener) => {
        if (disposed) return () => {}
        const release = retainSession(sessionId)
        const stop = sceneOwner.scenes.subscribe(sessionId, listener)
        return () => { stop(); release() }
      },
    }
    sources.set(key, source)
    return source
  }

  const eventWindowForSession = (sessionId: SessionId): ReadonlySnapshotSource<ConsciousOceanClientEventWindow | undefined> => {
    const key = String(sessionId)
    const existing = eventWindowSources.get(key)
    if (existing !== undefined) return existing
    const source: ReadonlySnapshotSource<ConsciousOceanClientEventWindow | undefined> = {
      getSnapshot: () => {
        if (disposed) return undefined
        const binding = references.get(key)?.reference.binding ?? sessions.binding(sessionId)
        return binding?.eventSource.getSnapshot()
      },
      subscribe: (listener) => {
        if (disposed) return () => {}
        const release = retainSession(sessionId)
        const binding = references.get(key)?.reference.binding
        const stop = binding?.eventSource.subscribe(listener)
        return () => { stop?.(); release() }
      },
    }
    eventWindowSources.set(key, source)
    return source
  }

  return {
    forSession,
    world: sceneOwner.world,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const owner of references.values()) {
        owner.stop()
        owner.reference.release()
      }
      references.clear()
      stopMemory?.()
      sceneOwner.dispose()
      sources.clear()
      eventWindowSources.clear()
    },
    eventWindowForSession,
  }
}

/**
 * Pair one Client scene source with its shared world read face for a host-owned review bridge.
 *
 * The bridge subscribes only to the selected Session and shared world. It does not expose
 * Session handles, cold log readers, or mutation methods.
 * @param source - Existing Client scene source and its world read face.
 * @returns a disposable read-only bridge.
 */
export function createConsciousOceanClientSceneBridge(
  source: ConsciousOceanClientSceneSource,
): ConsciousOceanClientSceneBridge {
  let selectedSessionId: SessionId | undefined
  let selectedScene: ReadonlySnapshotSource<OceanSceneProjection | undefined> | undefined
  let selectedEventWindow: ReadonlySnapshotSource<ConsciousOceanClientEventWindow | undefined> | undefined
  let stopScene = (): void => {}
  let stopEventWindow = (): void => {}
  let stopWorld = (): void => {}
  let disposed = false
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const selectSession = (sessionId: SessionId): void => {
    if (disposed || selectedSessionId === sessionId) return
    stopScene()
    stopEventWindow()
    stopWorld()
    selectedSessionId = sessionId
    selectedScene = source.forSession(sessionId)
    selectedEventWindow = source.eventWindowForSession(sessionId)
    stopScene = selectedScene.subscribe(notify)
    stopEventWindow = selectedEventWindow.subscribe(notify)
    stopWorld = source.world.subscribe(notify)
    notify()
  }
  return {
    get sessionId() { return selectedSessionId === undefined ? undefined : String(selectedSessionId) },
    read: () => {
      if (disposed || selectedSessionId === undefined || selectedScene === undefined) return undefined
      const scene = selectedScene.getSnapshot()
      const eventWindow = selectedEventWindow?.getSnapshot()
      if (scene === undefined || eventWindow === undefined) return undefined
      return { sessionId: String(selectedSessionId), world: source.world.getSnapshot(), scene, eventWindow }
    },
    readEventWindow: () => {
      if (disposed || selectedSessionId === undefined || selectedEventWindow === undefined) return undefined
      const eventWindow = selectedEventWindow.getSnapshot()
      if (eventWindow === undefined) return undefined
      return { sessionId: String(selectedSessionId), eventWindow }
    },
    subscribe: (listener) => {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    selectSession,
    dispose: () => {
      if (disposed) return
      disposed = true
      stopScene()
      stopEventWindow()
      stopWorld()
      listeners.clear()
      selectedScene = undefined
      selectedEventWindow = undefined
      selectedSessionId = undefined
    },
  }
}
