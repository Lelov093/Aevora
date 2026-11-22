/** Confirmed Aevora Memory records and their durable validation schemas. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'

/** Stable identity of one Memory record. */
export type MemoryId = Branded<'AevoraMemoryId'>

/**
 * Brand a validated Memory identity.
 * @param value - validated identity text.
 * @returns the branded Memory identity.
 */
export function MemoryId(value: string): MemoryId {
  return value as MemoryId
}

/** Stable identity of one source evidence record. */
export type MemoryEvidenceId = Branded<'AevoraMemoryEvidenceId'>

/**
 * Brand a validated evidence identity.
 * @param value - validated evidence identity text.
 * @returns the branded evidence identity.
 */
export function MemoryEvidenceId(value: string): MemoryEvidenceId {
  return value as MemoryEvidenceId
}

/** Stable identity of one directed relation between Memory records. */
export type MemoryRelationId = Branded<'AevoraMemoryRelationId'>

/**
 * Brand a validated Memory relation identity.
 * @param value - validated relation identity text.
 * @returns the branded relation identity.
 */
export function MemoryRelationId(value: string): MemoryRelationId {
  return value as MemoryRelationId
}

/** Stable identity of one explicit Memory feedback event. */
export type MemoryFeedbackEventId = Branded<'AevoraMemoryFeedbackEventId'>

/**
 * Brand a validated Memory feedback event identity.
 * @param value - validated feedback event identity text.
 * @returns the branded feedback event identity.
 */
export function MemoryFeedbackEventId(value: string): MemoryFeedbackEventId {
  return value as MemoryFeedbackEventId
}

/** First-version Memory kinds admitted by the confirmed path. */
export const memoryKindSchema = z.enum(['fact', 'preference', 'constraint'])
/** Confirmed Memory kinds admitted by the first-version path. */
export type MemoryKind = z.infer<typeof memoryKindSchema>

/** Admission status retained for future candidate workflows. */
export const memoryAdmissionStateSchema = z.enum(['candidate', 'accepted', 'rejected'])
/** Admission status retained for future candidate workflows. */
export type MemoryAdmissionState = z.infer<typeof memoryAdmissionStateSchema>

/** Epistemic status; user confirmation is asserted, not independent verification. */
export const memoryEpistemicStateSchema = z.enum(['asserted', 'observed', 'inferred', 'verified', 'disputed'])
/** Epistemic status; user confirmation is asserted, not independent verification. */
export type MemoryEpistemicState = z.infer<typeof memoryEpistemicStateSchema>

/** Whether a record is current for its scope. */
export const memoryValidityStateSchema = z.enum(['current', 'superseded', 'expired', 'unknown'])
/** Whether a record is current for its scope. */
export type MemoryValidityState = z.infer<typeof memoryValidityStateSchema>

/** Durable placement, independent of truth or recall. */
export const memoryStorageTierSchema = z.enum(['working', 'hot', 'warm', 'cold', 'archive'])
/** Durable placement independent of truth or recall. */
export type MemoryStorageTier = z.infer<typeof memoryStorageTierSchema>

/** Whether the record is eligible for recall. */
export const memoryRecallStateSchema = z.enum(['enabled', 'forgotten'])
/** Whether the record is eligible for recall. */
export type MemoryRecallState = z.infer<typeof memoryRecallStateSchema>

/** Physical deletion lifecycle, independent of forgetting and expiry. */
export const memoryDeletionStateSchema = z.enum(['active', 'delete_pending', 'deleted'])
/** Physical deletion lifecycle independent of forgetting and expiry. */
export type MemoryDeletionState = z.infer<typeof memoryDeletionStateSchema>

/** How long a record remains easy to recall without changing its truth status. */
export const memoryRetentionPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('persistent') }).strict(),
  z.object({
    kind: z.literal('decay'),
    halfLifeMs: z.number().positive(),
    floor: z.number().min(0).max(1).default(0),
  }).strict(),
])
/** Retention policy used only for recall accessibility. */
export type MemoryRetentionPolicy = z.infer<typeof memoryRetentionPolicySchema>

/** Directed relation kinds supported by the first Memory semantic slice. */
export const memoryRelationKindSchema = z.enum([
  'supports', 'contradicts', 'supersedes', 'derived_from', 'related_to',
  'same_entity', 'temporal_next', 'depends_on', 'part_of',
])
/** Directed relation kinds between Memory records. */
export type MemoryRelationKind = z.infer<typeof memoryRelationKindSchema>

