/** One preview-only live recording; disconnect and failure never restart or submit it. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-experimental-api-speech-to-text/remote'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SpeechSelection, SpeechUsage } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { SpeechStreamLimits } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'
import { RecordingError, audioBase64 } from './audio.ts'
import { PcmCapture, PcmCaptureFailure } from './pcm-capture.ts'
import type { PcmInput } from './pcm-timeline.ts'

/** Preview state carries no raw audio and is never persisted. */
export interface LiveSnapshot {
  phase: 'connecting' | 'listening' | 'checking' | 'finishing' | 'done' | 'failed'
  text: string
  reason: string | null
  usage: SpeechUsage
  requestSeconds: number | null
  /** Successful transport completion alone does not authorize an automatic prompt. */
  endReason?: 'explicit' | 'model' | 'limit'
}

/** Local intake observations; a requested stream does not prove a cloud task was accepted or billed. */
export interface RecognitionObservation {
  readonly requested: boolean
  readonly phase: LiveSnapshot['phase']
  readonly usage: SpeechUsage
  readonly uploadedSamples: number
  readonly acceptedSamples: number
}

/** Optional mode-owned audio fanout; the preview path leaves these hooks absent. */
export interface LiveMode {
  readonly capture: PcmInput
  /** Start the next intake after a committed cutoff while this ASR task settles. */
  handoff?(): void
  /** @param pcm - borrowed ordered PCM. @param startSample - task-local sample position. */
  audio(pcm: Uint8Array, startSample: number): void
  /** @param samples - aligned live checkpoint. @returns whether reversible closing may proceed. */
  review(samples: number): Promise<boolean>
  /** @param samples - aligned complete audio cutoff.
   * @param explicit - user-authorized ending. @returns whether the cutoff remains valid. */
  seal(samples: number, explicit: boolean): Promise<boolean>
  /** @param samples - reviewed ASR cutoff.
   * @param coveredSamples - locked capture coverage. @returns whether the reviewed cutoff was committed. */
  commit(samples: number, coveredSamples: number): Promise<boolean>
}

/** Owns the native Remote stream, microphone and text for one explicit user action. */
export class LiveRecognition {
  private readonly abort = new AbortController()
  private handle: ReturnType<ClientRemote['speech']['stream']> | undefined
  private run: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private creditTimer: ReturnType<typeof setTimeout> | undefined
  private limits: SpeechStreamLimits | undefined
  private samples = 0
  private accepted = 0
  private sequence = 0
  private readonly sentences = new Map<number, { text: string; final: boolean; beginMs: number | null; endMs: number | null }>()
  private readonly excluded = new Set<number>()
  private revision = 0
  private sampleRate = 0
  private snapshot: LiveSnapshot = { phase: 'connecting', text: '', reason: null,
    usage: { inputTokens: null, outputTokens: null, audioSeconds: null }, requestSeconds: null }
  private readonly startedAt = performance.now()
  private disposed = false
  private readonly capture: PcmInput
  private captured = 0
  private holding = false
  private readonly staged: { pcm: Uint8Array; start: number }[] = []
  private checking: Promise<void> | undefined
  private requestedFinish = false
  private streamRequested = false

  constructor(private readonly remote: Pick<ClientRemote['speech'], 'stream'>, device: string,
    private readonly changed: (snapshot: LiveSnapshot) => void, private readonly released: () => void,
    createCapture = (id: string) => new PcmCapture(id, () => {}), private readonly mode?: LiveMode) {
    this.capture = mode?.capture ?? createCapture(device)
  }

  private publish(patch: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    if (!this.disposed) this.changed(this.snapshot)
  }

  /** Current task phase; checking retains the same physical recognition stream. */
  get phase(): LiveSnapshot['phase'] { return this.snapshot.phase }

  /** Current hypothesis identity; only actual transcript updates invalidate a semantic result. */
  get transcriptRevision(): number { return this.revision }

