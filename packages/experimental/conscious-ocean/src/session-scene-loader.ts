/** Fold one persisted Session log into the read faces consumed by the scene owner. */

import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import { consciousOceanSessionProjectionDefinition, consciousOceanSessionProjectionView } from './projection.ts'
import type { OceanTurnOverlay } from './scene-projection.ts'
import './session-events.ts'
import type { ConsciousOceanSessionProjectionView } from './types.ts'

interface TraceFold {
  readonly sessionId: ReturnType<typeof SessionId>
  readonly traceId: OceanTurnOverlay['traceId']
  status: OceanTurnOverlay['status']
  events: OceanTurnOverlay['events']
  manifest: OceanTurnOverlay['manifest']
  lastSeq: number
}

/** The Session and Trace read faces needed to build one Scene Projection. */
export interface SessionSceneProjectionInput {
  readonly session: ConsciousOceanSessionProjectionView
  readonly trace?: OceanTurnOverlay
}

/**
 * Fold an ordered or unordered persisted Session event list into Session and Trace read faces.
 * The function never creates activation evidence; it only copies durable cognition events.
 * @param header - persisted Session header.
 * @param events - persisted Session events from one Session log.
 * @returns the read faces consumed by {@link createSessionSceneProjectionOwner}.
 */
export function loadSessionSceneProjection(
  header: SessionHeader,
  events: readonly SessionEvent[],
): SessionSceneProjectionInput {
  const ordered = [...events].sort((left, right) => Number(left.seq) - Number(right.seq))
  let state = consciousOceanSessionProjectionDefinition.init(header)
  const traces = new Map<string, TraceFold>()
  for (const event of ordered) {
    state = consciousOceanSessionProjectionDefinition.apply(state, event)
    switch (event.type) {
      case 'cognition/trace-start':
        traces.set(String(event.data.traceId), {
          sessionId: event.data.sessionId,
          traceId: event.data.traceId,
          status: 'forming',
          events: [],
          manifest: undefined,
          lastSeq: Number(event.seq),
        })
        break
      case 'cognition/activation-batch': {
        const trace = traces.get(String(event.data.traceId))
        if (trace === undefined) break
        trace.events = [...trace.events, ...event.data.events]
        trace.lastSeq = Number(event.seq)
        break
      }
      case 'cognition/request-submitted': {
        const trace = traces.get(String(event.data.traceId))
        if (trace === undefined) break
        trace.status = 'submitted'
        trace.lastSeq = Number(event.seq)
        break
      }
      case 'cognition/trace-end': {
        const trace = traces.get(String(event.data.traceId))
        if (trace === undefined) break
        trace.status = event.data.status
        trace.manifest = event.data.manifest
        trace.lastSeq = Number(event.seq)
        break
      }
      default:
        break
    }
  }
  const latest = [...traces.values()].sort((left, right) => right.lastSeq - left.lastSeq)[0]
  return {
    session: consciousOceanSessionProjectionView(state),
    ...(latest === undefined ? {} : {
      trace: {
        sessionId: latest.sessionId,
        traceId: latest.traceId,
        status: latest.status,
        events: latest.events,
        ...(latest.manifest === undefined ? {} : { manifest: latest.manifest }),
      },
    }),
  }
}
