/** Host-owned confirmation and execution over the persistence owners' deletion operations. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import {
  DeletionJournalError,
  type ConfirmedDeletion,
  type DeletionRecord,
  type HostDeletionJournal,
} from '@deepseek-ai/dsh-session-persistence/deletion-journal'
import type { DeletionCleanupStep, DeletionFailure, DeletionId, DeletionImpact, DeletionPreview, DeletionReceipt } from './types.ts'

/** One owner-verified observation for comparing a preview with the reserved commit cut. */
export interface DeletionObservation {
  readonly scope: ConfirmedDeletion
  readonly revision: string
  readonly impact: DeletionImpact
}

/** The temporary reservation guarantees admission is frozen through the acceptance write. */
export interface DeletionReservation {
  readonly observation: DeletionObservation
  readonly physicalScope: ConfirmedDeletion
  /** Release temporary admission only when the acceptance state is known. */
  release(): void
}

/** Provider of persisted identities and cleanup. It verifies root exclusivity and checks journal fences before exposing the store. */
export interface DeletionOwners {
  /**
   * Observe a target without activating it.
   * @param sessionId - requested root.
   * @param signal - cancellation before acceptance.
   * @returns an observation or undefined for a missing target.
   */
  observe(sessionId: SessionId, signal: AbortSignal): Promise<DeletionObservation | undefined>
  /**
   * Reserve all members and re-observe while admission and writer leases are held.
   * @param preview - owner observation bound to the original preview.
   * @param signal - cancellation before acceptance.
   * @returns the owner-held reservation.
   */
  reserve(preview: DeletionObservation, signal: AbortSignal): Promise<DeletionReservation>
  /**
   * Execute or verify one idempotent cleanup step within recorded ownership.
   * @param id - identity of the accepted deletion.
   * @param operation - durable deletion record guarded by the journal.
   * @param step - first unfinished step.
   * @returns the verified result or a classified owner failure.
   */
  cleanup(id: DeletionId, operation: Exclude<DeletionRecord, { state: 'deleted' }>, step: DeletionCleanupStep): Promise<
    { readonly kind: 'verified' } | { readonly kind: 'blocked'; readonly reason: DeletionFailure; readonly retryable: boolean }
  >
}

/** Domain failures that callers can map to localized results. */
export class SessionDeletionError extends Error {
  constructor(
    readonly code: 'not-found' | 'stale-preview' | 'active' | 'unavailable' | 'receipt-unknown' | 'stale-receipt',
    options?: ErrorOptions,
  ) {
    super(`Session deletion: ${code}`, options)
    this.name = 'SessionDeletionError'
  }
}

interface PreviewEntry {
  readonly peerId: PeerId
  readonly observation: DeletionObservation
  readonly expiresAt: number
}

interface CoordinatorOptions {
  readonly previewTtlMs: number
  readonly previewCapacity: number
  readonly reportError: (error: unknown, operation: DeletionId) => void
}

/** Orchestrates one verified storage binding. The Remote authorizes callers before invoking it. */
export class SessionDeletionCoordinator {
  private readonly previews = new Map<DeletionId, PreviewEntry>()
  private readonly running = new Map<DeletionId, Promise<void>>()
  private readonly uncertainReservations = new Map<DeletionId, DeletionReservation>()
  private disposed = false

  /**
   * @param journal - open durable acceptance log of the current storage binding.
   * @param owners - mounted, verified cleanup owners for this binding.
   * @param options - validated preview limits and Host diagnostic sink.
   */
  constructor(
    private readonly journal: HostDeletionJournal,
    private readonly owners: DeletionOwners,
    private readonly options: CoordinatorOptions,
  ) {}

