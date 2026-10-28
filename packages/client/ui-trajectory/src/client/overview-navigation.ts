/** Overview rail facts combine the existing Host outline with loaded trajectory turns. */
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TurnNavigatorItem } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-session-turn-outline/client'
import type { OverviewTurn } from './overview-model.ts'

/** One known turn and the existing history position used to load it. */
export interface OverviewNavigationItem extends TurnNavigatorItem {
  readonly seq: SessionSeq
}

/**
 * Keep unloaded turns navigable without reading their full records.
 * @param turns - Loaded trajectory turn facts.
 * @param outline - Host projection at the wire boundary.
 * @returns Known turns ordered to match the chronological overview.
 */
export function overviewNavigation(turns: readonly OverviewTurn[], outline: unknown): readonly OverviewNavigationItem[] {
  const items = new Map<number, OverviewNavigationItem>()
  const entries: readonly unknown[] = Array.isArray(outline) ? outline : []
  for (const value of entries) {
    if (typeof value !== 'object' || value === null || !('turn' in value) || !('seq' in value)) continue
    const { turn, seq } = value
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0
      || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) continue
    items.set(turn, { turn, seq: SessionSeq(seq), loaded: false,
      prompt: 'prompt' in value && typeof value.prompt === 'string' ? value.prompt : '',
      response: 'response' in value && typeof value.response === 'string' ? value.response : '' })
  }
  for (const turn of turns) {
    if (turn.turn === undefined) continue
    const previous = items.get(turn.turn)
    items.set(turn.turn, { turn: turn.turn, seq: previous?.seq ?? SessionSeq(turn.seq),
      loaded: turn.startedAt !== undefined, prompt: turn.request || previous?.prompt || '',
      response: turn.items.findLast(item => item.kind === 'response')?.text || previous?.response || '' })
  }
  return [...items.values()].sort((left, right) => left.turn - right.turn)
}
