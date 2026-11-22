/** Durable acceptance and ordered cleanup progress for the Host deletion service. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { DeletionCleanupStep, DeletionId } from './deletion-identity.ts'

const deletionIdSchema = z.uuid().transform(brandString<DeletionId>)
const sessionIdSchema = z.string().min(1).transform(SessionId)
const sessionIdsSchema = z.array(sessionIdSchema).min(1)
const operationRevisionSchema = z.number().int().positive()
export const deletionCleanupStep = z.enum([
  'quiesce', 'schedule', 'workspace', 'artifacts', 'logs', 'projection', 'query', 'verify',
])
const targetSchema = z.strictObject({
  sessionId: sessionIdSchema,
  createdAt: z.number().int().nonnegative(),
  physicalIdentity: z.string().min(1),
})
const recordFields = {
  rootSessionId: sessionIdSchema,
  sessionIds: sessionIdsSchema,
  storageBinding: z.string().min(1),
  operationRevision: operationRevisionSchema,
}
const pendingFields = {
  ...recordFields,
  targets: z.array(targetSchema).min(1),
  remaining: z.array(deletionCleanupStep).min(1),
}
const cleanupFailureSchema = z.enum(['owner-unavailable', 'identity-mismatch', 'write-failed', 'outcome-unknown'])

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Admission and recovery records restored before publishing managed Session storage. */
    sessionDeletionJournal: HostDeletionJournal
  }
}
const recordSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...pendingFields, state: z.literal('pending') }),
  z.strictObject({ ...pendingFields, state: z.literal('purging') }),
  z.strictObject({ ...pendingFields, state: z.literal('action_required'), reason: cleanupFailureSchema, retryable: z.boolean() }),
  z.strictObject({ ...recordFields, state: z.literal('deleted') }),
]).refine((record) => {
  const memberIds = new Set(record.sessionIds)
  if (!memberIds.has(record.rootSessionId) || memberIds.size !== record.sessionIds.length) return false
  if (record.state === 'deleted') return true
  if (record.targets.some((target, index) => target.sessionId !== record.sessionIds[index])
    || record.targets.length !== memberIds.size) return false
  if (record.state === 'pending' && record.remaining.length !== deletionCleanupStep.options.length) return false
  const expected = deletionCleanupStep.options.slice(deletionCleanupStep.options.length - record.remaining.length)
  return expected.length === record.remaining.length
    && expected.every((step, index) => step === record.remaining[index])
}, { message: 'Invalid deletion scope or cleanup order' })

/** Pending operations retain ownership evidence. Completed records retain only IDs, binding, and revision. */
export type DeletionRecord = z.infer<typeof recordSchema>

/** Versioned authoritative domain. Incompatible or corrupt records reject when the domain opens. */
export const sessionDeletionDomain = defineDomain({
  name: 'session_deletion',
  version: 1,
  tables: { operations: domainTable<DeletionId, DeletionRecord>(recordSchema) },
})

/** Storage-owner identities fixed by the final Host recheck. */
export interface ConfirmedDeletion {
  readonly rootSessionId: SessionId
  readonly targets: readonly z.infer<typeof targetSchema>[]
}

/** Stable local journal failure categories for the Host coordinator. */
export class DeletionJournalError extends Error {
  constructor(
    readonly code: 'scope-conflict' | 'scope-mismatch' | 'stale-receipt' | 'out-of-order' | 'unverified',
  ) {
    super(`Session deletion journal: ${code}`)
    this.name = 'DeletionJournalError'
  }
}

/**
 * The journal for one verified exclusive storage binding. The caller owns the open
 * Domain and must hold the root lease throughout startup, execution, and teardown.
 */
export class HostDeletionJournal {
  private readonly operations: KvTable<DeletionId, DeletionRecord>

  private acceptanceTail: Promise<void> = Promise.resolve()

  /**
   * @param domain - open authoritative domain for the leased root.
   * @param binding - stable root identity.
   */
  constructor(domain: Domain<typeof sessionDeletionDomain>, private readonly binding: string) {
    this.operations = domain.table('operations')
    const claimed = new Set<SessionId>()
    for (const [key, record] of this.operations.entries()) {
      deletionIdSchema.parse(key)
      if (record.storageBinding !== binding) throw new DeletionJournalError('scope-mismatch')
      for (const sessionId of record.sessionIds) {
        if (claimed.has(sessionId)) throw new DeletionJournalError('scope-conflict')
        claimed.add(sessionId)
      }
    }
  }

