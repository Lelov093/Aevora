/** Deterministic, keyless Context Activation baseline for confirmed Memory. */

import {
  exponentialRetentionScore,
  memoryRecallabilityAt, memoryValidityAt,
  type MemoryItem, type MemoryKind, type MemoryProvider, type MemoryScope,
} from '@deepseek-ai/dsh-experimental-memory'
import type { SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import {
  ActivationRequestId,
  ActivationTraceId,
  CognitiveSourceId,
  ContextManifestId,
  type ActivationRequestKind,
  type ActivationTrace,
  type ActivationTraceEvent,
  type ContextManifest,
} from './types.ts'
import { activationTraceSchema, contextManifestSchema } from './schema.ts'
import { compileContextManifest } from './context-compiler.ts'

/** Input frame for deterministic confirmed-Memory candidate selection. */
export interface DeterministicMemoryActivationRequest {
  readonly sessionId: SessionId
  readonly requestId: string
  readonly agentScope: string
  readonly turn: number
  readonly step: number
  readonly attempt: number
  readonly requestKind?: ActivationRequestKind
  readonly sessionWatermark: SessionSeqCursor
  readonly scope: MemoryScope
  readonly budgetTokens: number
  readonly maxCandidates?: number
  readonly allowedKinds?: readonly MemoryKind[]
  /** Minimum read-time recall accessibility for a candidate. */
  readonly minimumRecallability?: number
  readonly policyVersion?: string
  readonly compilerVersion?: string
  readonly now?: number
  /** Optional explicit accessibility recipe used only when an Aevora policy opts in. */
  readonly accessibilityPolicy?: MemoryAccessibilityPolicy
  readonly traceId?: string
  readonly estimateTokens?: (item: MemoryItem) => number
}

/** Explicit Context Activation accessibility recipe. */
export type MemoryAccessibilityPolicy =
  | { readonly kind: 'deterministic-v0.1' }
  | { readonly kind: 'exponential-v1'; readonly timeConstantMs: number; readonly calibrationRef?: string }

/** Result of one deterministic Memory-only activation preparation. */
export interface DeterministicMemoryActivationResult {
  readonly trace: ActivationTrace
  readonly manifest: ContextManifest
  /** Selected records retained in-process for an optional model-visible attachment; never persisted in cognition events. */
  readonly selectedItems: readonly MemoryItem[]
}

interface Candidate {
  readonly item: MemoryItem
  readonly sourceId: ReturnType<typeof CognitiveSourceId>
  readonly estimatedTokens: number
  readonly recallability: number
  readonly accessibilityScore?: number
}

const DEFAULT_POLICY_VERSION = 'memory-activation-deterministic-v0.1'
const DEFAULT_COMPILER_VERSION = 'memory-context-manifest-v0.1'

/** Convert a confirmed Memory identity into a stable cognitive source identity. */
export function memorySourceId(memoryId: MemoryItem['memoryId']): ReturnType<typeof CognitiveSourceId> {
  return CognitiveSourceId(`memory:${String(memoryId)}`)
}

function estimateMemoryTokens(item: MemoryItem): number {
  const text = `${item.content}\n${item.applicability ?? ''}`
  return Math.max(1, Math.ceil(text.length / 4))
}

function scopeMatches(item: MemoryItem, scope: MemoryScope): boolean {
  if (item.scope.kind === 'user' || scope.kind === 'user') return item.scope.kind === scope.kind
  return item.scope.id === scope.id
}

function compareCandidates(left: Candidate, right: Candidate, policy: MemoryAccessibilityPolicy): number {
  const accessibility = policy.kind === 'exponential-v1'
    ? (right.accessibilityScore ?? 0) - (left.accessibilityScore ?? 0)
    : 0
  return accessibility
    || Number(right.item.pinned) - Number(left.item.pinned)
    || (right.item.importance ?? 0.5) - (left.item.importance ?? 0.5)
    || right.recallability - left.recallability
    || right.item.updatedAt - left.item.updatedAt
    || String(left.item.memoryId).localeCompare(String(right.item.memoryId))
}

function accessibilityScore(item: MemoryItem, time: number, policy: MemoryAccessibilityPolicy): number | undefined {
  if (policy.kind === 'deterministic-v0.1') return undefined
  const elapsedMs = Math.max(0, time - item.updatedAt)
  return exponentialRetentionScore({ elapsedMs }, policy.timeConstantMs)
}

function policyData(policy: MemoryAccessibilityPolicy): Record<string, string | number> {
  return policy.kind === 'deterministic-v0.1'
    ? { accessibilityModel: policy.kind }
    : {
      accessibilityModel: policy.kind,
      timeConstantMs: policy.timeConstantMs,
      ...(policy.calibrationRef === undefined ? {} : { calibrationRef: policy.calibrationRef }),
    }
}

function event(
  traceId: ReturnType<typeof ActivationTraceId>,
  eventSeq: number,
  time: number,
  stage: ActivationTraceEvent['stage'],
  policyVersion: string,
  sourceRefs: readonly ReturnType<typeof CognitiveSourceId>[] = [],
  extra: Partial<Pick<ActivationTraceEvent, 'candidateState' | 'reasonCode' | 'sessionSeq' | 'data'>> = {},
): ActivationTraceEvent {
  return {
    traceId, eventSeq, time, stage, sourceRefs, policyVersion,
    ...(extra.candidateState === undefined ? {} : { candidateState: extra.candidateState }),
    ...(extra.reasonCode === undefined ? {} : { reasonCode: extra.reasonCode }),
    ...(extra.sessionSeq === undefined ? {} : { sessionSeq: extra.sessionSeq }),
    ...(extra.data === undefined ? {} : { data: extra.data }),
  }
}

/**
 * Select confirmed Memory records with stable scope, state, ordering, and budget rules.
 *
 * This function prepares a Manifest only. It does not inject model-visible content,
 * call an LLM, append Session events, or claim provider submission.
 *
 * @param provider - confirmed Memory provider supplying the candidate snapshot.
 * @param request - deterministic request frame and budget.
 * @returns a validated prepared trace and manifest.
 */
export function prepareDeterministicMemoryActivation(
  provider: MemoryProvider,
  request: DeterministicMemoryActivationRequest,
): DeterministicMemoryActivationResult {
  if (!Number.isInteger(request.budgetTokens) || request.budgetTokens < 0) {
    throw new RangeError('Memory activation budgetTokens must be a non-negative integer')
  }
  if (!Number.isInteger(request.maxCandidates ?? 0) && request.maxCandidates !== undefined) {
    throw new RangeError('Memory activation maxCandidates must be an integer')
  }
  if (request.maxCandidates !== undefined && request.maxCandidates < 0) {
    throw new RangeError('Memory activation maxCandidates must be non-negative')
  }
  if (request.minimumRecallability !== undefined
    && (!Number.isFinite(request.minimumRecallability) || request.minimumRecallability < 0 || request.minimumRecallability > 1)) {
    throw new RangeError('Memory activation minimumRecallability must be between 0 and 1')
  }
  const traceId = ActivationTraceId(request.traceId ?? `trace:${request.requestId}`)
  const requestId = ActivationRequestId(request.requestId)
  const policyVersion = request.policyVersion ?? DEFAULT_POLICY_VERSION
  const compilerVersion = request.compilerVersion ?? DEFAULT_COMPILER_VERSION
  const time = request.now ?? 0
  const accessibilityPolicy = request.accessibilityPolicy ?? { kind: 'deterministic-v0.1' as const }
  const requestKind = request.requestKind ?? 'main'
  const estimate = request.estimateTokens ?? estimateMemoryTokens
  const allowedKinds = request.allowedKinds === undefined ? undefined : new Set(request.allowedKinds)
  const all = provider.list({ includeForgotten: true })
  const byId = new Map(all.map(item => [String(item.memoryId), item]))
  const sourceRefs = all.map(item => memorySourceId(item.memoryId))
  const events: ActivationTraceEvent[] = [
    event(traceId, 1, time, 'activation.started', policyVersion, [], {
      data: { requestKind, budgetTokens: request.budgetTokens, ...policyData(accessibilityPolicy) },
    }),
    event(traceId, 2, time, 'activation.frame_ready', policyVersion, [], {
      data: { scope: request.scope.kind },
    }),
    event(traceId, 3, time, 'activation.candidates_found', policyVersion, sourceRefs, {
      candidateState: 'discovered',
      data: { count: sourceRefs.length, source: 'confirmed-memory-snapshot' },
    }),
  ]
  const eligible: Candidate[] = []
  let sequence = events.length
  for (const item of all) {
    const sourceId = memorySourceId(item.memoryId)
    const effectiveValidity = memoryValidityAt(item, time)
    const recallability = memoryRecallabilityAt(item, time)
    const deniedReason = item.admissionState !== 'accepted'
      ? 'memory-not-accepted'
      : item.recallState !== 'enabled'
        ? 'memory-forgotten'
        : item.deletionState !== 'active'
          ? 'memory-not-active'
          : effectiveValidity !== 'current'
            ? effectiveValidity === 'not-yet-valid' ? 'memory-not-yet-valid' : `memory-${effectiveValidity}`
            : !scopeMatches(item, request.scope)
              ? 'scope-mismatch'
              : allowedKinds !== undefined && !allowedKinds.has(item.kind)
                ? 'kind-not-allowed'
                : request.minimumRecallability !== undefined && recallability < request.minimumRecallability
                  ? 'memory-faded'
                  : undefined
    sequence += 1
    if (deniedReason !== undefined) {
      events.push(event(traceId, sequence, time, 'activation.candidate_assessed', policyVersion, [sourceId], {
        candidateState: 'denied', reasonCode: deniedReason,
      }))
      continue
    }
    const estimatedTokens = estimate(item)
    if (!Number.isInteger(estimatedTokens) || estimatedTokens < 0) {
      throw new RangeError(`Memory activation estimate for '${String(item.memoryId)}' must be a non-negative integer`)
    }
    const score = accessibilityScore(item, time, accessibilityPolicy)
    events.push(event(traceId, sequence, time, 'activation.candidate_assessed', policyVersion, [sourceId], {
      candidateState: 'assessed', reasonCode: 'scope-and-state-match', data: {
        estimatedTokens, importance: item.importance ?? 0.5, recallability,
        ...(score === undefined ? {} : { accessibilityScore: score, ...policyData(accessibilityPolicy) }),
      },
    }))
    eligible.push({ item, sourceId, estimatedTokens, recallability, ...(score === undefined ? {} : { accessibilityScore: score }) })
  }
  eligible.sort((left, right) => compareCandidates(left, right, accessibilityPolicy))
  const activeIds = new Set(eligible.map(candidate => String(candidate.item.memoryId)))
  const blockedByConflict = new Set<string>()
  for (const candidate of eligible) {
    for (const relation of candidate.item.relations ?? []) {
      const target = byId.get(String(relation.targetMemoryId))
      if (target === undefined || !activeIds.has(String(target.memoryId))) continue
      const targetSourceId = memorySourceId(target.memoryId)
      sequence += 1
      events.push(event(traceId, sequence, time, 'activation.relation_expanded', policyVersion, [candidate.sourceId, targetSourceId], {
        data: { relationKind: relation.kind, targetMemoryId: String(target.memoryId) },
      }))
      if (relation.kind !== 'contradicts') continue
      const targetCandidate = eligible.find(value => value.item.memoryId === target.memoryId)
      if (targetCandidate === undefined || compareCandidates(candidate, targetCandidate, accessibilityPolicy) <= 0) continue
      blockedByConflict.add(String(candidate.item.memoryId))
      sequence += 1
      events.push(event(traceId, sequence, time, 'activation.candidate_filtered', policyVersion, [candidate.sourceId, targetSourceId], {
        candidateState: 'denied', reasonCode: `conflict-with:${String(target.memoryId)}`,
      }))
    }
  }
  const activated = eligible.filter(candidate => !blockedByConflict.has(String(candidate.item.memoryId)))
  for (const candidate of activated) {
    sequence += 1
    events.push(event(traceId, sequence, time, 'activation.candidate_assessed', policyVersion, [candidate.sourceId], {
      candidateState: 'activated', reasonCode: 'activation-policy-passed',
    }))
  }
  const selected: Candidate[] = []
  const omitted: Candidate[] = []
  let usedTokens = 0
  for (const candidate of activated) {
    const atLimit = request.maxCandidates !== undefined && selected.length >= request.maxCandidates
    if (!atLimit && usedTokens + candidate.estimatedTokens <= request.budgetTokens) {
      selected.push(candidate)
      usedTokens += candidate.estimatedTokens
    } else {
      omitted.push(candidate)
    }
  }
  sequence += 1
  events.push(event(traceId, sequence, time, 'activation.budget_selected', policyVersion, selected.map(candidate => candidate.sourceId), {
    candidateState: 'selected',
    data: { estimatedTokens: usedTokens, budgetTokens: request.budgetTokens },
  }))
  for (const candidate of omitted) {
    sequence += 1
    events.push(event(traceId, sequence, time, 'activation.candidate_filtered', policyVersion, [candidate.sourceId], {
      candidateState: 'omitted', reasonCode: request.maxCandidates !== undefined && selected.length >= request.maxCandidates
        ? 'candidate-limit'
        : 'budget-exceeded',
    }))
  }
  const manifestId = ContextManifestId(`manifest:${request.requestId}`)
  const omittedReasons = omitted.map(candidate => ({
    sourceId: candidate.sourceId,
    estimatedTokens: candidate.estimatedTokens,
    reasonCode: request.maxCandidates !== undefined && selected.length >= request.maxCandidates
      ? 'candidate-limit'
      : 'budget-exceeded',
  }))
  sequence += 1
  const manifest = compileContextManifest({
    manifestId,
    traceId,
    sessionId: request.sessionId,
    sessionWatermark: request.sessionWatermark,
    policyVersion,
    compilerVersion,
    budgetTokens: request.budgetTokens,
    selected,
    omitted: omittedReasons,
  })
  events.push(event(traceId, sequence, time, 'activation.compiled', policyVersion, selected.map(candidate => candidate.sourceId), {
    candidateState: 'compiled', data: { manifestId: String(manifestId), fragmentCount: manifest.fragments.length, omissionCount: manifest.omissions?.length ?? 0 },
  }))
  sequence += 1
  events.push(event(traceId, sequence, time, 'activation.validated', policyVersion, selected.map(candidate => candidate.sourceId), {
    data: { permission: 'passed', budget: 'passed', sessionWatermark: request.sessionWatermark },
  }))
  const trace: ActivationTrace = {
    traceId,
    schemaVersion: 1,
    requestId,
    sessionId: request.sessionId,
    agentScope: request.agentScope,
    turn: request.turn,
    step: request.step,
    attempt: request.attempt,
    requestKind,
    policyVersion,
    compilerVersion,
    sessionWatermark: request.sessionWatermark,
    status: 'prepared',
    coverage: { sourceSnapshot: 'complete', candidateDecisions: 'complete', finalContext: 'partial' },
    events,
    manifest,
  }
  activationTraceSchema.parse(trace)
  contextManifestSchema.parse(manifest)
  return { trace, manifest, selectedItems: selected.map(candidate => candidate.item) }
}
