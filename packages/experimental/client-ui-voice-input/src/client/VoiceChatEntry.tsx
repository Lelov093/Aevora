/** Continuous voice action for the empty composer's primary button. */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './VoiceInput.module.css'

type VoiceChatEntryProps = PropsRuntime<'conversation.input.empty-action'> & PropsLocale<typeof NS>
  & InjectFace<{ requestChat: () => void }>

/**
 * Render the voice action in the submit position when the composer offers it.
 * @param props - composer sizing, localized label, and the current Session's voice action.
 * @returns The primary voice button.
 */
export function VoiceChatEntry({ className, requestChat, t }: VoiceChatEntryProps) {
  return <Tooltip label={t('chat.open')} side="top" delayMs={500}>
    <button type="button" className={`${className ?? ''} ${css.voicePrimary}`} aria-label={t('chat.open')}
      onMouseDown={(event) => { event.preventDefault() }} onClick={requestChat}>
      <span className={css.chatMark} aria-hidden="true"><span /><span /><span /><span /><span /></span>
    </button>
  </Tooltip>
}
