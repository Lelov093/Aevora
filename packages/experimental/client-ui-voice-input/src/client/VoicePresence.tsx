/** Phase indicator for continuous voice in the existing above-composer dock. */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ContinuousState } from './continuous.ts'
import type { NS } from './locales.ts'
import css from './VoiceInput.module.css'

/** Transient voice display for the active Session. */
export interface VoicePresenceState {
  readonly sessionId: SessionId
  readonly phase: ContinuousState['phase']
  readonly text: string
}

type VoiceDisplayFace = InjectFace<{ hooks: { voicePresence: HostObservable<VoicePresenceState | null> } }>
type VoicePresenceProps = Pick<PropsRuntime<'conversation.input.dock'>, 'sessionId'> & PropsLocale<typeof NS>
  & VoiceDisplayFace
type VoiceTranscriptProps = Pick<PropsRuntime<'conversation.input.preview'>, 'sessionId'> & PropsLocale<typeof NS>
  & VoiceDisplayFace

const listening = [3, 4, 6, 10, 17, 12, 8, 15, 25, 34, 28, 16, 8, 12, 18, 12, 6, 4, 3]
const answering = [3, 5, 9, 18, 29, 34, 23, 12, 18, 31, 37, 24, 12, 20, 24, 17, 9, 5, 3]
const preparing = [2, 2, 3, 3, 4, 5, 7, 11, 15, 20, 15, 11, 7, 5, 4, 3, 3, 2, 2]
const paused = Array.from({ length: listening.length }, () => 3)
const barsByPhase = {
  listening,
  answering,
  preparing,
  deciding: preparing,
  finishing: preparing,
  paused,
} satisfies Record<ContinuousState['phase'], readonly number[]>

/**
 * Present the current Session's voice phase as a labelled waveform silhouette.
 * @param props - Session identity, local copy and the phase selector.
 * @returns the dock indicator while voice controls are mounted, otherwise null.
 */
export function VoicePresence({ sessionId, useVoicePresence, t }: VoicePresenceProps) {
  const phase = useVoicePresence(presence => presence?.sessionId === sessionId ? presence.phase : null)
  if (phase === null) return null
  return <div className={css.voicePresence} data-voice-presence={phase}>
    <svg className={css.presenceWave} viewBox="0 0 210 44" aria-hidden="true">
      {barsByPhase[phase].map((height, index) => <line key={index} x1={15 + index * 10} x2={15 + index * 10}
        y1={22 - height / 2} y2={22 + height / 2} opacity={0.52 + 0.48 * height / 37} />)}
    </svg>
    <span role="status">{t(`continuous.${phase}`)}</span>
  </div>
}

/**
 * Show the current utterance inside the composer without editing the draft.
 * @param props - Session identity, localized label, and the voice display selector.
 * @returns Preview text during recognition, otherwise null.
 */
export function VoiceTranscript({ sessionId, useVoicePresence, t }: VoiceTranscriptProps) {
  const text = useVoicePresence(state => state !== null && state.sessionId === sessionId
    && (state.phase === 'listening' || state.phase === 'deciding' || state.phase === 'finishing') ? state.text : '')
  if (!text) return null
  return <div className={css.composerTranscript} data-composer-live-transcript>
    <span>{t('chat.recognizing')}</span>
    <p>{text}</p>
  </div>
}
