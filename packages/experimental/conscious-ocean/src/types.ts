/** Stable data contracts for the optional Conscious Ocean capability. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Stable identity of one shared cognitive source. */
export type CognitiveSourceId = Branded<'AevoraCognitiveSourceId'>

/** Brand a validated cognitive source identity. */
export function CognitiveSourceId(value: string): CognitiveSourceId {
  return value as CognitiveSourceId
}

/** Stable identity of one Activation Trace. */
export type ActivationTraceId = Branded<'AevoraActivationTraceId'>

/** Brand a validated Activation Trace identity. */
export function ActivationTraceId(value: string): ActivationTraceId {
  return value as ActivationTraceId
}

/** Stable identity of one logical request prepared by Context Activation. */
export type ActivationRequestId = Branded<'AevoraActivationRequestId'>

/** Brand a validated logical request identity. */
export function ActivationRequestId(value: string): ActivationRequestId {
  return value as ActivationRequestId
}

/** Stable identity of one Context Manifest. */
export type ContextManifestId = Branded<'AevoraContextManifestId'>

/** Brand a validated Context Manifest identity. */
export function ContextManifestId(value: string): ContextManifestId {
  return value as ContextManifestId
}

/** A durable source reference supporting a Memory or cognitive node. */
export interface SourceEvidence {
  readonly sourceKind: 'user-confirmation' | 'session-event' | 'external' | 'unknown'
  readonly sessionId?: SessionId
  readonly eventSeq?: SessionSeq
  readonly externalSourceId?: string
  readonly capturedThroughSeq?: SessionSeq
  readonly observedAt?: number
}

/** A logical cognitive region such as Identity, Memory, or Session. */
export interface CognitiveRegion {
  readonly regionId: CognitiveSourceId
  readonly kind: string
  readonly label: string
  readonly visibility: 'visible' | 'restricted' | 'unavailable'
  readonly layoutAnchor?: readonly [number, number, number]
  readonly layoutVersion?: number
}

/** A stable semantic neighborhood inside a region. */
export interface CognitiveNeighborhood {
  readonly neighborhoodId: CognitiveSourceId
  readonly regionId: CognitiveSourceId
  readonly label: string
  readonly memberRefs: readonly CognitiveSourceId[]
}

/** Evidence level for a projected object or a displayed state. */
export type ProvenanceStatus = 'observed' | 'derived' | 'estimated' | 'simulated' | 'unavailable'

/** One node displayed in the shared cognitive map. */
export interface CognitiveNode {
  readonly sourceId: CognitiveSourceId
  readonly kind: string
  readonly regionId: CognitiveSourceId
  readonly neighborhoodId?: CognitiveSourceId
  readonly revision: number
  readonly state: string
  readonly provenanceStatus: ProvenanceStatus
  /** Human-readable title supplied by the source provider when available. */
  readonly title?: string
  readonly summary?: string
  /** Human-readable ownership scope for Memory-backed nodes. */
  readonly scope?: string
  /** Source evidence retained for read-only inspection. */
  readonly evidence?: readonly SourceEvidence[]
  /** Memory validity state when the source provider exposes it. */
  readonly validityState?: string
  /** Memory storage tier when the source provider exposes it. */
  readonly storageTier?: string
  /** Memory recall state when the source provider exposes it. */
  readonly recallState?: string
  /** Memory deletion state when the source provider exposes it. */
  readonly deletionState?: string
  /** Memory admission state when the source provider exposes it. */
  readonly admissionState?: string
  /** Memory epistemic state when the source provider exposes it. */
  readonly epistemicState?: string
}

/** A visible, evidence-backed relation between two cognitive sources. */
export interface CognitiveRelation {
  readonly relationId: CognitiveSourceId
  readonly fromId: CognitiveSourceId
  readonly toId: CognitiveSourceId
  readonly kind: 'supports' | 'related_to' | 'contradicts' | 'supersedes' | 'derived_from' | 'temporal_next' | 'depends_on'
  readonly evidence: readonly SourceEvidence[]
  readonly provenanceStatus: ProvenanceStatus
  readonly visibility: 'visible' | 'restricted' | 'unavailable'
}

/** Root-scoped, cross-Session read model for the static cognitive map. */
export interface CognitiveWorldSnapshot {
  /** Renderer-neutral world contract version. */
  readonly schemaVersion: 1
  readonly worldVersion: number
  readonly capturedThroughSeq?: SessionSeq
  readonly regions: readonly CognitiveRegion[]
  readonly neighborhoods: readonly CognitiveNeighborhood[]
  readonly nodes: readonly CognitiveNode[]
  readonly relations: readonly CognitiveRelation[]
}

/** Whether the trace belongs to a main conversation call or a Compaction helper call. */
export type ActivationRequestKind = 'main' | 'compaction'

/** Coverage state for one independently observed activation phase. */
export type ActivationCoverage = 'complete' | 'partial' | 'not_instrumented' | 'unavailable'