/** Explicit ownership scope for one confirmed Memory. */
export const memoryScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('workspace'), id: z.string().min(1) }).strict(),
])
/** Explicit user or workspace ownership scope. */
export type MemoryScope = z.infer<typeof memoryScopeSchema>

/** Source evidence that supports a Memory record. */
export const memoryEvidenceSchema = z.object({
  evidenceId: z.string().regex(/^[A-Za-z0-9_-]+$/).transform(MemoryEvidenceId),
  sourceKind: z.enum(['user-confirmation', 'session-event', 'external', 'unknown']),
  sourceRef: z.string().min(1),
  capturedAt: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative().optional(),
  sessionId: z.string().min(1).transform(value => value as SessionId).optional(),
  eventSeq: z.number().int().nonnegative().transform(value => value as SessionSeq).optional(),
  confirmationMethod: z.literal('explicit-user').optional(),
}).strict().superRefine((evidence, context) => {
  if (evidence.sourceKind === 'user-confirmation' && evidence.confirmationMethod !== 'explicit-user') {
    context.addIssue({ code: 'custom', path: ['confirmationMethod'], message: 'User confirmation evidence must name explicit-user' })
  }
})
/** Source evidence retained with a confirmed Memory record. */
export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>

/** Sources that may produce an affective observation for review. */
export const memoryEmotionSourceSchema = z.enum([
  'explicit-user', 'structured-annotation', 'model-judger', 'rule',
])
/** Source of one affective observation. */
export type MemoryEmotionSource = z.infer<typeof memoryEmotionSourceSchema>

/** Review state for an affective observation that is not a Memory fact. */
export const memoryEmotionReviewStateSchema = z.enum(['candidate', 'accepted', 'rejected'])
/** Review state of one affective observation. */
export type MemoryEmotionReviewState = z.infer<typeof memoryEmotionReviewStateSchema>

/** Affective representations available to the evaluation-first annotation contract. */
export const memoryEmotionRepresentationSchema = z.enum(['valence-arousal', 'dimensional-v1'])
/** Representation used by one affective observation. */
export type MemoryEmotionRepresentation = z.infer<typeof memoryEmotionRepresentationSchema>

const memoryEmotionObservationMetadataSchema = z.object({
  confidence: z.number().min(0).max(1),
  source: memoryEmotionSourceSchema,
  reviewState: memoryEmotionReviewStateSchema,
  sourceRef: z.string().min(1),
  observedAt: z.number().int().nonnegative(),
}).strict()

/** Optional valence-arousal or richer dimensional annotation attached to a Memory record. */
export const memoryEmotionObservationSchema = z.discriminatedUnion('representation', [
  memoryEmotionObservationMetadataSchema.extend({
    representation: z.literal('valence-arousal'),
    valence: z.number().min(-1).max(1),
    arousal: z.number().min(0).max(1),
  }),
  memoryEmotionObservationMetadataSchema.extend({
    representation: z.literal('dimensional-v1'),
    dimensions: z.record(z.string().min(1), z.number().finite()).refine(
      dimensions => Object.keys(dimensions).length > 0,
      'Dimensional affect observations require at least one named dimension',
    ),
  }),
])
/** A provenance-labelled affective observation, separate from Memory truth. */
export type MemoryEmotionObservation = z.infer<typeof memoryEmotionObservationSchema>

/** Temporal precision used by the recommended period-label representation. */
export const memoryTemporalPrecisionSchema = z.enum([
  'instant', 'day', 'week', 'month', 'quarter', 'season', 'year', 'era', 'ongoing', 'unknown',
])
/** Precision of a human-readable temporal period. */
export type MemoryTemporalPrecision = z.infer<typeof memoryTemporalPrecisionSchema>

/** Optional period label that complements explicit validity timestamps. */
export const memoryTemporalContextSchema = z.object({
  label: z.string().min(1),
  precision: memoryTemporalPrecisionSchema,
  timeZone: z.string().min(1).optional(),
  sourceRef: z.string().min(1),
  observedAt: z.number().int().nonnegative(),
}).strict()
/** A provenance-labelled temporal period annotation. */
export type MemoryTemporalContext = z.infer<typeof memoryTemporalContextSchema>

