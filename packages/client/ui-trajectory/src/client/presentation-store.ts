/** Browser-local trajectory presentation shared by session views in one plugin lifecycle. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** User-facing representations of the same recorded execution. */
export type TrajectoryPresentation = 'overview' | 'detail'

/**
 * Restore the last presentation, defaulting new or invalid persisted values to overview.
 * @returns Shared preference without changing session or provider settings.
 */
export function createTrajectoryPresentationStore(): SnapshotStore<TrajectoryPresentation> {
  const store = createSnapshotStore<TrajectoryPresentation>('overview', { persist: { name: 'aevora.trajectory.presentation' } })
  if (store.getSnapshot() !== 'overview' && store.getSnapshot() !== 'detail') store.set('overview')
  return store
}
