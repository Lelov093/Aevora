/** Foreground voice mode over native recognition, Session admission and shared speech output. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { VoiceOutput, VoiceRequestId, VoicePause, VoicePlaybackObservation } from '@deepseek-ai/dsh-client-ui-voice/client'
import type { SpeechSelection } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type {} from '@deepseek-ai/dsh-experimental-voice-turns/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { audioBase64 } from './audio.ts'
import { PcmCapture, PcmCaptureFailure } from './pcm-capture.ts'
import { PcmTimeline } from './pcm-timeline.ts'
import { LiveRecognition, type LiveSnapshot } from './live-recognition.ts'
import type { TurnReviewId, VoiceEvaluationId, VoiceCandidateId } from '@deepseek-ai/dsh-experimental-voice-turns/types'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { VoiceTrialMetrics, type VoiceTrialReport } from './trial-metrics.ts'

/** Transcript remains copyable after a pause; reasons are locale keys. */
export interface ContinuousState {
  readonly phase: 'preparing' | 'listening' | 'deciding' | 'finishing' | 'answering' | 'paused'
  readonly text: string
  readonly reason: 'resources' | 'busy' | 'changed' | 'stopped' | 'failed' | 'limit' | 'uncertain' | null
  readonly parallel?: boolean
  readonly recognitionTasks?: number
}

interface Hearing {
  recognition: LiveRecognition
  text: string
  candidateId: VoiceCandidateId
  speechStarted: boolean
  target: VoicePlaybackObservation | null
  hold: Promise<VoicePause | null> | undefined
  verdict: 'interrupt' | 'backchannel' | undefined
  echoCandidate: boolean
  revision: number
  speechRevision: number
  closing: boolean
}

function queuedSources(value: unknown): unknown[] | undefined {
  if (typeof value !== 'object' || value === null || !('next-turn' in value) || !('next-step' in value)
    || !Array.isArray(value['next-turn']) || !Array.isArray(value['next-step'])) return undefined
  const nextTurn: readonly unknown[] = value['next-turn'], nextStep: readonly unknown[] = value['next-step']
  const entries: unknown[] = [...nextTurn, ...nextStep]
  return entries.map(entry => typeof entry === 'object' && entry !== null && 'source' in entry ? entry.source : null)
}