/** Explicit user action that can be replayed as Memory feedback evidence. */
export const memoryFeedbackKindSchema = z.enum([
  'confirm', 'correct', 'forget', 'recall', 'pin', 'unpin', 'reject', 'delete',
])
/** Explicit Memory feedback action kind. */
export type MemoryFeedbackKind = z.infer<typeof memoryFeedbackKindSchema>

/** One immutable feedback event with no derived reinforcement score. */
export const memoryFeedbackEventSchema = z.object({
  eventId: z.string().regex(/^[A-Za-z0-9_-]+$/).transform(MemoryFeedbackEventId),
  kind: memoryFeedbackKindSchema,
  targetRevision: z.number().int().positive(),
  actor: z.literal('user'),
  scope: memoryScopeSchema,
  sourceRef: z.string().min(1),
  occurredAt: z.number().int().nonnegative(),
}).strict()
/** Replayable explicit feedback evidence for one Memory record. */
export type MemoryFeedbackEvent = z.infer<typeof memoryFeedbackEventSchema>

/** A directed, evidence-backed relation to another Memory record. */
export const memoryRelationSchema = z.object({
  relationId: z.string().regex(/^[A-Za-z0-9_-]+$/).transform(MemoryRelationId),
  kind: memoryRelationKindSchema,
  targetMemoryId: z.string().regex(/^[A-Za-z0-9_-]+$/).transform(MemoryId),
  sourceEvidence: z.array(memoryEvidenceSchema).min(1),
  createdAt: z.number().int().nonnegative(),
}).strict()
/** Directed relation between two Memory records. */
export type MemoryRelation = z.infer<typeof memoryRelationSchema>

/** One prior revision retained to explain a correction. */
export const memoryRevisionSchema = z.object({
  revision: z.number().int().positive(),
  kind: memoryKindSchema,
  content: z.string().min(1),
  scope: memoryScopeSchema,
  applicability: z.string().min(1).optional(),
  emotionObservation: memoryEmotionObservationSchema.optional(),
  temporalContext: memoryTemporalContextSchema.optional(),
  feedbackEvents: z.array(memoryFeedbackEventSchema).optional(),
  importance: z.number().min(0).max(1),
  retentionPolicy: memoryRetentionPolicySchema,
  sourceEvidence: z.array(memoryEvidenceSchema).min(1),
  confirmedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  validFrom: z.number().int().nonnegative().optional(),
  validUntil: z.number().int().nonnegative().optional(),
}).strict()
/** Historical revision retained for correction and audit display. */
export type MemoryRevision = z.infer<typeof memoryRevisionSchema>