  /**
   * @param peerId - authenticated browser Peer.
   * @param sessionId - requested Session.
   * @param signal - caller cancellation.
   * @returns current impact and a confirmation token when idle.
   */
  async preview(peerId: PeerId, sessionId: SessionId, signal: AbortSignal): Promise<DeletionPreview> {
    this.assertServing()
    const observed = await this.owners.observe(sessionId, signal)
    signal.throwIfAborted()
    this.assertServing()
    if (observed === undefined) throw new SessionDeletionError('not-found')
    if (observed.impact.activity.length > 0) return { ...observed.impact, kind: 'blocked' }
    const now = Date.now()
    for (const [key, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(key)
    }
    if (this.previews.size >= this.options.previewCapacity) throw new SessionDeletionError('unavailable')
    const deletionId = brandString<DeletionId>(randomUUID())
    const expiresAt = now + this.options.previewTtlMs
    this.previews.set(deletionId, { peerId, observation: structuredClone(observed), expiresAt })
    return { ...observed.impact, kind: 'ready', deletionId, expiresAt }
  }

  /**
   * @param peerId - authenticated browser Peer.
   * @param sessionId - original target.
   * @param deletionId - confirmation token.
   * @param signal - caller cancellation before durable acceptance.
   * @returns the acceptance or an existing receipt after a lost reply.
   */
  async commit(peerId: PeerId, sessionId: SessionId, deletionId: DeletionId, signal: AbortSignal): Promise<DeletionReceipt> {
    this.assertServing()
    signal.throwIfAborted()
    const existing = this.readReceipt(deletionId)
    if (existing !== undefined) {
      if (existing.rootSessionId !== sessionId) throw new SessionDeletionError('stale-preview')
      return receipt(deletionId, existing)
    }
    const preview = this.previews.get(deletionId)
    if (preview === undefined || preview.peerId !== peerId || preview.expiresAt <= Date.now()
      || preview.observation.scope.rootSessionId !== sessionId) throw new SessionDeletionError('stale-preview')
    this.previews.delete(deletionId)
    const reservation = await this.owners.reserve(preview.observation, signal)
    try {
      signal.throwIfAborted()
      this.assertServing()
      const current = reservation.observation
      if (current.impact.activity.length > 0) throw new SessionDeletionError('active')
      if (preview.observation.revision !== current.revision || !isDeepStrictEqual(preview.observation.scope, current.scope)) {
        throw new SessionDeletionError('stale-preview')
      }
      const accepted = await this.accept(deletionId, reservation.physicalScope, reservation)
      this.start(deletionId)
      return receipt(deletionId, accepted)
    } finally {
      if (this.uncertainReservations.get(deletionId) !== reservation) reservation.release()
    }
  }

  /**
   * @param id - accepted ID.
   * @returns its current receipt, if present.
   */
  status(id: DeletionId): DeletionReceipt | undefined {
    const record = this.readReceipt(id)
    return record === undefined ? undefined : receipt(id, record)
  }

  /**
   * @param after - last receipt ID from the previous page.
   * @param limit - validated response page size.
   * @returns receipts in durable acceptance order.
   */
  list(after: DeletionId | undefined, limit: number): DeletionReceipt[] {
    this.assertServing()
    const page: DeletionReceipt[] = []
    let pastCursor = after === undefined
    for (const [key, record] of this.journal.entries()) {
      if (pastCursor) {
        page.push(receipt(key, record))
        if (page.length === limit) break
      } else if (key === after) pastCursor = true
    }
    return page
  }

  /**
   * @param id - accepted ID.
   * @param revision - current receipt revision.
   * @returns the receipt for the recorded scope.
   */
  retry(id: DeletionId, revision: number): DeletionReceipt {
    this.assertServing()
    const record = this.readReceipt(id)
    if (record === undefined) throw new SessionDeletionError('not-found')
    if (record.state === 'deleted' || this.running.has(id)) return receipt(id, record)
    if (record.operationRevision !== revision) throw new SessionDeletionError('stale-receipt')
    if (record.state === 'action_required' && !record.retryable) throw new SessionDeletionError('unavailable')
    this.start(id)
    return receipt(id, record)
  }

  /** Schedule one recovery attempt per interrupted operation after the owners have restored the admission fences. */
  recover(): void {
    for (const [id, record] of this.journal.entries()) {
      if (record.state === 'pending' || record.state === 'purging') this.start(id)
    }
  }

  /** Stop new work and drain running cleanup before the owner closes the journal. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.previews.clear()
    await Promise.all(this.running.values())
  }

  private assertServing(): void {
    if (this.disposed || this.uncertainReservations.size > 0) throw new SessionDeletionError('unavailable')
  }

  private readReceipt(id: DeletionId): DeletionRecord | undefined {
    if (this.uncertainReservations.has(id)) throw new SessionDeletionError('receipt-unknown')
    try {
      return this.journal.get(id)
    } catch (cause: unknown) {
      throw new SessionDeletionError('receipt-unknown', { cause })
    }
  }

  private async accept(id: DeletionId, scope: ConfirmedDeletion, reservation: DeletionReservation): Promise<DeletionRecord> {
    try {
      return await this.journal.accept(id, scope)
    } catch (cause: unknown) {
      if (cause instanceof DeletionJournalError) throw new SessionDeletionError('stale-preview', { cause })
      // A failed publish can leave a complete record on disk while the open cache
      // still shows the prior value. Only reopening the journal resolves that cut.
      this.uncertainReservations.set(id, reservation)
      this.options.reportError(cause, id)
      throw new SessionDeletionError('receipt-unknown', { cause })
    }
  }

  private start(id: DeletionId): void {
    if (this.disposed || this.running.has(id)) return
    const run = Promise.resolve().then(async () => {
      for (let record = this.journal.get(id); record !== undefined && record.state !== 'deleted'; record = this.journal.get(id)) {
        if (this.disposed || (record.state === 'action_required' && !record.retryable)) return
        const step = record.remaining[0]
        if (step === undefined) throw new DeletionJournalError('out-of-order')
        const outcome = await this.owners.cleanup(id, record, step)
        if (outcome.kind === 'blocked') {
          await this.journal.requireAction(id, record.operationRevision, outcome.reason, outcome.retryable)
          return
        }
        await this.journal.completeStep(id, record.operationRevision, step)
      }
    }).catch(async (error: unknown) => {
      this.options.reportError(error, id)
      try {
        const record = this.journal.get(id)
        if (record !== undefined && record.state !== 'deleted') {
          await this.journal.requireAction(id, record.operationRevision, 'outcome-unknown', false)
        }
      } catch (journalFailure: unknown) {
        this.options.reportError(journalFailure, id)
      }
    }).finally(() => { this.running.delete(id) })
    this.running.set(id, run)
  }
}

function receipt(deletionId: DeletionId, record: DeletionRecord): DeletionReceipt {
  const sessionIds = [record.rootSessionId, ...record.sessionIds.filter(id => id !== record.rootSessionId)]
  const value = { deletionId, sessionIds, operationRevision: record.operationRevision, state: record.state }
  if (record.state === 'deleted') return value
  return {
    ...value,
    ...(record.remaining[0] === undefined ? {} : { step: record.remaining[0] }),
    ...(record.state === 'action_required' ? { reason: record.reason, retryable: record.retryable } : {}),
  }
}
