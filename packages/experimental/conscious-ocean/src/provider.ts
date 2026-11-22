/** Read-only Provider seams for the shared cognitive world and Session views. */

import { SessionId } from '@deepseek-ai/dsh-session/types'
import { buildOceanSceneProjection } from './scene-projection.ts'
import type { OceanSceneProjection, OceanTurnOverlay } from './scene-projection.ts'
import type { CognitiveWorldSnapshot, ConsciousOceanSessionProjectionView } from './types.ts'

/** Minimal observable source consumed by a read-only renderer or inspector. */
export interface ReadonlySnapshotSource<T> {
  /** @returns the current immutable value. */
  readonly getSnapshot: () => T
  /** @param listener - called after the owner publishes a new reference. @returns unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void
}

/** Root-scoped provider for the static, cross-Session cognitive world. */
export type CognitiveWorldProvider = ReadonlySnapshotSource<CognitiveWorldSnapshot>

/** Root-scoped provider for per-Session read-only projections. */
export interface SessionProjectionProvider {
  /** @returns Session identities currently present in the projection owner. */
  readonly list: () => readonly SessionId[]
  /** @param sessionId - Session whose projection is requested. @returns its latest view, if loaded. */
  readonly get: (sessionId: SessionId) => ConsciousOceanSessionProjectionView | undefined
  /** @param sessionId - Session whose view should be observed. @param listener - invalidation callback. @returns unsubscribe. */
  readonly subscribe: (sessionId: SessionId, listener: () => void) => () => void
  /** @param listener - invalidation callback for any Session view. @returns unsubscribe. */
  readonly subscribeAll: (listener: () => void) => () => void
}

/** Read-only Session-scoped Trace Projection used by the scene owner. */
export interface TraceProjectionProvider {
  /** @returns Session identities with a recorded Trace overlay. */
  readonly list: () => readonly SessionId[]
  /** @param sessionId - Session whose Trace overlay is requested. @returns the latest overlay, if available. */
  readonly get: (sessionId: SessionId) => OceanTurnOverlay | undefined
  /** @param sessionId - Session whose overlay should be observed. @param listener - invalidation callback. @returns unsubscribe. */
  readonly subscribe: (sessionId: SessionId, listener: () => void) => () => void
  /** @param listener - invalidation callback for any Trace overlay. @returns unsubscribe. */
  readonly subscribeAll: (listener: () => void) => () => void
}

/** Session-scoped read face for renderer-neutral scene projections. */
export interface SceneProjectionProvider {
  /** @param sessionId - Session whose scene should be read. @returns the latest scene, if available. */
  readonly get: (sessionId: SessionId) => OceanSceneProjection | undefined
  /** @param sessionId - Session whose scene should be observed. @param listener - invalidation callback. @returns unsubscribe. */
  readonly subscribe: (sessionId: SessionId, listener: () => void) => () => void
  /** @param listener - invalidation callback for any scene. @returns unsubscribe. */
  readonly subscribeAll: (listener: () => void) => () => void
}

/** Owner for one renderer-neutral world and its derived Session scenes. */
export interface SceneProjectionOwner {
  readonly world: CognitiveWorldProvider
  readonly scenes: SceneProjectionProvider
  /** @param value - next immutable world snapshot. Recomputes every retained Session scene. */
  readonly replaceWorld: (value: CognitiveWorldSnapshot) => void
  /** @param sessionId - Session receiving the overlay. @param overlay - recorded Session/Turn evidence. */
  readonly replaceOverlay: (sessionId: SessionId, overlay: OceanTurnOverlay) => void
  /** @param sessionId - Session whose derived scene should be removed. */
  readonly remove: (sessionId: SessionId) => void
}

/** Owner for scenes derived from real Session and Trace Projection faces. */
export interface SessionSceneProjectionOwner {
  readonly world: CognitiveWorldProvider
  readonly scenes: SceneProjectionProvider
  /** @param value - next immutable world snapshot. */
  readonly replaceWorld: (value: CognitiveWorldSnapshot) => void
  /** @param sessionId - Session whose scene should be removed. */
  readonly remove: (sessionId: SessionId) => void
  /** Release source subscriptions owned by the scene projection. */
  readonly dispose: () => void
}

/** The two read-only data faces consumed by the right-Sidebar plugin. */
export interface ConsciousOceanDataProvider {
  readonly world: CognitiveWorldProvider
  readonly sessions: SessionProjectionProvider
}

/** Owner-side writer for a snapshot provider; consumers receive only its read face. */
export interface SnapshotOwner<T> {
  readonly provider: ReadonlySnapshotSource<T>
  /** @param value - new immutable snapshot reference. */
  readonly replace: (value: T) => void
}

/**
 * Create an instance-owned read-only world provider.
 * @param initial - initial world snapshot.
 * @returns an owner handle and the read-only provider exposed to UI consumers.
 */
export function createCognitiveWorldProvider(initial: CognitiveWorldSnapshot): SnapshotOwner<CognitiveWorldSnapshot> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    provider: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    replace: (value) => {
      if (Object.is(snapshot, value)) return
      snapshot = value
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Create one owner for a renderer-neutral world and its Session scene sources.
 * The owner derives scenes only from the world snapshot and recorded overlays.
 * @param initialWorld - immutable world snapshot used before any replacement.
 * @param initialOverlays - optional Session overlays to replay at construction.
 * @returns world and scene read faces plus replacement controls.
 */
export function createSceneProjectionOwner(
  initialWorld: CognitiveWorldSnapshot,
  initialOverlays: readonly (readonly [SessionId, OceanTurnOverlay])[] = [],
): SceneProjectionOwner {
  let worldSnapshot = initialWorld
  const overlays = new Map<string, OceanTurnOverlay>(initialOverlays)
  const scenes = new Map<string, OceanSceneProjection>()
  const sceneListeners = new Map<string, Set<() => void>>()
  const worldListeners = new Set<() => void>()
  const allListeners = new Set<() => void>()
  const notify = (sessionId: SessionId): void => {
    for (const listener of [...sceneListeners.get(String(sessionId)) ?? []]) listener()
    for (const listener of [...allListeners]) listener()
  }
  const rebuild = (sessionId: SessionId, overlay: OceanTurnOverlay): void => {
    scenes.set(String(sessionId), buildOceanSceneProjection(worldSnapshot, overlay))
    notify(sessionId)
  }
  for (const [sessionId, overlay] of initialOverlays) rebuild(sessionId, overlay)
  return {
    world: {
      getSnapshot: () => worldSnapshot,
      subscribe: (listener) => {
        worldListeners.add(listener)
        return () => { worldListeners.delete(listener) }
      },
    },
    scenes: {
      get: sessionId => scenes.get(String(sessionId)),
      subscribe: (sessionId, listener) => {
        const bucket = sceneListeners.get(String(sessionId)) ?? new Set<() => void>()
        bucket.add(listener)
        sceneListeners.set(String(sessionId), bucket)
        return () => {
          bucket.delete(listener)
          if (bucket.size === 0) sceneListeners.delete(String(sessionId))
        }
      },
      subscribeAll: (listener) => {
        allListeners.add(listener)
        return () => { allListeners.delete(listener) }
      },
    },
    replaceWorld: (value) => {
      if (Object.is(worldSnapshot, value)) return
      worldSnapshot = value
      for (const listener of [...worldListeners]) listener()
      for (const [sessionId, overlay] of overlays) rebuild(SessionId(sessionId), overlay)
      if (overlays.size === 0) for (const listener of [...allListeners]) listener()
    },
    replaceOverlay: (sessionId, overlay) => {
      overlays.set(String(sessionId), overlay)
      rebuild(sessionId, overlay)
    },
    remove: (sessionId) => {
      const key = String(sessionId)
      overlays.delete(key)
      if (!scenes.delete(key)) return
      notify(sessionId)
    },
  }
}

/**
 * Derive Session scenes from the real Session Projection and Trace Projection read faces.
 * A scene exists only while both faces contain the same Session identity.
 * @param initialWorld - immutable renderer-neutral world snapshot.
 * @param sessions - existing DSH Session Projection read face.
 * @param traces - recorded Trace Projection read face.
 * @returns an owner with world and Session-scoped scene read faces.
 */
export function createSessionSceneProjectionOwner(
  initialWorld: CognitiveWorldSnapshot,
  sessions: SessionProjectionProvider,
  traces: TraceProjectionProvider,
): SessionSceneProjectionOwner {
  let worldSnapshot = initialWorld
  const scenes = new Map<string, OceanSceneProjection>()
  const sceneInputs = new Map<string, {
    world: CognitiveWorldSnapshot
    session: ConsciousOceanSessionProjectionView
    overlay: OceanTurnOverlay
  }>()
  const sceneListeners = new Map<string, Set<() => void>>()
  const worldListeners = new Set<() => void>()
  const allListeners = new Set<() => void>()
  const notify = (sessionId: SessionId): void => {
    for (const listener of [...sceneListeners.get(String(sessionId)) ?? []]) listener()
    for (const listener of [...allListeners]) listener()
  }
  const rebuild = (sessionId: SessionId): void => {
    const overlay = traces.get(sessionId)
    const session = sessions.get(sessionId)
    if (overlay === undefined || session === undefined || overlay.sessionId !== sessionId) {
      sceneInputs.delete(String(sessionId))
      if (scenes.delete(String(sessionId))) notify(sessionId)
      return
    }
    const previous = sceneInputs.get(String(sessionId))
    if (previous !== undefined && Object.is(previous.world, worldSnapshot)
      && Object.is(previous.session, session) && Object.is(previous.overlay, overlay)) return
    sceneInputs.set(String(sessionId), { world: worldSnapshot, session, overlay })
    scenes.set(String(sessionId), buildOceanSceneProjection(worldSnapshot, overlay))
    notify(sessionId)
  }
  const rebuildAll = (): void => {
    const ids = new Set([...sessions.list(), ...traces.list()].map(String))
    for (const id of scenes.keys()) ids.add(id)
    for (const id of ids) rebuild(SessionId(id))
  }
  const stopSessions = sessions.subscribeAll(rebuildAll)
  const stopTraces = traces.subscribeAll(rebuildAll)
  rebuildAll()
  return {
    world: {
      getSnapshot: () => worldSnapshot,
      subscribe: (listener) => {
        worldListeners.add(listener)
        return () => { worldListeners.delete(listener) }
      },
    },
    scenes: {
      get: sessionId => scenes.get(String(sessionId)),
      subscribe: (sessionId, listener) => {
        const bucket = sceneListeners.get(String(sessionId)) ?? new Set<() => void>()
        bucket.add(listener)
        sceneListeners.set(String(sessionId), bucket)
        return () => {
          bucket.delete(listener)
          if (bucket.size === 0) sceneListeners.delete(String(sessionId))
        }
      },
      subscribeAll: (listener) => {
        allListeners.add(listener)
        return () => { allListeners.delete(listener) }
      },
    },
    replaceWorld: (value) => {
      if (Object.is(worldSnapshot, value)) return
      worldSnapshot = value
      for (const listener of [...worldListeners]) listener()
      rebuildAll()
    },
    remove: (sessionId) => {
      sceneInputs.delete(String(sessionId))
      if (!scenes.delete(String(sessionId))) return
      notify(sessionId)
    },
    dispose: () => {
      stopSessions()
      stopTraces()
      worldListeners.clear()
      sceneListeners.clear()
      allListeners.clear()
      scenes.clear()
    },
  }
}

/** Owner-side writer for the Session projection provider. */
export interface SessionProjectionOwner {
  readonly provider: SessionProjectionProvider
  /** @param sessionId - Session being updated. @param value - immutable projection view. */
  readonly replace: (sessionId: SessionId, value: ConsciousOceanSessionProjectionView) => void
  /** @param sessionId - Session whose view should be removed. */
  readonly remove: (sessionId: SessionId) => void
}

/** Owner-side writer for recorded Trace Projection overlays. */
export interface TraceProjectionOwner {
  readonly provider: TraceProjectionProvider
  /** @param sessionId - Session receiving the overlay. @param value - immutable Trace overlay. */
  readonly replace: (sessionId: SessionId, value: OceanTurnOverlay) => void
  /** @param sessionId - Session whose overlay should be removed. */
  readonly remove: (sessionId: SessionId) => void
}

/**
 * Create an instance-owned read-only Session projection provider.
 * @param initial - optional initial views, normally empty until Session loading publishes one.
 * @returns an owner handle and a read-only provider.
 */
export function createSessionProjectionProvider(
  initial: readonly (readonly [SessionId, ConsciousOceanSessionProjectionView])[] = [],
): SessionProjectionOwner {
  const values = new Map<string, ConsciousOceanSessionProjectionView>(initial)
  const listeners = new Map<string, Set<() => void>>()
  const allListeners = new Set<() => void>()
  const notify = (sessionId: SessionId): void => {
    for (const listener of [...listeners.get(sessionId) ?? []]) listener()
    for (const listener of [...allListeners]) listener()
  }
  return {
    provider: {
      list: () => [...values.keys()].map(SessionId),
      get: sessionId => values.get(sessionId),
      subscribe: (sessionId, listener) => {
        const bucket = listeners.get(sessionId) ?? new Set<() => void>()
        bucket.add(listener)
        listeners.set(sessionId, bucket)
        return () => {
          bucket.delete(listener)
          if (bucket.size === 0) listeners.delete(sessionId)
        }
      },
      subscribeAll: (listener) => {
        allListeners.add(listener)
        return () => { allListeners.delete(listener) }
      },
    },
    replace: (sessionId, value) => {
      if (Object.is(values.get(sessionId), value)) return
      values.set(sessionId, value)
      notify(sessionId)
    },
    remove: (sessionId) => {
      if (!values.delete(sessionId)) return
      notify(sessionId)
    },
  }
}

/**
 * Create an instance-owned read-only Trace Projection provider.
 * @param initial - optional Session overlays, normally restored from keyless Trace fixtures.
 * @returns an owner handle and the read-only provider exposed to scene owners.
 */
export function createTraceProjectionProvider(
  initial: readonly (readonly [SessionId, OceanTurnOverlay])[] = [],
): TraceProjectionOwner {
  const values = new Map<string, OceanTurnOverlay>(initial)
  const listeners = new Map<string, Set<() => void>>()
  const allListeners = new Set<() => void>()
  const notify = (sessionId: SessionId): void => {
    for (const listener of [...listeners.get(sessionId) ?? []]) listener()
    for (const listener of [...allListeners]) listener()
  }
  return {
    provider: {
      list: () => [...values.keys()].map(SessionId),
      get: sessionId => values.get(sessionId),
      subscribe: (sessionId, listener) => {
        const bucket = listeners.get(String(sessionId)) ?? new Set<() => void>()
        bucket.add(listener)
        listeners.set(String(sessionId), bucket)
        return () => {
          bucket.delete(listener)
          if (bucket.size === 0) listeners.delete(String(sessionId))
        }
      },
      subscribeAll: (listener) => {
        allListeners.add(listener)
        return () => { allListeners.delete(listener) }
      },
    },
    replace: (sessionId, value) => {
      if (Object.is(values.get(String(sessionId)), value)) return
      values.set(String(sessionId), value)
      notify(sessionId)
    },
    remove: (sessionId) => {
      if (!values.delete(String(sessionId))) return
      notify(sessionId)
    },
  }
}