  /** Current local request, PCM acknowledgement and last provider usage; includes no transcript or audio. */
  get observation(): RecognitionObservation {
    return { requested: this.streamRequested, phase: this.snapshot.phase, usage: this.snapshot.usage,
      uploadedSamples: this.samples, acceptedSamples: this.accepted }
  }

  /** Exclude only immutable, time-aligned recognition segments through a confirmed cutoff.
   * @param samples - task-local PCM cutoff.
   * @returns false when text cannot be safely separated; no segment is then removed.
   */
  excludeThrough(samples: number): boolean {
    const entries = [...this.sentences].filter(([id]) => !this.excluded.has(id))
    if (!entries.length || entries.some(([, item]) => !item.final || item.endMs === null
      || item.endMs * this.sampleRate / 1000 > samples)) return false
    for (const [id] of entries) this.excluded.add(id)
    this.revision++
    this.publish({ text: '' })
    return true
  }

  private endingRequested(): boolean { return this.requestedFinish }

  private upload(pcm: Uint8Array, startSample: number): void {
    if (!this.handle || !this.limits || startSample !== this.samples
      || this.samples - this.accepted + pcm.length / 2 > this.limits.maxPendingSamples) throw new PcmCaptureFailure('limit')
    this.handle.send({ kind: 'audio', sequence: this.sequence++, startSample, audioBase64: audioBase64(pcm) })
    this.samples += pcm.length / 2
    if (this.creditTimer === undefined) this.armCreditTimeout()
  }

  private capturedFrame(pcm: Uint8Array, startSample: number): void {
    if (this.abort.signal.aborted) return
    if (startSample !== this.captured) throw new PcmCaptureFailure('protocol')
    this.captured += pcm.length / 2
    this.mode?.audio(pcm, startSample)
    if (this.holding) this.staged.push({ pcm, start: startSample })
    else this.upload(pcm, startSample)
  }

  private drainStaged(cutoff: number): void {
    for (const frame of this.staged) {
      if (frame.start >= cutoff) break
      if (frame.start + frame.pcm.length / 2 > cutoff) throw new PcmCaptureFailure('protocol')
      this.upload(frame.pcm, frame.start)
    }
    this.staged.length = 0
    if (this.samples !== cutoff) throw new PcmCaptureFailure('protocol')
  }

  private async modeResult(pending: Promise<boolean>): Promise<boolean> {
    this.abort.signal.throwIfAborted()
    const stopped = Promise.withResolvers<never>()
    const abort = (): void => { stopped.reject(this.abort.signal.reason) }
    this.abort.signal.addEventListener('abort', abort, { once: true })
    try { return await Promise.race([pending, stopped.promise]) }
    finally { this.abort.signal.removeEventListener('abort', abort) }
  }

  private fail(error: unknown): void {
    if (this.abort.signal.aborted) return
    const remote = remoteErrorOf(error)
    const details = remote?.details
    const reason = error instanceof RecordingError ? error.kind : error instanceof PcmCaptureFailure ? error.reason
      : details && 'reason' in details && typeof details.reason === 'string' ? details.reason : 'unknown'
    this.stop(reason, this.snapshot.usage)
  }

  private stop(reason: string, usage: SpeechUsage): void {
    if (this.abort.signal.aborted) return
    this.publish({ phase: 'failed', reason, usage, requestSeconds: (performance.now() - this.startedAt) / 1000 })
    this.abort.abort(); this.handle?.dispose()
    clearTimeout(this.timer); clearTimeout(this.creditTimer)
    void this.capture.dispose().catch((_closeFailure: unknown) => { /* Capture already stopped all tracks. */ })
  }

