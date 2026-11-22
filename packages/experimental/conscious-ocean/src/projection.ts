/** Read-only Session Projection derived from existing DSH events. */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import { mapSessionEvent } from './session-event-mapping.ts'
import './session-events.ts'
import { ActivationTraceId, ContextManifestId } from './types.ts'
import type { ActivationTraceStatus, ConsciousOceanSessionProjectionView } from './types.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Current read-only Conscious Ocean Session view. */
    'consciousOcean/session': ConsciousOceanSessionProjectionView
  }
}

/** Fold state for one Session's existing event log. */
export interface ConsciousOceanSessionProjectionState {
  readonly sessionId: string
  readonly observedSeq: number
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
  readonly latestTraceId: string | null
  readonly latestTraceStatus: ActivationTraceStatus | null
  readonly latestManifestId: string | null
  readonly activationEvidence: 'complete' | 'partial' | 'unavailable'
}

const stateSchema = z.object({
  sessionId: z.string(),
  observedSeq: z.number().int().min(-1),
  eventCount: z.number().int().nonnegative(),
  modelVisibleEventCount: z.number().int().nonnegative(),
  requestEventCount: z.number().int().nonnegative(),
  compactionEventCount: z.number().int().nonnegative(),
  turnsStarted: z.number().int().nonnegative(),
  turnsEnded: z.number().int().nonnegative(),
  lastTurn: z.number().int().nonnegative().nullable(),
  lastStep: z.number().int().nonnegative().nullable(),
  lastCategory: z.string(),
  activationEventCount: z.number().int().nonnegative(),
  activationTraceCount: z.number().int().nonnegative(),
  latestTraceId: z.string().nullable(),
  latestTraceStatus: z.enum(['forming', 'prepared', 'submitted', 'completed', 'failed', 'cancelled', 'rejected_before_dispatch', 'unknown']).nullable(),
  latestManifestId: z.string().nullable(),
  activationEvidence: z.enum(['complete', 'partial', 'unavailable']),
}).strict()

const viewSchema = stateSchema.extend({
  sessionId: z.string().transform(SessionId),
  observedSeq: z.number().int().min(-1).transform(value => value === -1 ? -1 : SessionSeq(value)),
  latestTraceId: z.string().nullable().transform(value => value === null ? null : ActivationTraceId(value)),
  latestManifestId: z.string().nullable().transform(value => value === null ? null : ContextManifestId(value)),
})

/** Convert a folded state to the client-facing read-only view. */
export function consciousOceanSessionProjectionView(
  state: ConsciousOceanSessionProjectionState,
): ConsciousOceanSessionProjectionView {
  const observedSeq: SessionSeqCursor = state.observedSeq === -1 ? -1 : SessionSeq(state.observedSeq)
  return {
    ...state,
    sessionId: SessionId(state.sessionId),
    observedSeq,
    latestTraceId: state.latestTraceId === null ? null : ActivationTraceId(state.latestTraceId),
    latestManifestId: state.latestManifestId === null ? null : ContextManifestId(state.latestManifestId),
  }
}

/** Read-only projection definition for existing Session events. */
export const consciousOceanSessionProjectionDefinition = {
  key: 'consciousOcean/session',
  stateVersion: 2,
  stateSchema,
  init: (header: SessionHeader): ConsciousOceanSessionProjectionState => ({
    sessionId: header.id,
    observedSeq: -1,
    eventCount: 0,
    modelVisibleEventCount: 0,
    requestEventCount: 0,
    compactionEventCount: 0,
    turnsStarted: 0,
    turnsEnded: 0,
    lastTurn: null,
    lastStep: null,
    lastCategory: 'other',
    activationEventCount: 0,
    activationTraceCount: 0,
    latestTraceId: null,
    latestTraceStatus: null,
    latestManifestId: null,
    activationEvidence: 'unavailable',
  }),
  apply: (state: ConsciousOceanSessionProjectionState, event: SessionEvent): ConsciousOceanSessionProjectionState => {
    if (event.seq <= state.observedSeq) return state
    const mapping = mapSessionEvent(event)
    let next: ConsciousOceanSessionProjectionState = {
      ...state,
      observedSeq: event.seq,
      eventCount: state.eventCount + 1,
      modelVisibleEventCount: state.modelVisibleEventCount + (mapping.modelVisible ? 1 : 0),
      requestEventCount: state.requestEventCount + (mapping.category === 'request' ? 1 : 0),
      compactionEventCount: state.compactionEventCount + (mapping.category === 'compaction' ? 1 : 0),
      activationEventCount: state.activationEventCount + (mapping.category === 'activation' ? 1 : 0),
      lastCategory: mapping.category,
    }
    switch (event.type) {
      case 'turn/start':
        next = { ...next, turnsStarted: state.turnsStarted + 1, lastTurn: event.data.turn }
        break
      case 'turn/end':
        next = { ...next, turnsEnded: state.turnsEnded + 1, lastTurn: event.data.turn }
        break
      case 'step/start':
      case 'step/end':
        next = { ...next, lastTurn: event.data.turn, lastStep: event.data.step }
        break
      case 'cognition/trace-start':
        next = {
          ...next,
          activationTraceCount: state.activationTraceCount + 1,
          latestTraceId: String(event.data.traceId),
          latestTraceStatus: 'forming',
          activationEvidence: 'partial',
        }
        break
      case 'cognition/activation-batch':
        next = { ...next, latestTraceId: String(event.data.traceId), latestTraceStatus: 'forming', activationEvidence: 'partial' }
        break
      case 'cognition/request-submitted':
        next = { ...next, latestTraceId: String(event.data.traceId), latestTraceStatus: 'submitted', activationEvidence: 'partial' }
        break
      case 'cognition/trace-end':
        next = {
          ...next,
          latestTraceId: String(event.data.traceId),
          latestTraceStatus: event.data.status,
          latestManifestId: event.data.manifest === undefined ? state.latestManifestId : String(event.data.manifest.manifestId),
          activationEvidence: event.data.coverage.sourceSnapshot === 'complete'
            && event.data.coverage.candidateDecisions === 'complete'
            && event.data.coverage.finalContext === 'complete'
            ? 'complete'
            : 'partial',
        }
        break
      default:
        break
    }
    return next
  },
  wire: {
    summary: true,
    viewSchema,
    view: consciousOceanSessionProjectionView,
  },
} satisfies ProjectionDefinition<'consciousOcean/session', ConsciousOceanSessionProjectionState>
