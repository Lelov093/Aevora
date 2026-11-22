/** Reactive controller for the Aevora Plugins tab. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PluginEntryId, PluginInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { AevoraControlKey } from './locales.ts'

/** A feature represented by one existing Loader entry. */
export interface AevoraFeature {
  readonly id: string
  readonly title: AevoraControlKey
  readonly description: AevoraControlKey
  readonly enabled: boolean
  readonly phase: PluginInfo['fiberPhase']
  readonly available: boolean
  readonly readOnlyReason?: string
  readonly entryId?: PluginEntryId
}

/** Tab state projected from the Plugin Manager Remote. */
export interface AevoraControlState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly features: readonly AevoraFeature[]
  readonly busy: string | undefined
}

/** Face consumed by the Aevora Plugins tab. */
export interface AevoraControlInjected {
  readonly hooks: { readonly aevoraControl: SnapshotStore<AevoraControlState> }
  readonly refresh: () => void
  readonly toggle: (feature: AevoraFeature, enabled: boolean) => void
}

const FEATURES = [
  { id: 'aevora-identity', title: 'identityTitle', description: 'identityDescription' },
  { id: 'aevora-memory', title: 'memoryTitle', description: 'memoryDescription' },
  { id: 'aevora-conscious-ocean', title: 'consciousTitle', description: 'consciousDescription' },
] as const satisfies ReadonlyArray<Pick<AevoraFeature, 'id' | 'title' | 'description'>>

function featureFromRow(feature: typeof FEATURES[number], row: PluginInfo | undefined): AevoraFeature {
  return {
    ...feature,
    ...(row === undefined
      ? { enabled: false, phase: null, available: false }
      : {
        enabled: row.enabled,
        phase: row.fiberPhase,
        available: true,
        ...row.readOnlyReason === undefined ? {} : { readOnlyReason: row.readOnlyReason },
        entryId: row.entryId,
      }),
  }
}

function rowForFeature(feature: typeof FEATURES[number], rows: readonly PluginInfo[]): PluginInfo | undefined {
  return rows.find(row => row.readOnlyReason === undefined && row.patchId === feature.id)
}

/** Owns one live inventory read and serializes feature toggles. */
export class AevoraControlController {
  private readonly store: SnapshotStore<AevoraControlState>
  private disposed = false
  private inFlight = false

  /**
   * @param ctx - Client context with Plugin Manager Remote access.
   */
  constructor(private readonly ctx: ClientContext) {
    this.store = createSnapshotStore<AevoraControlState>({ status: 'idle', features: [], busy: undefined })
  }

  /** Return the reactive tab face. */
  face(): AevoraControlInjected {
    return {
      hooks: { aevoraControl: this.store },
      refresh: () => { void this.load() },
      toggle: (feature, enabled) => { void this.setEnabled(feature, enabled) },
    }
  }

  /** Start the inventory subscription and initial read. */
  start(): () => void {
    const offChanged = this.ctx.remote.$on('plugin-manager/changed', () => { void this.load() })
    void this.load()
    return () => { offChanged() }
  }

  /** Release the controller's observable. */
  dispose(): void {
    this.disposed = true
  }

  private isDisposed(): boolean {
    return this.disposed
  }

  private async load(): Promise<void> {
    if (this.isDisposed() || this.inFlight) return
    this.inFlight = true
    this.store.set({ ...this.store.getSnapshot(), status: 'loading', busy: undefined })
    try {
      const result = await this.ctx.remote.pluginManager.listPlugins()
      if (this.isDisposed()) return
      if (!result.ok) {
        this.store.set({ status: 'error', features: [], busy: undefined })
        return
      }
      const features = FEATURES.map(feature => featureFromRow(
        feature,
        rowForFeature(feature, result.value),
      ))
      this.store.set({ status: 'ready', features, busy: undefined })
    } catch (_error) {
      if (!this.isDisposed()) this.store.set({ status: 'error', features: [], busy: undefined })
    } finally {
      this.inFlight = false
    }
  }

  private async setEnabled(feature: AevoraFeature, enabled: boolean): Promise<void> {
    if (
      this.isDisposed()
      || !feature.available
      || feature.entryId === undefined
      || feature.readOnlyReason !== undefined
      || this.inFlight
    ) return
    this.inFlight = true
    this.store.set({ ...this.store.getSnapshot(), busy: feature.id })
    try {
      const result = await this.ctx.remote.pluginManager.setPluginEnabled(feature.entryId, enabled)
      this.inFlight = false
      if (!this.isDisposed() && result.ok) await this.load()
      else if (!this.isDisposed()) this.store.set({ ...this.store.getSnapshot(), status: 'error', busy: undefined })
    } catch (_error) {
      this.inFlight = false
      if (!this.isDisposed()) this.store.set({ ...this.store.getSnapshot(), status: 'error', busy: undefined })
    }
  }
}
