/** Browser-safe Memory provider contract and keyless/in-memory implementation. */
import {
  candidateMemoryInputSchema, confirmedMemoryInputSchema, memoryConfirmationSchema, MemoryId, memoryItemSchema,
  memoryQuerySchema, memoryUpdateSchema, memoryValidityAt, memoryRecallabilityAt,
  type CandidateMemoryInput, type ConfirmedMemoryInput, type MemoryConfirmation,
  type MemoryId as MemoryIdType, type MemoryItem, type MemoryQuery, type MemoryUpdate,
} from './types.ts'

/** A stable source of immutable snapshots for Host and keyless consumers. */
export interface ReadonlySnapshotSource<T> {
  /** @returns the current snapshot. */
  readonly getSnapshot: () => T
  /** @param listener - called after a new snapshot reference is published. @returns unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void
}

/** Minimal record store consumed by the shared provider controller. */
export interface MemoryRecordStore {
  /** @returns a snapshot iterator over stored records. */
  readonly entries: () => IterableIterator<[MemoryIdType, MemoryItem]>
  /** @param id - record identity. @returns the current record, if present. */
  readonly get: (id: MemoryIdType) => MemoryItem | undefined
  /** @param id - record identity. @param value - complete validated record. */
  readonly put: (id: MemoryIdType, value: MemoryItem) => Promise<void>
  /** @param id - record identity. @returns whether a record was removed. */
  readonly delete: (id: MemoryIdType) => Promise<boolean>
}

/** Stable machine-readable Memory failure. */
export class MemoryError extends Error {
  /** Machine-readable handling identity. */
  readonly code: 'invalid-input' | 'not-found' | 'revision-conflict' | 'candidate-not-allowed' | 'deletion-not-allowed'

  /** @param code - handling identity. @param message - diagnostic detail. */
  constructor(code: 'invalid-input' | 'not-found' | 'revision-conflict' | 'candidate-not-allowed' | 'deletion-not-allowed', message: string) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}

/** Memory record was absent at the serialized operation point. */
export class MemoryNotFoundError extends MemoryError {
  /** Missing Memory identity. */
  readonly id: MemoryIdType

  /** @param id - missing identity. */
  constructor(id: MemoryIdType) {
    super('not-found', `Memory '${id}' was not found`)
    this.id = id
  }
}

/** An update used an older revision than the stored record. */
export class MemoryRevisionConflictError extends MemoryError {
  /** Conflicting Memory identity. */
  readonly id: MemoryIdType
  /** Revision supplied by the caller. */
  readonly expectedRevision: number
  /** Revision currently stored by the provider. */
  readonly currentRevision: number

