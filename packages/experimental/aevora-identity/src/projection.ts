/** Session Projection for the Aevora role-card snapshot captured at Agent creation. */

import { z } from 'zod'
import { pluginRecordOf, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  ROLE_CARD_SNAPSHOT_RECORD, roleCardSessionSnapshotSchema,
} from './types.ts'

/** Fold state retained by the role-card Projection unit. */
export const roleCardProjectionStateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative().transform(SessionLogOffset),
  snapshot: roleCardSessionSnapshotSchema.nullable(),
}).strict()

/** Internal Projection state for one Session. */
export type RoleCardProjectionState = z.infer<typeof roleCardProjectionStateSchema>

/** Projection definition for role-card Session snapshots. */
export type RoleCardProjectionDefinition = Omit<ProjectionDefinition<'aevoraIdentity', RoleCardProjectionState>, 'wire'> & {
  readonly wire: NonNullable<ProjectionDefinition<'aevoraIdentity', RoleCardProjectionState>['wire']>
}

/** Projection definition for role-card Session snapshots. */
export const roleCardProjection: RoleCardProjectionDefinition = {
  key: 'aevoraIdentity',
  stateVersion: 1,
  stateSchema: roleCardProjectionStateSchema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, snapshot: null }),
  apply: (state, event: SessionEvent) => {
    if (event.seq < state.inheritedEventCount) return state
    const record = pluginRecordOf(event)
    if (record?.type !== ROLE_CARD_SNAPSHOT_RECORD) return state
    const snapshot = roleCardSessionSnapshotSchema.safeParse(record.data)
    return snapshot.success ? { ...state, snapshot: snapshot.data } : state
  },
  wire: {
    summary: false,
    viewSchema: roleCardSessionSnapshotSchema.nullable(),
    view: state => state.snapshot,
  },
}
