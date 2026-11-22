/** Map existing DSH Session events into the Conscious Ocean read model without inventing activation facts. */

import type { SessionEvent, SessionEventType } from '@deepseek-ai/dsh-session/types'
import './session-events.ts'
import type { ActivationStage } from './types.ts'

/** Broad category used by the current read-only mapping. */
export type SessionEventCategory = 'turn' | 'step' | 'surface' | 'request' | 'tool' | 'activation' | 'compaction' | 'other'

/** Read-only evidence emitted for one existing DSH Session event. */
export interface SessionEventMapping {
  readonly category: SessionEventCategory
  readonly sessionEventType: SessionEventType
  readonly stage?: ActivationStage
  readonly stages?: readonly ActivationStage[]
  readonly modelVisible: boolean
  readonly evidence: 'observed'
  readonly seq: SessionEvent['seq']
  readonly time: number
}

/**
 * Map a durable DSH event to the portion of the Ocean model it can actually prove.
 *
 * Existing request and surface events do not prove candidate scoring, relation
 * expansion, budget selection, compilation, or provider submission. Those stages
 * remain absent until an owning runtime producer records them explicitly.
 *
 * @param event - One committed DSH Session event.
 * @returns A conservative mapping suitable for a read-only projection.
 */
export function mapSessionEvent(event: SessionEvent): SessionEventMapping {
  const base = {
    sessionEventType: event.type,
    modelVisible: false,
    evidence: 'observed' as const,
    seq: event.seq,
    time: event.time,
  }
  const activation = (stage?: ActivationStage, stages?: readonly ActivationStage[]): SessionEventMapping => ({
    ...base,
    category: 'activation',
    ...(stage === undefined ? {} : { stage }),
    ...(stages === undefined ? {} : { stages }),
  })
  switch (event.type) {
    case 'turn/start':
    case 'turn/end':
      return { ...base, category: 'turn' }
    case 'step/start':
    case 'step/end':
      return { ...base, category: 'step' }
    case 'user/message':
    case 'developer/message':
    case 'system/message':
    case 'assistant/message':
    case 'tool/result':
      return { ...base, category: 'surface', modelVisible: true }
    case 'request/header':
    case 'request/context':
      return { ...base, category: 'request' }
    case 'tool/call':
      return { ...base, category: 'tool', modelVisible: true }
    case 'cognition/trace-start':
      return activation('activation.started', ['activation.started'])
    case 'cognition/activation-batch': {
      const stages = [...new Set(event.data.events.map(item => item.stage))]
      return activation(stages.length === 1 ? stages[0] : undefined, stages)
    }
    case 'cognition/request-submitted':
      return activation('activation.submitted', ['activation.submitted'])
    case 'cognition/trace-end': {
      const stage = event.data.status === 'completed'
        ? 'activation.completed'
        : event.data.status === 'failed'
          ? 'activation.failed'
          : event.data.status === 'cancelled'
            ? 'activation.cancelled'
            : undefined
      return activation(stage, stage === undefined ? [] : [stage])
    }
    default:
      if (event.type.startsWith('compaction/')) return { ...base, category: 'compaction' }
      return { ...base, category: 'other' }
  }
}