  /** Begin a physical non-reconnecting task from a user gesture.
   * @param selection - snapshot of the chosen provider and language.
   * @param sampleRate - advertised input format.
   */
  start(selection: SpeechSelection, sampleRate: number): void {
    if (this.run) throw new Error('Live recognition is already started')
    this.sampleRate = sampleRate
    this.run = (async () => {
      try {
        await this.capture.prepare(sampleRate)
        this.abort.signal.throwIfAborted()
        this.streamRequested = true
        const handle = this.remote.stream(selection, this.abort.signal)
        this.handle = handle
        let ready = false, done = false
        for await (const frame of handle) {
          this.abort.signal.throwIfAborted()
          switch (frame.kind) {
            case 'ready': {
              if (ready || frame.sampleRate !== sampleRate) throw new PcmCaptureFailure('protocol')
              ready = true; this.limits = frame.limits
              this.timer = setTimeout(() => {
                if (this.snapshot.phase === 'listening' || this.checking) void this.finish('limit')
                else this.fail(new PcmCaptureFailure('timeout'))
              }, frame.maxDurationSeconds * 1000)
              const frameReceived = (pcm: Uint8Array, startSample: number): void => { this.capturedFrame(pcm, startSample) }
              void this.capture.start(sampleRate, frame.limits, frameReceived,
                (error) => { this.fail(error) }, this.mode ? frameReceived : undefined).then(() => {
                if (!this.abort.signal.aborted) this.publish({ phase: 'listening' })
              }, (error: unknown) => { this.fail(error) })
              break
            }
            case 'accepted':
              if (!Number.isSafeInteger(frame.bytes) || frame.bytes % 2 || frame.bytes / 2 < this.accepted || frame.bytes / 2 > this.samples) throw new PcmCaptureFailure('protocol')
              this.accepted = frame.bytes / 2; this.capture.accept(this.accepted)
              clearTimeout(this.creditTimer); this.creditTimer = undefined
              if (this.accepted < this.samples) this.armCreditTimeout()
              break
            case 'sentence': {
              const previous = this.sentences.get(frame.id)
              if (previous?.final && (previous.text !== frame.text || !frame.final)) throw new PcmCaptureFailure('protocol')
              if (previous?.text !== frame.text || previous.final !== frame.final
                || previous.beginMs !== frame.beginMs || previous.endMs !== frame.endMs) this.revision++
              this.sentences.set(frame.id, { text: frame.text, final: frame.final, beginMs: frame.beginMs, endMs: frame.endMs })
              const text = [...this.sentences].filter(([id]) => !this.excluded.has(id)).sort(([a], [b]) => a - b)
                .map(([, value]) => value.text).join('')
              const retainedBytes = [...this.sentences.values()]
                .reduce((sum, item) => sum + new TextEncoder().encode(item.text).byteLength, 0)
              if (!this.limits || retainedBytes + this.sentences.size * 64 > this.limits.maxTranscriptBytes) {
                throw new PcmCaptureFailure('limit')
              }
              this.publish({ text }); break
            }
            case 'usage': this.publish({ usage: frame.usage }); break
            case 'failed': this.stop(frame.reason, frame.usage); return
            case 'done':
              if (this.snapshot.phase !== 'finishing' || [...this.sentences.values()].some(value => !value.final)) throw new PcmCaptureFailure('protocol')
              done = true; this.publish({ phase: 'done', usage: frame.usage, requestSeconds: (performance.now() - this.startedAt) / 1000 }); break
          }
        }
        if (!done) throw new PcmCaptureFailure('protocol')
      } catch (error) { this.fail(error) }
      finally {
        clearTimeout(this.timer); clearTimeout(this.creditTimer)
        try { if (!this.mode || this.snapshot.phase !== 'done') await this.capture.dispose() } finally { this.released() }
      }
    })()
    void this.run.catch((error: unknown) => { this.fail(error) })
  }

  private armCreditTimeout(): void {
    const limits = this.limits
    if (limits === undefined) throw new Error('Recognition limits are unavailable')
    this.creditTimer = setTimeout(() => { this.fail(new PcmCaptureFailure('timeout')) }, limits.consumerTimeoutMs)
  }

  /** Mark transport loss visibly before releasing capture; reconnect never restarts this task. */
  disconnect(): void { this.fail(new RecordingError('interrupted')) }