/** One mode owns its microphone, local model stream and reply authorization until explicit pause or exit. */
export class ContinuousVoice {
  /** Shared transient mode state rendered by the native microphone activity. */
  readonly state = createSnapshotStore<ContinuousState>({ phase: 'paused', text: '', reason: null })
  private readonly lifetime = new AbortController()
  private readonly trial = new VoiceTrialMetrics()
  private readonly capture: PcmCapture
  private readonly output: VoiceOutput
  private readonly binding: SessionBinding
  private readonly releases: (() => void)[] = []
  private turns: ReturnType<Context['remote']['voiceTurns']['listen']> | undefined
  private recognition: LiveRecognition | undefined
  private request: VoiceRequestId | undefined
  private ready = Promise.withResolvers<void>()
  private decision: {
    kind: 'reviewed' | 'sealed' | 'committed'
    reviewId: TurnReviewId | undefined
    samples: number
    coveredSamples: number | undefined
    resolve: (valid: boolean) => void
    reject: (error: unknown) => void
  } | undefined
  private reviewId: TurnReviewId | undefined
  private reset: ReturnType<typeof Promise.withResolvers<void>> | undefined
  private run: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private sent = 0
  private accepted = 0
  private maxPending = 0
  private awaitingNext = false
  private parallel = false
  private timeline: PcmTimeline | undefined
  private maxTasks = 0
  private readonly hearings = new Set<Hearing>()
  private hearing: Hearing | undefined
  private vadOffset = 0
  private speechRevision = 0
  private interruptedReply: VoiceRequestId | undefined
  private observationBatch: VoicePlaybackObservation['batchId'] = null
  private observationSequence = 0
  private observationPhase = ''
  private outputWrites: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: Context, readonly sessionId: SessionId, device: string,
    private readonly selection: SpeechSelection, private readonly sampleRate: number,
    private readonly released: () => void) {
    const binding = ctx.sessions.binding(sessionId)
    const output = ctx.get('voiceOutput')
    if (!binding || !output) throw new Error('Continuous voice services are unavailable')
    this.binding = binding; this.output = output
    this.capture = new PcmCapture(device, () => {})
    void this.ready.promise.catch((_cancelled: unknown) => { /* start() publishes preparation failures. */ })
  }

  private publish(patch: Partial<ContinuousState>): void { this.state.set({ ...this.state.getSnapshot(), ...patch }) }

  private canListen(admission = false): boolean {
    const session = this.binding.session.getSnapshot()
    const input = this.ctx.conversation.input.for(this.binding.ctx).state.getSnapshot()
    const queued = queuedSources(this.binding.session.projections.faceOf('inbox').getSnapshot())
    return this.ctx.sessions.binding(this.sessionId) === this.binding
      && session.openState === 'open' && ((this.parallel && !admission) || !session.running)
      && session.pendingSubmissions.every(item => this.parallel && !admission && item.requestId === this.request)
      && queued !== undefined && queued.every(source => this.parallel && !admission && typeof source === 'object' && source !== null
        && 'rpcId' in source && source.rpcId === this.request) && !input.draft && input.attachmentIds.length === 0
  }

  /** Start from the explicit mode confirmation gesture. No preparation download is performed. */
  start(): void {
    if (this.run) throw new Error('Continuous voice already started')
    if (!this.canListen() || this.sampleRate !== 16000) { this.pause('busy'); return }
    this.publish({ phase: 'preparing', reason: null })
    // Both AudioContexts begin preparation within the original activation gesture.
    const outputReady = this.output.arm(this.sessionId)
    const captureReady = this.capture.prepare(this.sampleRate)
    const input = this.ctx.conversation.input.for(this.binding.ctx).state
    const inbox = this.binding.session.projections.faceOf('inbox')
    const observe = (): void => {
      if (this.lifetime.signal.aborted) return
      const draft = input.getSnapshot(), session = this.binding.session.getSnapshot()
      if (draft.draft || draft.attachmentIds.length || session.lastAgentError || session.openState !== 'open'
      ) { this.pause('changed'); return }
      if (session.pendingSubmissions.some(item => item.requestId !== this.request)) { this.pause('changed'); return }
      const queued = queuedSources(inbox.getSnapshot())
      if (queued === undefined || queued.some(source => typeof source !== 'object' || source === null || !('rpcId' in source) || source.rpcId !== this.request)) {
        this.pause('changed'); return
      }
      if (this.awaitingNext && this.canListen()) {
        this.awaitingNext = false
        void this.next().catch(() => { this.pause('failed') })
      } else if (!this.parallel && this.state.getSnapshot().phase === 'listening' && session.running) this.pause('changed')
    }
    this.releases.push(input.subscribe(observe), this.binding.session.subscribe(observe), inbox.subscribe(observe),
      this.output.mode.subscribe(() => {
        if (!this.lifetime.signal.aborted && this.state.getSnapshot().phase !== 'preparing' && !this.output.mode.getSnapshot().enabled) this.pause()
      }),
      this.ctx.sessions.retainInfo(this.sessionId).subscribe(observe), this.output.replies.subscribe(() => {
        const reply = this.output.replies.getSnapshot()
        if (!reply || reply.requestId !== this.request || reply.outcome === 'pending' || this.lifetime.signal.aborted) return
        if (this.parallel && reply.requestId === this.interruptedReply) return
        if (reply.outcome !== 'done') {
          this.pause(reply.outcome === 'failed' || reply.outcome === 'retried' ? 'failed' : 'stopped')
          return
        }
        if (this.parallel) return
        this.awaitingNext = true; observe()
      }), this.output.playback.subscribe(() => { this.observePlayback() }))
    this.run = (async () => {
      try {
        await Promise.all([outputReady, captureReady])
        this.lifetime.signal.throwIfAborted()
        if (!this.canListen()) throw new Error('Session changed during voice activation')
        const readiness = await this.ctx.remote.voiceTurns.readiness()
        if (!readiness.ok || !readiness.value.filesPresent) { this.pause('resources'); return }
        this.maxTasks = readiness.value.maxRecognitionTasks
        const handle = this.ctx.remote.voiceTurns.listen(this.sessionId, this.lifetime.signal)
        this.turns = handle
        const consuming = this.consumeTurns(handle)
        void consuming.catch(() => { this.pause('failed') })
        await this.ready.promise
        this.beginListening()
        await consuming
      } catch (_failure) { if (!this.lifetime.signal.aborted) this.pause('failed') }
    })()
  }

  private async consumeTurns(handle: NonNullable<ContinuousVoice['turns']>): Promise<void> {
    try {
      for await (const frame of handle) {
        if (this.lifetime.signal.aborted) return
        switch (frame.kind) {
          case 'ready':
            this.maxPending = frame.maxPendingSamples
            this.parallel = frame.parallel
            if (this.parallel) this.timeline = new PcmTimeline(this.capture, this.maxTasks)
            this.publish({ parallel: this.parallel })
            this.ready.resolve()
            break
          case 'accepted':
            if (frame.samples < this.accepted || frame.samples > this.sent) throw new PcmCaptureFailure('protocol')
            this.accepted = frame.samples
            if (frame.speaking) {
              const hearing = this.hearing
              if (this.parallel && hearing && !hearing.speechStarted) {
                this.speechRevision++
                hearing.speechStarted = true
                const playback = this.output.playback.getSnapshot()
                if (playback?.outcome === null && playback.batchId !== null) {
                  hearing.target = playback
                  hearing.hold = this.output.pause(playback.requestId, 'candidate')
                  void hearing.hold.catch(() => { this.pause('failed') })
                }
              }
            }
            if (frame.speaking && this.recognition?.phase === 'listening' && this.state.getSnapshot().phase === 'deciding') this.publish({ phase: 'listening' })
            break
          case 'candidate': if (this.state.getSnapshot().phase === 'listening') this.publish({ phase: 'deciding' }); break
          case 'complete': if (['listening', 'deciding'].includes(this.state.getSnapshot().phase)) void this.recognition?.checkEnd(); break
          case 'reviewed': this.settle('reviewed', frame.reviewId, frame.samples, frame.ready); break
          case 'sealed':
            this.settle('sealed', frame.reviewId, frame.samples, frame.valid)
            break
          case 'committed': this.settle('committed', frame.reviewId, frame.samples, frame.valid, frame.coveredSamples); break
          case 'reset': this.reset?.resolve(); break
        }
      }
      if (!this.lifetime.signal.aborted) throw new Error('Voice model stream ended')
    } finally {
      this.ready.reject(new Error('Voice models stopped')); this.decision?.reject(new Error('Voice models stopped')); this.reset?.reject(new Error('Voice models stopped'))
    }
  }

  private settle(kind: NonNullable<ContinuousVoice['decision']>['kind'], reviewId: TurnReviewId | undefined,
    samples: number, valid: boolean, coveredSamples?: number): void {
    const decision = this.decision
    if (!decision || decision.kind !== kind || decision.reviewId !== reviewId) return
    if (samples !== decision.samples || coveredSamples !== decision.coveredSamples) throw new PcmCaptureFailure('protocol')
    this.decision = undefined; decision.resolve(valid)
  }

  private async verdict(kind: NonNullable<ContinuousVoice['decision']>['kind'], samples: number,
    explicit = false, coveredSamples?: number): Promise<boolean> {
    if (!this.turns || this.decision) throw new PcmCaptureFailure('protocol')
    const reviewId = explicit ? undefined : this.reviewId
    if (!explicit && !reviewId) throw new PcmCaptureFailure('protocol')
    const pending = Promise.withResolvers<boolean>()
    const decision = { kind, reviewId, samples, coveredSamples, ...pending }
    this.decision = decision
    try {
      if (kind === 'reviewed' && reviewId) this.turns.send({ kind: 'review', reviewId, samples })
      else if (kind === 'committed' && reviewId && coveredSamples !== undefined) this.turns.send({ kind: 'commit', reviewId, samples, coveredSamples })
      else this.turns.send({ kind: 'seal', ...(reviewId === undefined ? {} : { reviewId }), samples, explicit })
      return await pending.promise
    } finally { if (this.decision === decision) this.decision = undefined }
  }

  private beginListening(): void {
    if (!this.canListen() || this.lifetime.signal.aborted) { this.pause('changed'); return }
    if (this.parallel && this.hearings.size >= this.maxTasks) { this.pause('limit'); return }
    this.sent = 0; this.accepted = 0; this.reviewId = undefined; this.vadOffset = 0
    if (!this.parallel) this.request = undefined
    this.publish({ phase: 'preparing', text: '', reason: null })
    let hearing: Hearing | undefined
    const recognition = new LiveRecognition(this.ctx.remote.speech, '', (snapshot) => { this.recognized(recognition, snapshot) }, () => {}, undefined, {
      capture: this.timeline?.port() ?? this.capture,
      audio: (pcm, startSample) => {
        const relative = startSample - this.vadOffset
        if (!this.turns || relative !== this.sent || this.sent - this.accepted + pcm.length / 2 > this.maxPending) throw new PcmCaptureFailure('limit')
        this.sent += pcm.length / 2
        this.turns.send({ kind: 'audio', startSample: relative, audioBase64: audioBase64(pcm) })
      },
      review: async (samples) => {
        this.reviewId = randomUUID() as TurnReviewId
        if (!await this.verdict('reviewed', samples - this.vadOffset)) return false
        if (this.parallel && hearing?.target && hearing.verdict !== 'interrupt') return this.judge(hearing, samples)
        return true
      },
      seal: async (samples, explicit) => {
        if (this.parallel && explicit && hearing?.target && hearing.verdict !== 'interrupt') {
          if (!hearing.text.trim()) await this.releaseCandidate(hearing)
          else if (!await this.judge(hearing, samples) || !this.confirmed(hearing)) throw new PcmCaptureFailure('protocol')
        }
        return this.verdict('sealed', samples - this.vadOffset, explicit)
      },
      commit: async (samples, coveredSamples) => {
        if (hearing?.echoCandidate) {
          if (hearing.revision !== recognition.transcriptRevision || hearing.speechRevision !== this.speechRevision) return false
          const hold = await hearing.hold
          if (!hold || !await this.output.resume(hold)) throw new PcmCaptureFailure('protocol')
          await this.resetTurns()
          this.vadOffset = coveredSamples; this.sent = 0; this.accepted = 0
          hearing.target = null; hearing.hold = undefined; hearing.verdict = undefined; hearing.echoCandidate = false
          hearing.speechStarted = false; hearing.candidateId = randomUUID() as VoiceCandidateId
          return false
        }
        if (hearing?.verdict === 'backchannel'
          && (hearing.revision !== recognition.transcriptRevision || hearing.speechRevision !== this.speechRevision)) return false
        const valid = await this.verdict('committed', samples - this.vadOffset, false, coveredSamples - this.vadOffset)
        if (!valid || hearing?.verdict !== 'backchannel') return valid
        if (hearing.revision !== recognition.transcriptRevision || hearing.speechRevision !== this.speechRevision
          || !recognition.excludeThrough(samples)) throw new PcmCaptureFailure('uncertain')
        const hold = await hearing.hold
        if (!hold || !await this.output.resume(hold)) throw new PcmCaptureFailure('protocol')
        await this.resetTurns()
        this.vadOffset = coveredSamples; this.sent = 0; this.accepted = 0
        hearing.target = null; hearing.hold = undefined; hearing.verdict = undefined; hearing.speechStarted = false
        hearing.candidateId = randomUUID() as VoiceCandidateId
        return false
      },
      ...(this.parallel ? { handoff: () => {
        if (hearing === undefined) throw new PcmCaptureFailure('protocol')
        hearing.closing = true
        void this.next().catch(() => { this.pause('failed') })
      } } : {}),
    })
    this.recognition = recognition
    this.trial.trackRecognition(recognition)
    if (this.parallel) {
      hearing = { recognition, text: '', candidateId: randomUUID() as VoiceCandidateId, speechStarted: false,
        target: null, hold: undefined, verdict: undefined, echoCandidate: false, revision: 0, speechRevision: 0, closing: false }
      this.hearing = hearing; this.hearings.add(hearing)
      this.publish({ recognitionTasks: this.hearings.size })
    }
    recognition.start(this.selection, this.sampleRate)
  }

  private observePlayback(): void {
    const snapshot = this.output.playback.getSnapshot()
    if (!snapshot || snapshot.batchId === null) return
    if (snapshot.requestId === this.request || snapshot.requestId === this.interruptedReply) this.trial.observePlayback(snapshot)
    if (!this.parallel) return
    const phase = `${snapshot.phase}/${snapshot.outcome}/${snapshot.step}/${snapshot.attempt}`
    if (snapshot.batchId === this.observationBatch && phase === this.observationPhase) return
    if (snapshot.batchId !== this.observationBatch) { this.observationBatch = snapshot.batchId; this.observationSequence = 0 }
    this.observationPhase = phase
    const { userPaused: _user, candidatePaused: _candidate, systemPaused: _system, userSeq: _seq, tasks: _tasks, ...observation } = snapshot
    const input = { ...observation, batchId: snapshot.batchId, sequence: this.observationSequence++ }
    this.outputWrites = this.outputWrites.then(async () => {
      const result = await this.ctx.remote.voiceTurns.observePlayback(this.sessionId, input)
      if (!result.ok) throw new Error('Playback observation was not accepted')
    })
    void this.outputWrites.catch(() => { this.pause('failed') })
  }

  private async judge(hearing: Hearing, samples: number): Promise<boolean> {
    const target = hearing.target, hold = await hearing.hold
    if (!target || !hold) { hearing.target = null; return true }
    const revision = hearing.recognition.transcriptRevision, speechRevision = this.speechRevision
    if (!hearing.text.trim()) {
      // No transcript means there is no semantic interruption to evaluate.
      // Treat the candidate as recoverable echo/noise. commit() drops only
      // this candidate's samples and resumes the same ASR and playback batch.
      hearing.echoCandidate = true; hearing.revision = revision; hearing.speechRevision = speechRevision
      return true
    }
    await this.outputWrites
    this.trial.judged()
    const response = await this.ctx.remote.voiceTurns.evaluateInterruption(this.sessionId, {
      evaluationId: randomUUID() as VoiceEvaluationId, candidateId: hearing.candidateId,
      requestId: target.requestId, batchId: hold.batchId, revision, startSample: 0, endSample: samples, text: hearing.text,
    }, this.lifetime.signal)
    if (this.lifetime.signal.aborted) return false
    if (revision !== hearing.recognition.transcriptRevision || speechRevision !== this.speechRevision) return false
    if (!response.ok) throw new PcmCaptureFailure('protocol')
    if (response.value.verdict === 'uncertain') throw new PcmCaptureFailure('uncertain')
    hearing.verdict = response.value.verdict; hearing.revision = revision; hearing.speechRevision = speechRevision
    if (hearing.verdict === 'interrupt') {
      this.interruptedReply = target.requestId
      if (!this.output.confirmStop(hold)) throw new PcmCaptureFailure('protocol')
      await this.outputWrites
    }
    return true
  }

  /** Release a candidate pause that produced no usable transcript, such as speaker echo. */
  private async releaseCandidate(hearing: Hearing): Promise<void> {
    const hold = hearing.hold === undefined ? null : await hearing.hold
    if (hold !== null && !await this.output.resume(hold)) throw new PcmCaptureFailure('protocol')
    hearing.target = null; hearing.hold = undefined; hearing.verdict = undefined
    hearing.echoCandidate = false; hearing.speechStarted = false
    hearing.candidateId = randomUUID() as VoiceCandidateId
  }

  private confirmed(hearing: Hearing): boolean { return hearing.verdict === 'interrupt' }

  private recognized(recognition: LiveRecognition, snapshot: LiveSnapshot): void {
    if (snapshot.phase === 'done' || snapshot.phase === 'failed') this.trial.settleRecognition(recognition)
    if (this.lifetime.signal.aborted) return
    const hearing = this.parallel ? [...this.hearings].find(item => item.recognition === recognition) : undefined
    if (this.recognition !== recognition && !hearing) return
    if (hearing) hearing.text = snapshot.text
    if (this.recognition === recognition) this.publish({ text: snapshot.text })
    if (snapshot.phase === 'listening') this.publish({ phase: 'listening' })
    if (snapshot.phase === 'checking') this.publish({ phase: 'deciding' })
    if (snapshot.phase === 'finishing') this.publish({ phase: 'finishing' })
    if (snapshot.phase === 'failed') {
      this.pause(snapshot.reason === 'limit' ? 'limit' : snapshot.reason === 'uncertain' ? 'uncertain' : 'failed'); return
    }
    if (snapshot.phase !== 'done') return
    if (snapshot.endReason === 'limit') { this.pause('limit'); return }
    if (!snapshot.text.trim() || !this.canListen()) { this.pause('changed'); return }
    if (hearing) { this.hearings.delete(hearing); this.publish({ recognitionTasks: this.hearings.size }) }
    const interruptAt = hearing?.verdict === 'interrupt' && hearing.target ? SessionSeq(hearing.target.userSeq) : undefined
    const submission = this.binding.session.beginSubmission({ mode: 'queue', text: snapshot.text, attachments: [] })
    this.request = submission.requestId
    if (!this.parallel) this.publish({ phase: 'answering' })
    try { this.output.authorize(submission.requestId) }
    catch (_unavailable) { submission.abandon(); this.pause('failed'); return }
    this.trial.submitted()
    void this.binding.session.prompt([{ type: 'text', text: snapshot.text }], 'queue', this.lifetime.signal, submission.requestId, interruptAt)
      .then((result) => { if (!result.ok) this.pause('failed') }, () => { this.pause('failed') })
  }

  private async next(): Promise<void> {
    if (!this.turns || this.lifetime.signal.aborted) return
    await this.resetTurns()
    this.beginListening()
  }

  private async resetTurns(): Promise<void> {
    if (!this.turns) throw new PcmCaptureFailure('protocol')
    const reset = Promise.withResolvers<void>(); this.reset = reset
    this.turns.send({ kind: 'reset' }); await reset.promise
  }

  /** Explicitly end this utterance without bypassing final transcription. */
  finish(): void { void this.recognition?.finish('explicit') }

  /** Stop audio and automatic continuation; text Agent work keeps its native lifecycle.
   * @param reason - localized disposition retained with the transcript.
   */
  pause(reason: ContinuousState['reason'] = 'stopped'): void {
    if (this.lifetime.signal.aborted) return
    this.publish({ phase: 'paused', reason })
    this.lifetime.abort(); this.turns?.dispose(); this.output.stop()
    for (const off of this.releases.splice(0)) off()
    this.ready.reject(new Error('Voice mode paused')); this.decision?.reject(new Error('Voice mode paused')); this.reset?.reject(new Error('Voice mode paused'))
    void this.dispose()
  }

  /** Join microphone, Remote and local observation cleanup. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.lifetime.abort(); this.turns?.dispose(); this.output.stop()
    for (const off of this.releases.splice(0)) off()
    this.disposal = (async () => {
      const capture = this.timeline?.dispose() ?? this.capture.dispose()
      await Promise.allSettled([...this.hearings].map(item => item.recognition.dispose()))
      await Promise.allSettled([this.recognition?.dispose(), capture, this.run, this.outputWrites, this.output.settleStop()])
      this.trial.finish()
      this.released()
    })()
    return this.disposal
  }

  /** Copy this paused mode's finalized local observations without resuming capture or dispatching requests.
   * @returns counters excluding audio, transcripts and credentials; server work without a receipt stays unknown.
   */
  async diagnostics(): Promise<VoiceTrialReport & {
    kind: 'aevora-voice-trial'
    version: 1
    sessionId: SessionId
    parallel: boolean
    phase: ContinuousState['phase']
    reason: ContinuousState['reason']
    sampleRate: number
    recognitionProvider: SpeechSelection['providerId']
  }> {
    if (!this.lifetime.signal.aborted) throw new Error('Pause voice before collecting a trial summary')
    await this.dispose()
    return { kind: 'aevora-voice-trial' as const, version: 1, sessionId: this.sessionId,
      parallel: this.parallel, phase: this.state.getSnapshot().phase, reason: this.state.getSnapshot().reason,
      sampleRate: this.sampleRate, recognitionProvider: this.selection.providerId, ...this.trial.report() }
  }
}
