/** Chat-local adapter for the shared turn rail. */
import { forwardRef, useMemo } from 'react'
import { TurnNavigator as SharedTurnNavigator, type TurnNavigatorHandle } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnRailItem } from './turn-rail-items.ts'
export type { TurnNavigatorHandle } from '@deepseek-ai/dsh-client-ui-primitives'
interface Props {
  readonly items: readonly TurnRailItem[]
  readonly activeTurn: number | null
  readonly busyTurn: number | null
  readonly onNavigate: (item: TurnRailItem) => void
  readonly t: ChatViewSlotProps['t']
}
/** Shared rail with the chat's loaded and unloaded navigation actions. */
export const TurnNavigator = forwardRef<TurnNavigatorHandle, Props>(function TurnNavigator({ items, t, onNavigate, ...props }, ref) {
  const railItems = useMemo(() => items.map(item => ({ turn: item.turn, prompt: item.prompt, response: item.response, loaded: item.anchor.kind === 'loaded' })), [items])
  return <SharedTurnNavigator ref={ref} {...props} items={railItems} labels={{ label: t('chat.turnNavigation.label'), jump: (turn, loaded) => t(loaded ? 'chat.turnNavigation.jump' : 'chat.turnNavigation.jumpLoad', { turn }), turn: turn => t('chat.turnNavigation.turn', { turn }) }} onNavigate={(turn) => { const item = items.find(item => item.turn === turn); if (item) onNavigate(item) }} />
})
