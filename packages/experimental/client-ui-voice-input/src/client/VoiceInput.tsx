/** Click-to-record toolbar activity; transcripts remain in the original Session draft. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranscriptionRequest } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'
import type { SpeechPreparationOptions, SpeechProviderId, SpeechSelection, SpeechSelectionPatch, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { audioBase64, type Recording } from './audio.ts'
import { failureText } from './failure-text.ts'
import type { MicrophoneDevice } from './microphone-device.ts'
import type { SpeechReadiness } from './readiness.ts'
import { Waveform } from './Waveform.tsx'
import { VoiceSetupDialog } from './VoiceSetupDialog.tsx'
import { NS } from './locales.ts'
import type { LiveRecognition, LiveSnapshot } from './live-recognition.ts'
import { Button, Checkbox, Modal, IconMicrophoneOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './VoiceInput.module.css'
import type { ContinuousVoice, ContinuousState } from './continuous.ts'
import type { createChatConsent } from './chat-consent.ts'

/** Host calls injected without exposing a Cordis Context to React. */
export interface VoiceInputActions {
  /** Create one optional foreground-initiated voice mode.
   * @param session - native Session.
   * @param selection - explicit ASR selection.
   * @param sampleRate - supported PCM rate.
   * @returns one mode owned by the plugin lifetime.
   */
  createContinuous?: (session: VoiceInputProps['sessionId'], selection: SpeechSelection, sampleRate: number) => ContinuousVoice
  /** Return a mode that remains active while its composer is temporarily unmounted by navigation. */
  getContinuous?: (session: VoiceInputProps['sessionId']) => ContinuousVoice | undefined
  /** Stop modes owned by another Session before a newly mounted composer takes ownership. */
  ensureContinuousSession?: (session: VoiceInputProps['sessionId']) => void
  /** Publish the mounted Session's voice phase and current transcript to the composer. */
  publishVoicePresence: (session: VoiceInputProps['sessionId'], state: ContinuousState | null) => void
  /** Bind the shared composer action to this mounted voice controller. */
  bindChatRequest: (session: VoiceInputProps['sessionId'], request: () => void) => () => void
  /** Provider-scoped consent for automatically sending utterances. */
  chatConsent: ReturnType<typeof createChatConsent>
  /** Open the voice bundle details without starting preparation. */
  openSettings: () => void
  /** @returns one microphone operation owned by the plugin lifecycle. */
  createRecording: () => Recording
  /** @param changed - view-local preview updates. @returns a preview-only live operation. */
  createLive: (changed: (snapshot: LiveSnapshot) => void) => LiveRecognition
  /** Remember the browser microphone used by previews and subsequent recordings. */
  selectMicrophone: (device: MicrophoneDevice) => void
  transcribe: (request: TranscriptionRequest, signal: AbortSignal) => Promise<RemoteResult<Transcript>>
  prepare: (providerId: SpeechProviderId, options?: SpeechPreparationOptions) => Promise<void>
  cancelPreparation: (providerId: SpeechProviderId) => Promise<void>
  configure: (patch: SpeechSelectionPatch) => Promise<void>
}

/** Entry-injected Host readiness and microphone operations. */
export interface VoiceInputInjected extends VoiceInputActions {
  hooks: {
    speechReadiness: HostObservable<SpeechReadiness>
    microphoneDevice: HostObservable<MicrophoneDevice>
    /** Whether the Plugins page navigation service is present; the setup dialog offers the details only while it is. */
    pluginNavigation: HostObservable<boolean>
  }
}

/** Composer-owned expansion and draft actions; preferences stay in plugin settings. */
export type VoiceInputProps = Pick<PropsRuntime<'conversation.input.activity'>, 'sessionId' | 'inputActions' | 'locked' | 'onActiveChange'>
  & PropsLocale<typeof NS> & InjectFace<VoiceInputInjected>

type Phase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'feedback'
type Prompt = 'setup' | 'chat-unavailable' | 'chat-consent' | 'transcript-preview'