  /**
   * Find accepted or deleted operations so admission can rebuild its fences on startup.
   * @returns a snapshot over the authoritative deletion records.
   */
  entries(): IterableIterator<[DeletionId, DeletionRecord]> {
    return this.operations.entries()
  }

  /**
   * Resolve a lost commit reply for a previously issued deletion ID.
   * @param id - Host-issued confirmation ID.
   * @returns the durable operation, if any.
   */
  get(id: DeletionId): DeletionRecord | undefined {
    return this.operations.get(id)
  }

  /**
   * Refuse accesses to accepted members, including IDs retained in completed receipts.
   * @param sessionId - Session an owner is about to expose.
   * @returns whether the ID belongs to any accepted deletion.
   */
  blocks(sessionId: SessionId): boolean {
    for (const [, record] of this.entries()) if (record.sessionIds.includes(sessionId)) return true
    return false
  }

  /**
   * Accept one revalidated scope before cleanup. The caller owns the temporary
   * admission reservation and must keep it until acceptance is known.
   * @param id - Host-issued confirmation ID.
   * @param scope - targets verified while reserved.
   * @returns the durable acceptance or original record for the same root and ID.
   */
  accept(id: DeletionId, scope: ConfirmedDeletion): Promise<DeletionRecord> {
    const pending = recordSchema.parse({
      state: 'pending',
      rootSessionId: scope.rootSessionId,
      sessionIds: scope.targets.map(target => target.sessionId),
      storageBinding: this.binding,
      operationRevision: 1,
      targets: scope.targets,
      remaining: deletionCleanupStep.options,
    })
    const accepted = this.acceptanceTail.then(async () => {
      const existing = this.get(id)
      if (existing !== undefined) {
        if (existing.rootSessionId !== pending.rootSessionId
          || existing.sessionIds.length !== pending.sessionIds.length
          || existing.sessionIds.some((member, index) => member !== pending.sessionIds[index])) {
          throw new DeletionJournalError('scope-mismatch')
        }
        return existing
      }
      const requested = new Set(pending.sessionIds)
      for (const [, record] of this.entries()) {
        if (record.sessionIds.some(member => requested.has(member))) throw new DeletionJournalError('scope-conflict')
      }
      await this.operations.put(id, pending)
      return pending
    })
    // The caller observes its acceptance failure. A rejected request does not block subsequent admission checks.
    this.acceptanceTail = accepted.then(() => undefined, () => undefined)
    return accepted
  }

  /**
   * Commit one cleanup owner's verified result. Completing the verification step
   * replaces sensitive cleanup metadata with the minimal terminal receipt.
   * @param id - accepted deletion ID.
   * @param revision - revision seen by the executor before it performed the step.
   * @param step - owner step whose result was verified.
   * @returns the updated durable progress.
   */
  completeStep(id: DeletionId, revision: number, step: DeletionCleanupStep): Promise<DeletionRecord> {
    return this.operations.update(id, (record) => {
      if (record.operationRevision !== revision) throw new DeletionJournalError('stale-receipt')
      if (record.state === 'deleted' || record.remaining[0] !== step) throw new DeletionJournalError('out-of-order')
      if (record.state === 'action_required' && !record.retryable) throw new DeletionJournalError('unverified')
      const operationRevision = record.operationRevision + 1
      const { rootSessionId, sessionIds, storageBinding, targets, remaining } = record
      const identity = { rootSessionId, sessionIds, storageBinding, operationRevision }
      return step === 'verify' ? { ...identity, state: 'deleted' }
        : { ...identity, state: 'purging', targets, remaining: remaining.slice(1) }
    })
  }

  /**
   * Keep unresolved work visible without changing confirmed members or advancing a step.
   * @param id - accepted deletion ID.
   * @param revision - revision held by the executor.
   * @param reason - safe failure category.
   * @param retryable - whether the owner can safely repeat the same confirmed step.
   * @returns the persisted failure receipt.
   */
  requireAction(
    id: DeletionId, revision: number, reason: z.infer<typeof cleanupFailureSchema>, retryable: boolean,
  ): Promise<DeletionRecord> {
    return this.operations.update(id, (record) => {
      if (record.operationRevision !== revision) throw new DeletionJournalError('stale-receipt')
      if (record.state === 'deleted') throw new DeletionJournalError('out-of-order')
      return { ...record, operationRevision: revision + 1, state: 'action_required', reason, retryable }
    })
  }
}
