/** Latest human admission used by conditional prompt interruption, independent of Client playback. */
import { z } from 'zod'
import { brandNumber } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Host-only conditional admission state, rebuilt from the original native user events. */
export const promptGuard = {
  key: 'promptGuard', stateVersion: 1,
  stateSchema: z.object({ userSeq: z.number().int().nonnegative().transform(brandNumber<SessionSeq>).nullable() }),
  init: () => ({ userSeq: null }),
  apply: (state, event) => event.type === 'user/message' && event.data.source.kind === 'user'
    ? { userSeq: event.seq } : state,
} satisfies ProjectionDefinition<'promptGuard', { readonly userSeq: SessionSeq | null }>