  /** @param id - conflicting identity. @param expectedRevision - caller's revision. @param currentRevision - stored revision. */
  constructor(id: MemoryIdType, expectedRevision: number, currentRevision: number) {
    super('revision-conflict', `Memory '${id}' revision ${expectedRevision} is stale; current revision is ${currentRevision}`)
    this.id = id
    this.expectedRevision = expectedRevision
    this.currentRevision = currentRevision
  }
}

/** A provider mutation was not an explicit confirmed-memory operation. */
export class MemoryCandidateRejectedError extends MemoryError {
  /** @param message - rejection detail. */
  constructor(message: string) { super('candidate-not-allowed', message) }
}

/** A physical deletion was requested before the record was forgotten. */
export class MemoryDeletionNotAllowedError extends MemoryError {
  /** @param message - rejection detail. */
  constructor(message: string) { super('deletion-not-allowed', message) }
}

/** Provider operations available to the management page and future Context consumers. */
export interface MemoryProvider extends ReadonlySnapshotSource<readonly MemoryItem[]> {
  /** @param query - optional list filters. @returns current matching records. */
  readonly list: (query?: MemoryQuery) => readonly MemoryItem[]
  /** @param id - record identity. @returns the current record, if present. */
  readonly get: (id: MemoryIdType) => MemoryItem | undefined
  /** @param input - explicit user-confirmed record data. @returns committed record. */
  readonly createConfirmed: (input: ConfirmedMemoryInput) => Promise<MemoryItem>
  /** @param input - candidate data without user confirmation. @returns committed candidate. */
  readonly createCandidate: (input: CandidateMemoryInput) => Promise<MemoryItem>
  /**
   * @param id - candidate identity.
   * @param expectedRevision - optimistic concurrency guard.
   * @param confirmation - explicit user evidence.
   * @returns accepted record.
   */
  readonly confirm: (id: MemoryIdType, expectedRevision: number, confirmation: MemoryConfirmation) => Promise<MemoryItem>
  /**
   * @param id - candidate identity.
   * @param expectedRevision - optimistic concurrency guard.
   * @param reason - durable rejection reason.
   * @returns rejected candidate.
   */
  readonly reject: (id: MemoryIdType, expectedRevision: number, reason: string) => Promise<MemoryItem>
  /**
   * @param id - record identity.
   * @param expectedRevision - optimistic concurrency guard.
   * @param change - editable fields.
   * @returns committed next revision.
   */
  readonly update: (id: MemoryIdType, expectedRevision: number, change: MemoryUpdate) => Promise<MemoryItem>
  /** @param id - record identity. @param expectedRevision - optimistic concurrency guard. @returns committed forgotten record. */
  readonly forget: (id: MemoryIdType, expectedRevision: number) => Promise<MemoryItem>
  /** @param id - record identity. @param expectedRevision - optimistic concurrency guard. @returns committed recalled record. */
  readonly recall: (id: MemoryIdType, expectedRevision: number) => Promise<MemoryItem>
  /**
   * @param id - record identity.
   * @param expectedRevision - optimistic concurrency guard.
   * @param pinned - desired pinned state.
   * @returns committed record.
   */
  readonly setPinned: (id: MemoryIdType, expectedRevision: number, pinned: boolean) => Promise<MemoryItem>
  /**
   * @param id - record identity.
   * @param expectedRevision - optimistic concurrency guard.
   * @returns whether the record was physically deleted.
   */
  readonly delete: (id: MemoryIdType, expectedRevision: number) => Promise<boolean>
}

/** Provider construction options; clocks and ids are injectable for deterministic fixtures. */
export interface MemoryProviderOptions {
  /** @returns current wall-clock milliseconds. */
  readonly now?: () => number
  /** @returns a new valid Memory identity. */
  readonly createId?: () => MemoryIdType
}

/**
 * Create a provider over one serialized record store.
 * @param store - serialized record store owned by the caller.
 * @param options - deterministic clock and identity hooks.
 * @returns a serialized, observable Memory provider.
 */
export function createMemoryProvider(store: MemoryRecordStore, options: MemoryProviderOptions = {}): MemoryProvider {
  const now = options.now ?? Date.now
  const createId = options.createId ?? (() => {
    const uuid = globalThis.crypto.randomUUID()
    return MemoryId(`memory-${uuid}`)
  })
  const listeners = new Set<() => void>()
  let snapshot = snapshotOf(store.entries())
  let chain: Promise<void> = Promise.resolve()

  const publish = (): void => {
    snapshot = snapshotOf(store.entries())
    for (const listener of [...listeners]) listener()
  }
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = chain.then(work)
    chain = result.then(() => undefined, () => undefined)
    return result
  }
  const current = (id: MemoryIdType): MemoryItem => {
    const value = store.get(id)
    if (value === undefined) throw new MemoryNotFoundError(id)
    return value
  }
  const checked = (id: MemoryIdType, expectedRevision: number): MemoryItem => {
    const value = current(id)
    if (value.revision !== expectedRevision) throw new MemoryRevisionConflictError(id, expectedRevision, value.revision)
    return value
  }
  const priorRevision = (value: MemoryItem) => ({
    revision: value.revision,
    kind: value.kind,
    content: value.content,
    scope: value.scope,
    ...(value.applicability === undefined ? {} : { applicability: value.applicability }),
    ...(value.emotionObservation === undefined ? {} : { emotionObservation: value.emotionObservation }),
    ...(value.temporalContext === undefined ? {} : { temporalContext: value.temporalContext }),
    ...(value.feedbackEvents === undefined ? {} : { feedbackEvents: value.feedbackEvents }),
    importance: value.importance ?? 0.5,
    retentionPolicy: value.retentionPolicy ?? { kind: 'persistent' },
    sourceEvidence: value.sourceEvidence,
    ...(value.confirmedAt === undefined ? {} : { confirmedAt: value.confirmedAt }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.validFrom === undefined ? {} : { validFrom: value.validFrom }),
    ...(value.validUntil === undefined ? {} : { validUntil: value.validUntil }),
  })
  const putNext = async (currentValue: MemoryItem, change: MemoryUpdate): Promise<MemoryItem> => {
    const parsed = memoryUpdateSchema.safeParse(change)
    if (!parsed.success) throw new MemoryError('invalid-input', parsed.error.message)
    const next = memoryItemSchema.parse({
      ...currentValue,
      ...parsed.data,
      ...(parsed.data.applicability === null ? { applicability: undefined } : {}),
      ...(parsed.data.emotionObservation === null ? { emotionObservation: undefined } : {}),
      ...(parsed.data.temporalContext === null ? { temporalContext: undefined } : {}),
      ...(parsed.data.validFrom === null ? { validFrom: undefined } : {}),
      ...(parsed.data.validUntil === null ? { validUntil: undefined } : {}),
      revision: currentValue.revision + 1,
      previousRevision: currentValue.revision,
      revisionHistory: [...(currentValue.revisionHistory ?? []), priorRevision(currentValue)],
      updatedAt: now(),
    })
    await store.put(next.memoryId, next)
    publish()
    return next
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    list: query => filterMemoryItems(snapshot, query),
    get: id => store.get(id),
    createConfirmed: input => enqueue(async () => {
      const parsed = confirmedMemoryInputSchema.safeParse(input)
      if (!parsed.success) throw new MemoryError('invalid-input', parsed.error.message)
      const id = parsed.data.memoryId ?? createId()
      if (store.get(id) !== undefined) throw new MemoryError('invalid-input', `Memory '${id}' already exists`)
      const time = now()
      const item = memoryItemSchema.parse({
        memoryId: id,
        revision: 1,
        kind: parsed.data.kind,
        content: parsed.data.content,
        scope: parsed.data.scope,
        ...(parsed.data.applicability === undefined ? {} : { applicability: parsed.data.applicability }),
        ...(parsed.data.emotionObservation === undefined ? {} : { emotionObservation: parsed.data.emotionObservation }),
        ...(parsed.data.temporalContext === undefined ? {} : { temporalContext: parsed.data.temporalContext }),
        ...(parsed.data.feedbackEvents === undefined ? {} : { feedbackEvents: parsed.data.feedbackEvents }),
        admissionState: 'accepted',
        epistemicState: 'asserted',
        validityState: 'current',
        storageTier: 'hot',
        recallState: 'enabled',
        deletionState: 'active',
        pinned: parsed.data.pinned,
        importance: parsed.data.importance,
        retentionPolicy: parsed.data.retentionPolicy,
        relations: parsed.data.relations,
        revisionHistory: [],
        sourceEvidence: parsed.data.sourceEvidence,
        confirmedAt: parsed.data.confirmedAt,
        createdAt: time,
        updatedAt: time,
        ...(parsed.data.observedAt === undefined ? {} : { observedAt: parsed.data.observedAt }),
        ...(parsed.data.validFrom === undefined ? {} : { validFrom: parsed.data.validFrom }),
        ...(parsed.data.validUntil === undefined ? {} : { validUntil: parsed.data.validUntil }),
        policyVersion: parsed.data.policyVersion,
      })
      await store.put(id, item)
      publish()
      return item
    }),
    createCandidate: input => enqueue(async () => {
      const parsed = candidateMemoryInputSchema.safeParse(input)
      if (!parsed.success) throw new MemoryError('invalid-input', parsed.error.message)
      const id = parsed.data.memoryId ?? createId()
      if (store.get(id) !== undefined) throw new MemoryError('invalid-input', `Memory '${id}' already exists`)
      const time = now()
      const item = memoryItemSchema.parse({
        memoryId: id,
        revision: 1,
        kind: parsed.data.kind,
        content: parsed.data.content,
        scope: parsed.data.scope,
        ...(parsed.data.applicability === undefined ? {} : { applicability: parsed.data.applicability }),
        ...(parsed.data.emotionObservation === undefined ? {} : { emotionObservation: parsed.data.emotionObservation }),
        ...(parsed.data.temporalContext === undefined ? {} : { temporalContext: parsed.data.temporalContext }),
        ...(parsed.data.feedbackEvents === undefined ? {} : { feedbackEvents: parsed.data.feedbackEvents }),
        admissionState: 'candidate',
        epistemicState: 'inferred',
        validityState: 'current',
        storageTier: 'working',
        recallState: 'enabled',
        deletionState: 'active',
        pinned: false,
        importance: parsed.data.importance,
        retentionPolicy: parsed.data.retentionPolicy,
        relations: parsed.data.relations,
        revisionHistory: [],
        sourceEvidence: parsed.data.sourceEvidence,
        createdAt: time,
        updatedAt: time,
        ...(parsed.data.observedAt === undefined ? {} : { observedAt: parsed.data.observedAt }),
        ...(parsed.data.validFrom === undefined ? {} : { validFrom: parsed.data.validFrom }),
        ...(parsed.data.validUntil === undefined ? {} : { validUntil: parsed.data.validUntil }),
        policyVersion: parsed.data.policyVersion,
      })
      await store.put(id, item)
      publish()
      return item
    }),
    confirm: (id, expectedRevision, confirmation) => enqueue(async () => {
      const currentValue = checked(id, expectedRevision)
      if (currentValue.admissionState !== 'candidate') {
        throw new MemoryCandidateRejectedError(`Memory '${id}' is not a candidate`)
      }
      const parsed = memoryConfirmationSchema.safeParse(confirmation)
      if (!parsed.success) throw new MemoryError('invalid-input', parsed.error.message)
      const next = memoryItemSchema.parse({
        ...currentValue,
        revision: currentValue.revision + 1,
        previousRevision: currentValue.revision,
        revisionHistory: [...(currentValue.revisionHistory ?? []), priorRevision(currentValue)],
        admissionState: 'accepted',
        epistemicState: 'asserted',
        sourceEvidence: [...currentValue.sourceEvidence, ...parsed.data.sourceEvidence],
        confirmedAt: parsed.data.confirmedAt,
        updatedAt: now(),
      })
      await store.put(next.memoryId, next)
      publish()
      return next
    }),
    reject: (id, expectedRevision, reason) => enqueue(async () => {
      if (reason.trim().length === 0) throw new MemoryError('invalid-input', 'Memory rejection reason must not be empty')
      const currentValue = checked(id, expectedRevision)
      if (currentValue.admissionState !== 'candidate') {
        throw new MemoryCandidateRejectedError(`Memory '${id}' is not a candidate`)
      }
      const next = memoryItemSchema.parse({
        ...currentValue,
        revision: currentValue.revision + 1,
        previousRevision: currentValue.revision,
        revisionHistory: [...(currentValue.revisionHistory ?? []), priorRevision(currentValue)],
        admissionState: 'rejected',
        recallState: 'forgotten',
        pinned: false,
        rejectionReason: reason,
        updatedAt: now(),
      })
      await store.put(next.memoryId, next)
      publish()
      return next
    }),
    update: (id, expectedRevision, change) => enqueue(() => putNext(checked(id, expectedRevision), change)),
    forget: (id, expectedRevision) => enqueue(() => putNext(checked(id, expectedRevision), { recallState: 'forgotten' })),
    recall: (id, expectedRevision) => enqueue(() => putNext(checked(id, expectedRevision), { recallState: 'enabled' })),
    setPinned: (id, expectedRevision, pinned) => enqueue(() => putNext(checked(id, expectedRevision), { pinned })),
    delete: (id, expectedRevision) => enqueue(async () => {
      const value = checked(id, expectedRevision)
      if (value.recallState !== 'forgotten') throw new MemoryDeletionNotAllowedError('Memory must be forgotten before deletion')
      const deleted = await store.delete(id)
      if (deleted) publish()
      return deleted
    }),
  }
}