/** Lifecycle state of one Activation Trace. */
export type ActivationTraceStatus =
  | 'forming'
  | 'prepared'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected_before_dispatch'
  | 'unknown'

/** Stable stages that can be rendered and replayed when evidence exists. */
export type ActivationStage =
  | 'activation.started'
  | 'activation.frame_ready'
  | 'activation.candidates_found'
  | 'activation.candidate_assessed'
  | 'activation.relation_expanded'
  | 'activation.candidate_filtered'
  | 'activation.budget_selected'
  | 'activation.compiled'
  | 'activation.validated'
  | 'activation.submitted'
  | 'activation.completed'
  | 'activation.failed'
  | 'activation.cancelled'

/** State of one candidate as it moves through activation. */
export type ActivationCandidateState = 'discovered' | 'denied' | 'assessed' | 'activated' | 'selected' | 'omitted' | 'compiled' | 'attached' | 'submitted'

/** One redacted, replayable Activation Trace event. */
export interface ActivationTraceEvent {
  readonly traceId: ActivationTraceId
  readonly eventSeq: number
  readonly time: number
  readonly stage: ActivationStage
  readonly candidateState?: ActivationCandidateState
  readonly sourceRefs: readonly CognitiveSourceId[]
  readonly reasonCode?: string
  readonly policyVersion: string
  readonly sessionSeq?: SessionSeq
  readonly data?: JsonValue
}

/** One complete, replayable logical Activation Trace. */
export interface ActivationTrace {
  readonly traceId: ActivationTraceId
  readonly schemaVersion: 1
  readonly requestId: ActivationRequestId
  readonly sessionId: SessionId
  readonly agentScope: string
  readonly turn: number
  readonly step: number
  readonly attempt: number
  readonly requestKind: ActivationRequestKind
  readonly policyVersion: string
  readonly compilerVersion: string
  readonly sessionWatermark: SessionSeqCursor
  readonly status: ActivationTraceStatus
  readonly coverage: {
    readonly sourceSnapshot: ActivationCoverage
    readonly candidateDecisions: ActivationCoverage
    readonly finalContext: ActivationCoverage
  }
  readonly events: readonly ActivationTraceEvent[]
  readonly manifest?: ContextManifest
}

/** One ordered fragment in a Context Manifest. */
export interface ContextFragment {
  readonly fragmentId: string
  readonly order: number
  readonly sourceRefs: readonly CognitiveSourceId[]
  readonly sourceRevision: number
  readonly targetSection: string
  readonly estimatedTokens?: number
  readonly actualTokens?: number
  readonly compiled: boolean
  readonly contentEvidence: 'observed' | 'derived' | 'unavailable'
  readonly attached: 'yes' | 'no' | 'unknown'
  readonly submitted: 'yes' | 'no' | 'unknown'
  readonly sourceEventSeqs?: readonly SessionSeq[]
}

/** One candidate omitted by the Context Compiler with a durable reason. */
export interface ContextOmission {
  readonly sourceRefs: readonly CognitiveSourceId[]
  readonly reasonCode: string
  readonly estimatedTokens?: number
}

/** The actual ordered source list produced by Context Packing. */
export interface ContextManifest {
  readonly manifestId: ContextManifestId
  readonly traceId: ActivationTraceId
  readonly sessionId: SessionId
  readonly sessionWatermark: SessionSeqCursor
  readonly policyVersion: string
  readonly compilerVersion: string
  readonly budgetTokens: number
  readonly status: 'prepared' | 'submitted' | 'unknown'
  readonly fragments: readonly ContextFragment[]
  readonly omissions?: readonly ContextOmission[]
}

/** Session-owned view consumed by the right Sidebar plugin. */
export interface ConsciousOceanSessionView {
  readonly sessionId: SessionId
  readonly selectedTraceId?: ActivationTraceId
  readonly traceStatus: ActivationTraceStatus
  readonly latestManifest?: ContextManifest
  readonly latestEvents: readonly ActivationTraceEvent[]
  readonly provenanceStatus: ProvenanceStatus
}

/** Read-only Session Projection view derived from existing DSH events. */
export interface ConsciousOceanSessionProjectionView {
  readonly sessionId: SessionId
  readonly observedSeq: SessionSeqCursor
  readonly eventCount: number
  readonly modelVisibleEventCount: number
  readonly requestEventCount: number
  readonly compactionEventCount: number
  readonly turnsStarted: number
  readonly turnsEnded: number
  readonly lastTurn: number | null
  readonly lastStep: number | null
  readonly lastCategory: string
  readonly activationEventCount: number
  readonly activationTraceCount: number
  readonly latestTraceId: ActivationTraceId | null
  readonly latestTraceStatus: ActivationTraceStatus | null
  readonly latestManifestId: ContextManifestId | null
  readonly activationEvidence: 'complete' | 'partial' | 'unavailable'
}
