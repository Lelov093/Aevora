/** Explicit automatic-speech entry in the existing composer, plus root-owned outcomes. */
import { useEffect } from 'react'
import { IconPlayOutlineRegular, IconPauseOutlineRegular, IconStopFillRegular, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { AutomaticVoice } from './automatic.ts'
import type { StreamPlayback } from './stream-playback.ts'
import css from './voice.module.css'
import { speechFailureKey } from './failure.ts'

/** Plain callbacks and framework-bound sources shared by the composer and root feedback. */
export interface StreamVoiceFace {
  toggleStream: (session: SessionId) => void
  ensureStreamSession: (session: SessionId) => void
  muteStream: (session: SessionId) => void
  pauseStream: (session: SessionId) => void
  dismissAutoNotice: (sequence: number) => void
  hooks: { automaticVoice: AutomaticVoice['state']; streamPlayback: StreamPlayback['state'] }
}

type StreamVoiceProps = PropsRuntime<'conversation.input.right'> & PropsLocale<'voice'> & InjectFace<StreamVoiceFace>

/** Render opt-in speech and an independent stop control.
 * @param props - current composer identity and scoped actions.
 * @returns native compact controls, disabled when streaming is unavailable.
 */
export function StreamVoice(props: StreamVoiceProps) {
  const { sessionId, ensureStreamSession, t } = props
  const mode = props.useAutomaticVoice(value => value)
  const playback = props.useStreamPlayback(value => value)
  const enabled = mode.enabled && mode.session === sessionId
  const paused = playback.userPaused || playback.systemPaused
  const switching = playback.phase === 'pausing' || playback.phase === 'resuming'
  useEffect(() => { ensureStreamSession(sessionId) }, [sessionId, ensureStreamSession])
  const label = t(!mode.available ? 'streamUnavailable' : enabled ? 'streamEnabled' : 'streamHint')
  return <div className={css.streamControls}>
    <Tooltip label={label} side="top"><button type="button" className={css.streamToggle} data-voice-stream
      aria-label={t('streamToggle')} aria-pressed={enabled} disabled={(!mode.available && !enabled) || mode.busy}
      onClick={() => { props.toggleStream(sessionId) }}>
      <IconPlayOutlineRegular /><span>{t('streamToggle')}</span>
    </button></Tooltip>
    {enabled && playback.phase !== 'idle' && <Tooltip label={t(paused ? 'streamResume' : 'streamPause')} side="top">
      <button type="button" className={css.action} data-voice-stream-pause aria-label={t(paused ? 'streamResume' : 'streamPause')}
        aria-pressed={paused} disabled={switching} onClick={() => { props.pauseStream(sessionId) }}>
        {paused ? <IconPlayOutlineRegular /> : <IconPauseOutlineRegular />}</button></Tooltip>}
    {enabled && playback.phase !== 'idle' && <Tooltip label={t('stop')} side="top">
      <button type="button" className={css.action} data-voice-stream-stop aria-label={t('stop')}
        onClick={() => { props.muteStream(sessionId) }}><IconStopFillRegular /></button></Tooltip>}
    {enabled && playback.phase === 'paused'
      && <span className={`${css.streamStatus} ${css.pauseStatus}`} role="status">{t('streamPausedHint')}</span>}
    {enabled && mode.notice !== null && <span className={css.streamStatus} role="alert">
      <span>{t(mode.notice.kind === 'retried' ? 'streamRetried' : speechFailureKey(mode.notice.diagnostic))}</span>
      <button type="button" className={css.link} onClick={() => {
        if (mode.notice !== null) props.dismissAutoNotice(mode.notice.sequence)
      }}>{t('close')}</button></span>}
    {enabled && playback.outcome === 'stopped' && (playback.position?.samples ?? playback.playedSamples) > 0
      && <span className={css.streamStatus} role="status">{t('streamPartial')}</span>}
  </div>
}

type StreamNoticeProps = PropsRuntime<'shell.overlay'> & PropsLocale<'voice'> & InjectFace<StreamVoiceFace>

/** Keep automatic-speech failures visible after a conversation closes.
 * @param props - root-owned outcome and locale dictionary.
 * @returns a transient, dismissible notice.
 */
export function StreamNotice(props: StreamNoticeProps) {
  const mode = props.useAutomaticVoice(value => value)
  const notice = mode.enabled ? null : mode.notice
  return notice === null ? null : <Toast key={notice.sequence}
    text={props.t(notice.kind === 'retried' ? 'streamRetried' : speechFailureKey(notice.diagnostic))}
    onDone={() => { props.dismissAutoNotice(notice.sequence) }} />
}