/**
 * Build a deterministic keyless provider over immutable initial records.
 * @param initial - fixed accepted records used as the initial snapshot.
 * @param options - deterministic clock and identity hooks.
 * @returns an in-memory provider with the Host provider's mutation semantics.
 */
export function createKeylessMemoryProvider(initial: readonly MemoryItem[], options: MemoryProviderOptions = {}): MemoryProvider {
  const records = new Map<MemoryIdType, MemoryItem>()
  for (const raw of initial) {
    const item = memoryItemSchema.parse(raw)
    if (item.admissionState !== 'accepted') throw new MemoryCandidateRejectedError(`Fixture Memory '${item.memoryId}' is not accepted`)
    if (records.has(item.memoryId)) throw new MemoryError('invalid-input', `Duplicate Memory '${item.memoryId}' in fixture`)
    records.set(item.memoryId, item)
  }
  return createMemoryProvider({
    entries: () => ([...records.entries()] as [MemoryIdType, MemoryItem][])[Symbol.iterator](),
    get: id => records.get(id),
    put: (id, value) => { records.set(id, value); return Promise.resolve() },
    delete: id => Promise.resolve(records.delete(id)),
  }, options)
}

function snapshotOf(entries: IterableIterator<[MemoryIdType, MemoryItem]>): readonly MemoryItem[] {
  return [...entries].map(([, item]) => item).sort((left, right) => {
    return right.updatedAt - left.updatedAt || String(left.memoryId).localeCompare(String(right.memoryId))
  })
}

/**
 * Filter a provider snapshot using the management page's query semantics.
 * @param snapshot - validated records to inspect.
 * @param rawQuery - optional management-page filters.
 * @returns records matching the parsed filters.
 */
export function filterMemoryItems(snapshot: readonly MemoryItem[], rawQuery: MemoryQuery = {}): readonly MemoryItem[] {
  const query = memoryQuerySchema.parse(rawQuery)
  const text = query.text?.trim().toLocaleLowerCase()
  const at = query.at ?? Date.now()
  return snapshot.filter((item) => {
    if (!query.includeForgotten && item.recallState === 'forgotten') return false
    if (query.kind !== undefined && item.kind !== query.kind) return false
    if (query.scopeKind !== undefined && item.scope.kind !== query.scopeKind) return false
    if (query.pinnedOnly && !item.pinned) return false
    if (query.minRecallability !== undefined && memoryRecallabilityAt(item, at) < query.minRecallability) return false
    if (query.at !== undefined && memoryValidityAt(item, at) !== 'current') return false
    if (text !== undefined && text.length > 0) {
      const body = `${item.content}\n${item.applicability ?? ''}`.toLocaleLowerCase()
      if (!body.includes(text)) return false
    }
    return true
  })
}