/** One durable Memory record. */
export const memoryItemSchema = z.object({
  memoryId: z.string().regex(/^[A-Za-z0-9_-]+$/).transform(MemoryId),
  revision: z.number().int().positive(),
  kind: memoryKindSchema,
  content: z.string().min(1),
  scope: memoryScopeSchema,
  applicability: z.string().min(1).optional(),
  emotionObservation: memoryEmotionObservationSchema.optional(),
  temporalContext: memoryTemporalContextSchema.optional(),
  feedbackEvents: z.array(memoryFeedbackEventSchema).optional(),
  admissionState: memoryAdmissionStateSchema,
  epistemicState: memoryEpistemicStateSchema,
  validityState: memoryValidityStateSchema,
  storageTier: memoryStorageTierSchema,
  recallState: memoryRecallStateSchema,
  deletionState: memoryDeletionStateSchema,
  pinned: z.boolean(),
  importance: z.number().min(0).max(1).optional(),
  retentionPolicy: memoryRetentionPolicySchema.optional(),
  relations: z.array(memoryRelationSchema).optional(),
  revisionHistory: z.array(memoryRevisionSchema).optional(),
  sourceEvidence: z.array(memoryEvidenceSchema).min(1),
  confirmedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative().optional(),
  validFrom: z.number().int().nonnegative().optional(),
  validUntil: z.number().int().nonnegative().optional(),
  previousRevision: z.number().int().positive().optional(),
  rejectionReason: z.string().min(1).optional(),
  policyVersion: z.string().min(1),
}).strict().superRefine((item, context) => {
  if (item.admissionState === 'accepted' && item.confirmedAt === undefined) {
    context.addIssue({ code: 'custom', path: ['confirmedAt'], message: 'Accepted Memory requires confirmedAt' })
  }
  if (item.admissionState === 'accepted' && !item.sourceEvidence.some(evidence => (
    evidence.sourceKind === 'user-confirmation' && evidence.confirmationMethod === 'explicit-user'
  ))) {
    context.addIssue({ code: 'custom', path: ['sourceEvidence'], message: 'Accepted Memory requires explicit user-confirmation evidence' })
  }
  if (item.deletionState === 'deleted' && item.recallState !== 'forgotten') {
    context.addIssue({ code: 'custom', path: ['recallState'], message: 'Deleted Memory must be forgotten' })
  }
  const relationIds = new Set<string>()
  for (const relation of item.relations ?? []) {
    if (relation.targetMemoryId === item.memoryId) {
      context.addIssue({ code: 'custom', path: ['relations'], message: 'Memory cannot relate to itself' })
    }
    if (relationIds.has(String(relation.relationId))) {
      context.addIssue({ code: 'custom', path: ['relations'], message: 'Memory relation ids must be unique' })
    }
    relationIds.add(String(relation.relationId))
  }
  const feedbackEventIds = new Set<string>()
  for (const event of item.feedbackEvents ?? []) {
    if (feedbackEventIds.has(String(event.eventId))) {
      context.addIssue({ code: 'custom', path: ['feedbackEvents'], message: 'Memory feedback event ids must be unique' })
    }
    feedbackEventIds.add(String(event.eventId))
    if (event.scope.kind !== item.scope.kind || (event.scope.kind === 'workspace' && item.scope.kind === 'workspace' && event.scope.id !== item.scope.id)) {
      context.addIssue({ code: 'custom', path: ['feedbackEvents'], message: 'Memory feedback event scope must match the record scope' })
    }
  }
  if (item.validFrom !== undefined && item.validUntil !== undefined && item.validUntil < item.validFrom) {
    context.addIssue({ code: 'custom', path: ['validUntil'], message: 'Memory validUntil must be at or after validFrom' })
  }
})
/** Durable validated Memory record. */
export type MemoryItem = z.infer<typeof memoryItemSchema>

/** Input for the explicit user-confirmation creation path. */
export const confirmedMemoryInputSchema = z.object({
  memoryId: z.string().regex(/^[A-Za-z0-9_-]+$/).transform(MemoryId).optional(),
  kind: memoryKindSchema,
  content: z.string().min(1),
  scope: memoryScopeSchema,
  applicability: z.string().min(1).optional(),
  emotionObservation: memoryEmotionObservationSchema.optional(),
  temporalContext: memoryTemporalContextSchema.optional(),
  feedbackEvents: z.array(memoryFeedbackEventSchema).optional(),
  importance: z.number().min(0).max(1).default(0.5),
  retentionPolicy: memoryRetentionPolicySchema.default({ kind: 'persistent' }),
  relations: z.array(memoryRelationSchema).default([]),
  sourceEvidence: z.array(memoryEvidenceSchema).min(1),
  confirmedAt: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative().optional(),
  validFrom: z.number().int().nonnegative().optional(),
  validUntil: z.number().int().nonnegative().optional(),
  pinned: z.boolean().default(false),
  policyVersion: z.string().min(1).default('memory-v1'),
}).strict().superRefine((input, context) => {
  if (!input.sourceEvidence.some(evidence => (
    evidence.sourceKind === 'user-confirmation' && evidence.confirmationMethod === 'explicit-user'
  ))) {
    context.addIssue({ code: 'custom', path: ['sourceEvidence'], message: 'Confirmed Memory requires explicit user-confirmation evidence' })
  }
})
/** Input accepted by the explicit user-confirmation creation path. */
export type ConfirmedMemoryInput = z.input<typeof confirmedMemoryInputSchema>