  /** Review automatic completion without ending or reconnecting the physical ASR task.
   * @returns after normal waiting resumes, final recognition starts, or an owned failure is reported.
   */
  async checkEnd(): Promise<void> {
    if (this.checking) return this.checking
    if (!this.mode || !this.limits || this.snapshot.phase !== 'listening') return
    const mode = this.mode, limits = this.limits
    const operation = (async () => {
      let parked = false, committed = false
      this.holding = true
      this.publish({ phase: 'checking' })
      try {
        const checkpoint = await this.capture.checkpointAt('park', limits.consumerTimeoutMs)
        parked = true
        if (this.endingRequested() || !await this.modeResult(mode.review(checkpoint))) return
        if (this.endingRequested()) return
        const cutoff = await this.capture.checkpointAt('checkpoint', limits.consumerTimeoutMs)
        if (this.endingRequested() || !await this.modeResult(mode.seal(cutoff, false))) return
        if (this.endingRequested()) return
        const covered = await this.capture.checkpointAt('lock', limits.consumerTimeoutMs)
        if (this.endingRequested()) return
        this.publish({ phase: 'finishing' })
        if (!await this.modeResult(mode.commit(cutoff, covered))) return
        committed = true; clearTimeout(this.timer)
        const actual = await this.capture.finish(limits.consumerTimeoutMs, true, true)
        this.abort.signal.throwIfAborted()
        if (actual !== covered || actual !== this.captured) throw new PcmCaptureFailure('protocol')
        this.drainStaged(cutoff)
        this.publish({ endReason: 'model' })
        this.handle?.send({ kind: 'finish', samples: cutoff }); this.handle?.end()
        this.mode?.handoff?.()
      } catch (error) { this.fail(error) }
      finally {
        if (!committed && !this.abort.signal.aborted) {
          try {
            if (parked) await this.capture.checkpointAt('resume', limits.consumerTimeoutMs)
            this.holding = false; this.drainStaged(this.captured)
            this.publish({ phase: 'listening' })
          } catch (error) { this.fail(error) }
        }
      }
    })()
    this.checking = operation
    try { await operation }
    finally { this.checking = undefined }
  }

  /** Flush the Worklet before the ordered finish command; results remain preview-only.
   * @param reason - explicit user action, accepted model candidate or resource limit.
   * @returns after local capture closure and finish admission, not server recognition completion.
   */
  async finish(reason: 'explicit' | 'model' | 'limit' = 'explicit'): Promise<void> {
    if (reason === 'model') return this.checkEnd()
    if (this.checking) {
      if (reason === 'limit') { this.stop('limit', this.snapshot.usage); return }
      this.requestedFinish = true
      await this.checking
      this.requestedFinish = false
    }
    if (this.snapshot.phase !== 'listening' || !this.handle || !this.limits) return
    this.publish({ phase: 'finishing', endReason: reason }); clearTimeout(this.timer)
    try {
      const samples = await this.capture.finish(this.limits.consumerTimeoutMs, this.mode !== undefined && reason !== 'limit')
      this.abort.signal.throwIfAborted()
      if (samples !== this.samples) throw new PcmCaptureFailure('protocol')
      if (this.mode && reason !== 'limit' && !await this.modeResult(this.mode.seal(samples, true))) throw new PcmCaptureFailure('protocol')
      this.handle.send({ kind: 'finish', samples })
      this.handle.end()
      this.mode?.handoff?.()
    } catch (error) { this.fail(error) }
  }

  /** Stop without inserting text or replaying input, then join owned work.
   * @returns after physical Remote and audio cleanup.
   */
  async dispose(): Promise<void> {
    this.disposed = true; this.abort.abort(); this.handle?.dispose()
    clearTimeout(this.timer); clearTimeout(this.creditTimer)
    const outcomes = await Promise.allSettled([this.capture.dispose(), this.run, this.checking])
    this.sentences.clear(); this.released()
    this.staged.length = 0
    const failure = outcomes.find(outcome => outcome.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason instanceof Error ? failure.reason : new Error('Voice input cleanup failed')
  }
}