interface ActiveRecording {
  readonly capture: Recording
  readonly abort: AbortController
  readonly span: TokenSpan
  readonly selection: SpeechSelection
  readonly maxDurationSeconds: number
  readonly maxAudioBytes: number
  phase: 'requesting' | 'recording' | 'transcribing'
  timer?: ReturnType<typeof setTimeout> | undefined
}

async function disposeRecording(capture: Recording): Promise<void> {
  try { await capture.dispose() } catch (_error) {
    // Tracks stop before AudioContext.close(); a close failure must not hide the recording result.
  }
}

async function disposeLive(capture: LiveRecognition): Promise<void> {
  try { await capture.dispose() }
  catch (_closeFailure) { console.warn('Voice input audio context cleanup failed') }
}

/** Render dictation and voice-chat actions, or controls for the active voice operation. */
export function VoiceInput({ sessionId, inputActions, locked, onActiveChange,
  createRecording, createLive, createContinuous, getContinuous, ensureContinuousSession, transcribe, openSettings,
  publishVoicePresence, bindChatRequest, chatConsent, useSpeechReadiness, usePluginNavigation, t }: VoiceInputProps) {
  const readiness = useSpeechReadiness(value => value), catalog = readiness.catalog
  const navigable = usePluginNavigation(present => present)
  const provider = catalog?.providers.find(item => item.id === catalog.selection.providerId)
  const usable = readiness.connected && (provider?.preparation.phase === 'ready' || provider?.preparation.phase === 'standby'
    || provider?.preparation.phase === 'waking')
  const [phase, setPhase] = useState<Phase>('idle'), [message, setMessage] = useState(''), [pending, setPending] = useState('')
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [rememberChat, setRememberChat] = useState(false)
  const [liveSnapshot, setLiveSnapshot] = useState<LiveSnapshot | null>(null)
  const [inserted, setInserted] = useState(false), [conflict, setConflict] = useState(false)
  const insertionCommitted = useRef(false)
  const live = useRef<LiveRecognition>(), liveSpan = useRef<TokenSpan>()
  const continuous = useRef<ContinuousVoice>(), unobserve = useRef<() => void>()
  const [continuousState, setContinuousState] = useState<ContinuousState | null>(null)
  const [trialSummary, setTrialSummary] = useState('')
  const [summaryPending, setSummaryPending] = useState(false)
  const [summaryNotice, setSummaryNotice] = useState<'copied' | 'manual' | 'failed' | null>(null)
  const showContinuousState = (next: ContinuousState | null): void => {
    setContinuousState(next)
    publishVoicePresence(sessionId, next)
  }
  const attachContinuous = (mode: ContinuousVoice): void => {
    unobserve.current?.()
    continuous.current = mode
    unobserve.current = mode.state.subscribe(() => { showContinuousState(mode.state.getSnapshot()) })
    showContinuousState(mode.state.getSnapshot())
  }
  useEffect(() => { if (usable) setPrompt(active => active === 'setup' ? null : active) }, [usable])
  const current = useRef<ActiveRecording>(), generation = useRef(0)
  useLayoutEffect(() => () => {
    generation.current++
    publishVoicePresence(sessionId, null)
  }, [sessionId, publishVoicePresence])
  const expanded = phase !== 'idle' || liveSnapshot !== null || continuousState !== null
  useLayoutEffect(() => { onActiveChange(expanded); return () => { onActiveChange(false) } }, [expanded, onActiveChange])

  const cancel = (): void => {
    unobserve.current?.(); unobserve.current = undefined
    if (continuous.current) void continuous.current.dispose()
    continuous.current = undefined; showContinuousState(null)
    setTrialSummary(''); setSummaryPending(false); setSummaryNotice(null)
    generation.current++
    const active = current.current
    current.current = undefined
    if (active) { clearTimeout(active.timer); active.abort.abort(); void disposeRecording(active.capture) }
    const preview = live.current; live.current = undefined
    if (preview) void disposeLive(preview)
    setLiveSnapshot(null); setPrompt(null)
    setPending(''); setMessage(''); setPhase('idle')
  }
  useEffect(() => {
    setPending(''); setMessage(''); setPhase('idle'); setLiveSnapshot(null); setPrompt(null)
    ensureContinuousSession?.(sessionId)
    const existing = getContinuous?.(sessionId)
    if (existing) attachContinuous(existing)
    const blur = (): void => { if (current.current?.phase === 'recording') cancel(); live.current?.disconnect() }
    const visibility = (): void => {
      if (document.hidden && current.current && current.current.phase !== 'transcribing') cancel()
      if (document.hidden) live.current?.disconnect()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && (current.current || live.current || continuous.current)) {
        event.preventDefault(); cancel()
      }
    }
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('keydown', escape)
      unobserve.current?.(); unobserve.current = undefined
      continuous.current = undefined; setContinuousState(null)
      const active = current.current
      current.current = undefined
      if (active) { clearTimeout(active.timer); active.abort.abort(); void disposeRecording(active.capture) }
      const preview = live.current; live.current = undefined
      if (preview) void disposeLive(preview)
    }
  }, [sessionId])

  const feedback = (text: string): void => { setMessage(text); setPhase('feedback') }
  const finish = async (): Promise<void> => {
    const active = current.current
    if (!active || active.phase !== 'recording') return
    active.phase = 'transcribing'
    const run = generation.current
    clearTimeout(active.timer); setPhase('transcribing')
    try {
      const audio = await active.capture.stop(active.maxDurationSeconds)
      if (run !== generation.current) return
      if (audio.byteLength > active.maxAudioBytes) { feedback(t('tooLarge')); return }
      const result = await transcribe({ audioBase64: audioBase64(audio), ...active.selection }, active.abort.signal)
      if (run !== generation.current) return
      if (!result.ok) { feedback(t('failed', { message: result.error.message })); return }
      if (result.value.text.trim() === '') { feedback(t('empty')); return }
      if (!inputActions.insertText(result.value.text, active.span)) { setPending(result.value.text); feedback(t('conflict')); return }
      setPhase('idle')
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === generation.current) feedback(failureText(failure, t))
    } finally { if (run === generation.current) current.current = undefined }
  }
  const start = async (): Promise<void> => {
    if (!catalog || !usable || locked || current.current || live.current || continuous.current) return
    const run = ++generation.current
    let capture: Recording
    try { capture = createRecording() } catch (_captureBusy) { feedback(t('live.busy')); return }
    const active: ActiveRecording = { capture, abort: new AbortController(),
      span: inputActions.captureInsertion(), selection: catalog.selection,
      maxDurationSeconds: catalog.maxDurationSeconds, maxAudioBytes: catalog.maxAudioBytes, phase: 'requesting' }
    current.current = active
    setMessage(''); setPending(''); setPhase('requesting')
    try {
      await active.capture.start((failure) => {
        if (run !== generation.current || current.current !== active || active.phase === 'transcribing') return
        current.current = undefined
        clearTimeout(active.timer); active.abort.abort()
        feedback(failureText(failure, t))
      })
      if (run !== generation.current || current.current !== active) return
      active.phase = 'recording'
      setPhase('recording')
      active.timer = setTimeout(() => { void finish() }, active.maxDurationSeconds * 1000)
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === generation.current) { current.current = undefined; feedback(failureText(failure, t)) }
    }
  }
  const startLive = (): void => {
    if (!catalog || !provider?.streaming || !usable || locked || live.current || current.current || continuous.current) return
    const run = ++generation.current
    setPrompt(null); setInserted(false); setConflict(false); setMessage('')
    insertionCommitted.current = false
    liveSpan.current = inputActions.captureInsertion()
    try {
      const operation = createLive((snapshot) => { if (run === generation.current) setLiveSnapshot(snapshot) })
      live.current = operation
      setLiveSnapshot({ phase: 'connecting', text: '', reason: null, usage: { inputTokens: null, outputTokens: null, audioSeconds: null }, requestSeconds: null })
      operation.start(catalog.selection, provider.streaming.sampleRate)
    } catch (_captureBusy) { feedback(t('live.busy')) }
  }
  const startContinuous = (retainedText = ''): void => {
    if (!catalog || !provider?.streaming || !createContinuous || locked || continuous.current) return
    setTrialSummary(''); setSummaryPending(false); setSummaryNotice(null)
    setPrompt(null)
    insertionCommitted.current = false
    try {
      const mode = createContinuous(sessionId, catalog.selection, provider.streaming.sampleRate)
      setInserted(false)
      attachContinuous(mode); mode.start()
    } catch (_unavailable) {
      showContinuousState({ phase: 'paused', text: retainedText, reason: 'resources' })
    }
  }
  const canPreview = usable && provider.streaming !== undefined
  const canChat = canPreview && createContinuous !== undefined
  const openTranscriptPreview = (): void => { if (canPreview && !locked) setPrompt('transcript-preview') }
  const requestChat = (): void => {
    if (locked || current.current || live.current || continuous.current) return
    if (!usable) setPrompt('setup')
    else if (!canChat) setPrompt('chat-unavailable')
    else if (!chatConsent.has(provider.id)) {
      setRememberChat(false)
      setPrompt('chat-consent')
    }
    else startContinuous()
  }
  const confirmChat = (): void => {
    if (!provider || !canChat || locked || current.current || live.current || continuous.current) return
    chatConsent.confirm(provider.id, rememberChat)
    startContinuous()
  }
  const closePrompt = (): void => { setPrompt(null) }
  const openVoiceDetails = navigable ? () => { closePrompt(); openSettings() } : undefined
  const requestChatRef = useRef(requestChat)
  useLayoutEffect(() => { requestChatRef.current = requestChat })
  useLayoutEffect(() => bindChatRequest(sessionId, () => { requestChatRef.current() }), [sessionId, bindChatRequest])
  if (continuousState) {
    const paused = continuousState.phase === 'paused'
    const displayedRun = generation.current
    const togglePause = (): void => {
      if (!paused) { continuous.current?.pause(); return }
      if (!canChat || locked || displayedRun !== generation.current) return
      const run = ++generation.current
      const previous = continuous.current
      if (!previous) { startContinuous(continuousState.text); return }
      unobserve.current?.(); unobserve.current = undefined
      continuous.current = undefined
      showContinuousState({ ...continuousState, phase: 'preparing', reason: null })
      void previous.dispose().then(() => {
        if (run === generation.current) startContinuous(continuousState.text)
      }, () => {
        if (run === generation.current) showContinuousState({ ...continuousState, reason: 'failed' })
      })
    }
    return <div className={css.conversationControls} data-continuous-voice={continuousState.phase}>
      <div className={css.conversationActions} data-voice-actions onMouseDown={(event) => { event.preventDefault() }}>
        {(continuousState.phase === 'listening' || continuousState.phase === 'deciding') && <button type="button" className={css.entryButton}
          onClick={() => { continuous.current?.finish() }}>{t('continuous.finish')}</button>}
        <button type="button" className={css.entryButton}
          disabled={paused ? !canChat || locked : !continuous.current}
          onClick={togglePause}>{t(paused ? 'continuous.resume' : 'continuous.pause')}</button>
        <button type="button" className={css.endVoice} onClick={cancel}>{t('continuous.exit')}</button>
      </div>
      {continuousState.reason && continuousState.reason !== 'stopped' && <p className={css.voiceNotice} role="status">{t(`continuous.${continuousState.reason}`)}</p>}
      <details className={css.voiceDetails}>
        <summary>{t('continuous.details')}</summary>
        <textarea readOnly rows={2} aria-label={t('live.transcript')} value={continuousState.text} />
        <div className={css.preparationActions}>
          {paused && <>
            <Button size="sm" disabled={locked || inserted || !continuousState.text} onClick={() => {
              if (insertionCommitted.current || generation.current !== displayedRun) return
              if (inputActions.insertText(continuousState.text, inputActions.captureInsertion())) {
                insertionCommitted.current = true
                setInserted(true)
              }
            }}>{t(inserted ? 'live.inserted' : 'live.insert')}</Button>
            {navigable && <Button size="sm" onClick={openSettings}>{t('setupPrompt.details')}</Button>}
            {continuousState.parallel && continuous.current && !trialSummary && <Button size="sm" disabled={summaryPending} onClick={() => {
              const mode = continuous.current
              if (!mode) return
              setSummaryPending(true); setSummaryNotice(null)
              void mode.diagnostics().then((summary) => {
                if (continuous.current !== mode) return
                setTrialSummary(JSON.stringify(summary, null, 2)); setSummaryPending(false)
              }, () => {
                if (continuous.current !== mode) return
                setSummaryPending(false); setSummaryNotice('failed')
              })
            }}>{t('continuous.summary')}</Button>}
          </>}
        </div>
        {continuousState.parallel && trialSummary && <>
          <textarea readOnly rows={5} aria-label={t('continuous.summary')} value={trialSummary} />
          <div className={css.preparationActions}><Button size="sm" onClick={() => {
            const mode = continuous.current
            const clipboard = (navigator as Partial<Navigator>).clipboard
            if (!clipboard) { setSummaryNotice('manual'); return }
            void clipboard.writeText(trialSummary).then(() => {
              if (continuous.current === mode) setSummaryNotice('copied')
            }, () => {
              if (continuous.current === mode) setSummaryNotice('manual')
            })
          }}>{t('continuous.summaryCopy')}</Button></div>
        </>}
        {summaryNotice && <p role="status">{t(`continuous.summary.${summaryNotice}`)}</p>}
        <p className={css.metric}>{t(continuousState.parallel ? 'continuous.parallel' : 'continuous.halfDuplex')}</p>
      </details>
    </div>
  }
  if (liveSnapshot) {
    const busy = ['connecting', 'listening', 'checking', 'finishing'].includes(liveSnapshot.phase)
    const reason = liveSnapshot.reason
    const failureKey = reason === 'authentication' || reason === 'unconfigured' ? 'live.configurationFailed'
      : reason === 'unavailable' ? 'unavailable' : reason === 'permission' ? 'live.permissionFailed' : reason === 'deviceMissing' ? 'live.deviceFailed'
        : reason === 'limit' ? 'live.limitFailed' : reason === 'timeout' ? 'live.timeoutFailed'
          : reason === 'protocol' ? 'live.protocolFailed' : 'live.failed'
    return <div className={css.livePreview} data-live-recognition={liveSnapshot.phase}>
      <div className={css.preparationActions}>
        <span role="status">{t(liveSnapshot.phase === 'failed' ? failureKey : `live.${liveSnapshot.phase}`)}</span>
        <Button size="sm" onClick={cancel}>{t(busy ? 'cancel' : 'live.close')}</Button>
        {liveSnapshot.phase === 'listening' && <Button size="sm" onClick={() => { void live.current?.finish() }}>{t('live.finish')}</Button>}
      </div>
      <textarea readOnly aria-label={t('live.transcript')} value={liveSnapshot.text} rows={3} />
      <div className={css.preparationActions}>
        {liveSnapshot.phase === 'done' && <Button size="sm" disabled={inserted || !liveSnapshot.text || conflict} onClick={() => {
          if (insertionCommitted.current) return
          const span = liveSpan.current
          if (span && inputActions.insertText(liveSnapshot.text, span)) { insertionCommitted.current = true; setInserted(true) }
          else setConflict(true)
        }}>{t(inserted ? 'live.inserted' : 'live.insert')}</Button>}
        {liveSnapshot.text && <Button size="sm" onClick={() => {
          const clipboard = (navigator as Partial<Navigator>).clipboard
          if (!clipboard) { setMessage(t('live.copyManually')); return }
          void clipboard.writeText(liveSnapshot.text).catch((_clipboardFailure: unknown) => { setMessage(t('live.copyManually')) })
        }}>{t('live.copy')}</Button>}
      </div>
      {(conflict || message) && <p role="status">{conflict ? t('live.conflict') : message}</p>}
      <p className={css.metric}>{t('live.previewOnly')}</p>
    </div>
  }
  if (!expanded) return <>
    <div className={css.entryActions}>
      <Tooltip label={t(canPreview ? 'live.previewHint' : 'dictate')} disabled={!usable} side="top" portal>
        <button type="button" className={css.entryButton} disabled={locked}
          aria-description={canPreview ? t('live.previewHint') : undefined} aria-haspopup={usable ? undefined : 'dialog'}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => { if (usable) void start(); else setPrompt('setup') }}
          onContextMenu={(event) => {
            if (!canPreview || locked) return
            event.preventDefault(); openTranscriptPreview()
          }}
          onKeyDown={(event) => {
            if (!canPreview || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return
            event.preventDefault(); openTranscriptPreview()
          }}>
          <IconMicrophoneOutlineRegular size={16} aria-hidden />
          {t('dictate')}
        </button>
      </Tooltip>
    </div>
    <VoiceSetupDialog open={prompt === 'setup' && !usable}
      needsInstallation={readiness.connected && provider?.location === 'host-local' && provider.preparation.phase === 'unprepared'}
      onDismiss={closePrompt} onOpenDetails={openVoiceDetails} t={t} />
    <Modal open={prompt === 'chat-unavailable' || prompt === 'chat-consent'} title={t('chat.open')}
      closeLabel={t('cancel')} onClose={closePrompt}
      footer={<>
        <Button variant="ghost" onClick={closePrompt}>{t('setupPrompt.later')}</Button>
        {prompt === 'chat-consent' ? <Button variant="primary" disabled={!canChat || locked} onClick={confirmChat}>{t('continuous.start')}</Button>
          : openVoiceDetails && <Button variant="primary" onClick={openVoiceDetails}>{t('setupPrompt.details')}</Button>}
      </>}>
      {prompt === 'chat-consent' ? <>
        {provider?.location === 'cloud' && <p>{t('chat.upload', { name: provider.name })}</p>}
        <p>{t('continuous.consent')}</p>
        <Checkbox checked={rememberChat} onChange={setRememberChat} label={t('chat.remember')} />
      </> : <p>{t('chat.needsStreaming')}</p>}
    </Modal>
    <Modal open={prompt === 'transcript-preview'} title={t('live.transcript')} closeLabel={t('cancel')} onClose={closePrompt}
      footer={<><Button variant="ghost" onClick={closePrompt}>{t('setupPrompt.later')}</Button>
        <Button variant="primary" disabled={!canPreview || locked} onClick={startLive}>{t('live.start')}</Button></>}>
      {provider?.location === 'cloud' && <p>{t('live.upload', { name: provider.name })}</p>}
      <p>{t('live.previewOnly')}</p>
    </Modal>
  </>
  const feedbackRun = generation.current
  const status = phase === 'feedback' ? message : t(phase === 'recording' ? 'dictation.recording'
    : phase === 'requesting' ? 'requesting' : provider?.preparation.phase === 'waking' ? 'wakingShort' : 'transcribingShort')
  return <div className={css.captureRow} data-voice-activity={phase}>
    <div className={css.captureStatus}>
      <span className={css.activityMessage} role="status"><span className={css.captureLabel}>{status}</span></span>
      {pending && <span className={css.retainedTranscript} title={pending}>{pending}</span>}
    </div>
    {phase === 'recording' && <Waveform recording={current.current?.capture} label={t('recording')} />}
    <div className={css.captureActions} onMouseDown={(event) => { event.preventDefault() }}>
      <button type="button" className={css.entryButton} onClick={cancel}>{t(pending ? 'discard' : 'cancel')}</button>
      {phase === 'recording' && <button type="button" className={css.chatEntry}
        onClick={() => { void finish() }}>{t('dictation.finish')}</button>}
      {phase === 'feedback' && (pending
        ? <button type="button" className={css.chatEntry} disabled={locked} onClick={() => {
          if (generation.current !== feedbackRun || locked) return
          if (!inputActions.insertText(pending, inputActions.captureInsertion())) return
          generation.current++
          setPending(''); setPhase('idle')
        }}>{t('insert')}</button>
        : <button type="button" className={css.entryButton} disabled={!usable || locked}
          onClick={() => { void start() }}>{t('retryRecording')}</button>)}
    </div>
  </div>
}