/** Input for a durable candidate that is not yet an accepted fact. */
export const candidateMemoryInputSchema = z.object({
  memoryId: z.string().regex(/^[A-Za-z0-9_-]+$/).transform(MemoryId).optional(),
  kind: memoryKindSchema,
  content: z.string().min(1),
  scope: memoryScopeSchema,
  applicability: z.string().min(1).optional(),
  emotionObservation: memoryEmotionObservationSchema.optional(),
  temporalContext: memoryTemporalContextSchema.optional(),
  feedbackEvents: z.array(memoryFeedbackEventSchema).optional(),
  importance: z.number().min(0).max(1).default(0.5),
  retentionPolicy: memoryRetentionPolicySchema.default({ kind: 'persistent' }),
  relations: z.array(memoryRelationSchema).default([]),
  sourceEvidence: z.array(memoryEvidenceSchema).min(1),
  observedAt: z.number().int().nonnegative().optional(),
  validFrom: z.number().int().nonnegative().optional(),
  validUntil: z.number().int().nonnegative().optional(),
  policyVersion: z.string().min(1).default('memory-v1'),
}).strict()
/** Input accepted by the candidate creation path. */
export type CandidateMemoryInput = z.input<typeof candidateMemoryInputSchema>

/** Explicit user evidence that promotes a candidate to an accepted record. */
export const memoryConfirmationSchema = z.object({
  sourceEvidence: z.array(memoryEvidenceSchema).min(1),
  confirmedAt: z.number().int().nonnegative(),
}).strict().superRefine((input, context) => {
  if (!input.sourceEvidence.some(evidence => (
    evidence.sourceKind === 'user-confirmation' && evidence.confirmationMethod === 'explicit-user'
  ))) {
    context.addIssue({ code: 'custom', path: ['sourceEvidence'], message: 'Confirmation requires explicit user-confirmation evidence' })
  }
})
/** Input accepted by the explicit candidate confirmation path. */
export type MemoryConfirmation = z.input<typeof memoryConfirmationSchema>

/** Fields a user may edit while preserving the record's identity and evidence. */
export const memoryUpdateSchema = z.object({
  kind: memoryKindSchema.optional(),
  content: z.string().min(1).optional(),
  scope: memoryScopeSchema.optional(),
  applicability: z.string().min(1).nullable().optional(),
  emotionObservation: memoryEmotionObservationSchema.nullable().optional(),
  temporalContext: memoryTemporalContextSchema.nullable().optional(),
  feedbackEvents: z.array(memoryFeedbackEventSchema).optional(),
  importance: z.number().min(0).max(1).optional(),
  retentionPolicy: memoryRetentionPolicySchema.optional(),
  relations: z.array(memoryRelationSchema).optional(),
  recallState: memoryRecallStateSchema.optional(),
  pinned: z.boolean().optional(),
  validFrom: z.number().int().nonnegative().nullable().optional(),
  validUntil: z.number().int().nonnegative().nullable().optional(),
}).strict()
/** Editable fields for a revision-preserving Memory update. */
export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>

/** Read filters used by the future management page and keyless provider. */
export const memoryQuerySchema = z.object({
  text: z.string().optional(),
  kind: memoryKindSchema.optional(),
  scopeKind: z.enum(['user', 'workspace']).optional(),
  includeForgotten: z.boolean().default(false),
  pinnedOnly: z.boolean().default(false),
  at: z.number().int().nonnegative().optional(),
  minRecallability: z.number().min(0).max(1).optional(),
}).strict()
/** Search and management filters for Memory records. */
export type MemoryQuery = z.input<typeof memoryQuerySchema>

/** Effective validity after applying an item's explicit time window. */
export type MemoryEffectiveValidity = MemoryValidityState | 'not-yet-valid'

/**
 * Resolve explicit validity and time bounds without mutating the durable record.
 * @param item - validated Memory record.
 * @param at - timestamp in milliseconds.
 * @returns the effective validity state at the timestamp.
 */
export function memoryValidityAt(item: MemoryItem, at: number): MemoryEffectiveValidity {
  if (item.validityState !== 'current') return item.validityState
  if (item.validFrom !== undefined && at < item.validFrom) return 'not-yet-valid'
  if (item.validUntil !== undefined && at > item.validUntil) return 'expired'
  return 'current'
}

/**
 * Calculate recall accessibility without treating it as truth probability.
 * @param item - validated Memory record.
 * @param at - timestamp in milliseconds.
 * @returns deterministic accessibility in the inclusive zero-to-one range.
 */
export function memoryRecallabilityAt(item: MemoryItem, at: number): number {
  const policy = item.retentionPolicy ?? { kind: 'persistent' as const }
  if (policy.kind === 'persistent') return 1
  const elapsed = Math.max(0, at - item.updatedAt)
  const decayed = Math.pow(0.5, elapsed / policy.halfLifeMs)
  return Math.max(policy.floor, decayed)
}
