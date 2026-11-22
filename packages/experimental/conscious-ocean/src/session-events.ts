/** Durable Session events for request-level Context Activation observation. */

import type { SessionId, SessionSeq, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type {
  ActivationRequestId,
  ActivationRequestKind,
  ActivationTrace,
  ActivationTraceEvent,
  ActivationTraceId,
  ContextManifest,
} from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Starts one logical request-level Activation Trace; log-only. */
    'cognition/trace-start': CognitionTraceStartEvent
    /** Carries one bounded batch of redacted activation decisions; log-only. */
    'cognition/activation-batch': CognitionActivationBatchEvent
    /** Records an AgentLoop-owned model request attempt for an attached Manifest; log-only. */
    'cognition/request-submitted': CognitionRequestSubmittedEvent
    /** Closes one Activation Trace and optionally records its prepared Manifest; log-only. */
    'cognition/trace-end': CognitionTraceEndEvent
  }
}

/** Durable request identity and route-independent trace start facts. */
export interface CognitionTraceStartEvent {
  readonly traceId: ActivationTraceId
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
}

/** One bounded batch of activation events, preserving local event order. */
export interface CognitionActivationBatchEvent {
  readonly traceId: ActivationTraceId
  readonly requestId: ActivationRequestId
  readonly batchSeq: number
  readonly sessionWatermark: SessionSeqCursor
  readonly events: readonly ActivationTraceEvent[]
}

/** Explicit request-owner signal emitted when AgentLoop dispatches a marked request. */
export interface CognitionRequestSubmittedEvent {
  readonly traceId: ActivationTraceId
  readonly requestId: ActivationRequestId
  readonly sessionId: SessionId
  readonly agentScope: string
  readonly turn: number
  readonly step: number
  /** Dense request-attempt number within this logical Trace. */
  readonly requestAttempt: number
  readonly requestKind: ActivationRequestKind
  readonly requestOwner: 'dsh-agent-loop'
  readonly requestHeaderSeq?: SessionSeq
  readonly contextEventSeqs: readonly SessionSeq[]
}

/** One submitted request attempt and its durable Session settlement, when available. */
export interface CognitionRequestAttempt {
  readonly requestAttempt: number
  readonly submissionEventSeq: SessionSeq
  readonly settlementEventSeq?: SessionSeq
  readonly settlementType?: 'assistant/message' | 'assistant/attempt'
}

/** Durable trace completion facts and the prepared Context Manifest, when available. */
export interface CognitionTraceEndEvent {
  readonly traceId: ActivationTraceId
  readonly requestId: ActivationRequestId
  readonly status: ActivationTrace['status']
  readonly sessionWatermark: SessionSeqCursor
  readonly coverage: ActivationTrace['coverage']
  readonly manifest?: ContextManifest
  readonly requestHeaderSeq?: SessionSeq
  readonly contextEventSeqs?: readonly SessionSeq[]
  readonly requestAttempts?: readonly CognitionRequestAttempt[]
  readonly assistantEventSeq?: SessionSeq
  /** The last failed attempt settlement, retained for the single-attempt view. */
  readonly attemptEventSeq?: SessionSeq
  /** Every failed attempt settlement for this logical request, in append order. */
  readonly attemptEventSeqs?: readonly SessionSeq[]
  /** Number of settled adapter attempts, including a final assistant message. */
  readonly attemptCount?: number
}
