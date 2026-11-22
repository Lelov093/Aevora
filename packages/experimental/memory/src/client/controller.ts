/** Client adapter that turns Host Memory Remote calls into a reactive page source. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ConfirmedMemoryInput, MemoryId, MemoryItem, MemoryQuery, MemoryUpdate } from '../types.ts'
import type { MemoryProvider } from '../provider.ts'

/** Generated Host Remote methods consumed by the page adapter. */
export interface MemoryRemote {
  readonly list: (query?: MemoryQuery, signal?: AbortSignal) => Promise<RemoteResult<readonly MemoryItem[]>>
  readonly get: (id: MemoryId, signal?: AbortSignal) => Promise<RemoteResult<MemoryItem | undefined>>
  readonly createConfirmed: (input: ConfirmedMemoryInput, signal?: AbortSignal) => Promise<RemoteResult<MemoryItem>>
  readonly update: (id: MemoryId, expectedRevision: number, change: MemoryUpdate, signal?: AbortSignal) => Promise<RemoteResult<MemoryItem>>
  readonly forget: (id: MemoryId, expectedRevision: number, signal?: AbortSignal) => Promise<RemoteResult<MemoryItem>>
  readonly recall: (id: MemoryId, expectedRevision: number, signal?: AbortSignal) => Promise<RemoteResult<MemoryItem>>
  readonly setPinned: (id: MemoryId, expectedRevision: number, pinned: boolean, signal?: AbortSignal) => Promise<RemoteResult<MemoryItem>>
  readonly delete: (id: MemoryId, expectedRevision: number, signal?: AbortSignal) => Promise<RemoteResult<boolean>>
}

/** Client-facing Host adapter with a reactive snapshot and revision-aware mutations. */
export interface MemoryRemoteController extends Pick<MemoryProvider, 'createConfirmed' | 'update' | 'forget' | 'recall' | 'setPinned' | 'delete'> {
  readonly hooks: { readonly memory: SnapshotStore<readonly MemoryItem[]> }
  /** Read-only Memory snapshot consumed by optional visual Projection clients. */
  readonly snapshot: {
    readonly getSnapshot: () => readonly MemoryItem[]
    readonly subscribe: (listener: () => void) => () => void
  }
  readonly load: () => Promise<void>
  readonly dispose: () => void
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

/**
 * Adapt generated Host Remote calls to the page's existing provider face.
 * @param remote - generated Memory namespace from the authenticated Host.
 * @returns reactive page controller.
 */
export function createMemoryRemoteController(remote: MemoryRemote): MemoryRemoteController {
  const source = createSnapshotStore<readonly MemoryItem[]>([])
  let disposed = false
  const load = async (): Promise<void> => {
    const result = unwrap(await remote.list({ includeForgotten: true }))
    if (!disposed) source.set(result)
  }
  const mutate = async <T>(action: () => Promise<RemoteResult<T>>): Promise<T> => {
    const result = unwrap(await action())
    await load()
    return result
  }
  return {
    hooks: { memory: source },
    snapshot: source,
    load,
    createConfirmed: input => mutate(() => remote.createConfirmed(input)),
    update: (id, expectedRevision, change) => mutate(() => remote.update(id, expectedRevision, change)),
    forget: (id, expectedRevision) => mutate(() => remote.forget(id, expectedRevision)),
    recall: (id, expectedRevision) => mutate(() => remote.recall(id, expectedRevision)),
    setPinned: (id, expectedRevision, pinned) => mutate(() => remote.setPinned(id, expectedRevision, pinned)),
    delete: (id, expectedRevision) => mutate(() => remote.delete(id, expectedRevision)),
    dispose: () => { disposed = true },
  }
}
