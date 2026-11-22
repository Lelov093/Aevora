/** Continuous microphone capture; the AudioWorklet owns sample batching and credit bounds. */
import { RecordingError } from './audio.ts'
import type { SpeechStreamLimits } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'

/** Sanitized capture/credit failure translated by the live-preview owner. */
export class PcmCaptureFailure extends Error {
  constructor(readonly reason: 'limit' | 'protocol' | 'timeout' | 'uncertain') { super(reason) }
}

/** One live microphone acquisition, including a late permission grant. */
export class PcmCapture {
  private readonly lifetime = new AbortController()
  private media: MediaStream | undefined
  private context: AudioContext | undefined
  private node: AudioWorkletNode | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private disposal: Promise<void> | undefined
  private finished = Promise.withResolvers<number>()
  private samples = 0
  private stopping = false
  private captureFailed: ((error: unknown) => void) | undefined
  private checkpoint: { kind: 'parked' | 'checkpointed' | 'locked' | 'resumed'; resolve: (samples: number) => void; reject: (error: unknown) => void } | undefined

  constructor(private readonly deviceId: string, private readonly onDispose: () => void) {
    void this.finished.promise.catch((_cancelled: unknown) => { /* finish() or the recording owner reports the failure. */ })
  }

  /** Prepare audio permission from the start gesture before opening a Remote task.
   * @param sampleRate - target browser resampling rate.
   * @returns after the AudioContext resumes, without acquiring a microphone.
   */
  async prepare(sampleRate: number): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    if (this.context) { await this.context.resume(); return }
    if (typeof AudioContext === 'undefined') throw new RecordingError('unavailable')
    try { this.context = new AudioContext({ sampleRate }) }
    catch (error) {
      if (error instanceof DOMException && error.name === 'NotSupportedError') throw new RecordingError('unavailable')
      throw error
    }
    if (this.context.sampleRate !== sampleRate) { await this.dispose(); throw new RecordingError('unavailable') }
    await this.context.resume()
    this.lifetime.signal.throwIfAborted()
  }

  /** Acquire a microphone after a user gesture and load the authenticated same-origin script.
   * @param sampleRate - provider-required native resampling rate.
   * @param limits - Host-resolved bounded PCM format.
   * @param onFrame - ordered PCM16 frame handler; throwing stops capture.
   * @param onError - one terminal failure notification; no automatic reacquisition.
   * @param onStaged - mode-owned lookahead; absent for ordinary recording.
   * @returns after the device and Worklet are ready.
   */
  async start(sampleRate: number, limits: SpeechStreamLimits,
    onFrame: (pcm: Uint8Array, startSample: number) => void, onError: (error: unknown) => void,
    onStaged?: (pcm: Uint8Array, startSample: number) => void): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    const fail = (error: unknown): void => {
      if (this.lifetime.signal.aborted) return
      this.finished.reject(error)
      this.checkpoint?.reject(error)
      void this.dispose().catch((_closeFailure: unknown) => { /* Tracks are stopped synchronously before context closure. */ })
      onError(error)
    }
    this.captureFailed = fail
    try {
      const devices = (navigator as Partial<Navigator>).mediaDevices
      if (!devices || typeof AudioWorkletNode === 'undefined') throw new RecordingError('unavailable')
      if (this.context === undefined) await this.prepare(sampleRate)
      this.lifetime.signal.throwIfAborted()
      const media = this.media ?? await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true,
        ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}) }, video: false })
      if (this.lifetime.signal.aborted) { for (const track of media.getTracks()) track.stop(); throw new RecordingError('cancelled') }
      const acquired = this.media !== media
      this.media = media
      for (const track of media.getTracks()) track.enabled = true
      this.stopping = false; this.samples = 0
      this.finished = Promise.withResolvers<number>()
      void this.finished.promise.catch((_cancelled: unknown) => { /* The recording owner reports cancellation. */ })
      if (acquired) for (const track of media.getTracks()) track.addEventListener('ended', () => { this.captureFailed?.(new RecordingError('interrupted')) }, { signal: this.lifetime.signal })
      const context = this.context
      if (context === undefined) throw new RecordingError('cancelled')
      await context.audioWorklet.addModule(new URL('./api/voice-input.pcm-worklet.js', document.baseURI).href, { credentials: 'same-origin' })
      this.lifetime.signal.throwIfAborted()
      const node = new AudioWorkletNode(context, 'aevora-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { frameSamples: limits.maxFrameSamples, maxPendingSamples: limits.maxPendingSamples } })
      this.node = node
      node.onprocessorerror = () => { fail(new RecordingError('interrupted')) }
      node.port.onmessage = (event: MessageEvent<unknown>) => {
        if (this.lifetime.signal.aborted) return
        try {
          const value = event.data
          if (typeof value !== 'object' || value === null || !('kind' in value)) throw new PcmCaptureFailure('protocol')
          if (value.kind === 'overflow') throw new PcmCaptureFailure('limit')
          if (['parked', 'checkpointed', 'locked', 'resumed'].includes(String(value.kind))) {
            const checkpoint = this.checkpoint
            if (!checkpoint || value.kind !== checkpoint.kind || !('samples' in value) || value.samples !== this.samples) throw new PcmCaptureFailure('protocol')
            this.checkpoint = undefined; checkpoint.resolve(this.samples); return
          }
          if (value.kind === 'finished') {
            if (!this.stopping || !('samples' in value) || value.samples !== this.samples) throw new PcmCaptureFailure('protocol')
            this.finished.resolve(this.samples); return
          }
          if ((value.kind !== 'audio' && value.kind !== 'staged') || !('pcm' in value) || !(value.pcm instanceof Int16Array) || value.pcm.length === 0
            || value.pcm.length > limits.maxFrameSamples || !('startSample' in value) || value.startSample !== this.samples) throw new PcmCaptureFailure('protocol')
          // DataView makes the wire PCM little-endian regardless of the host architecture.
          const pcm = new Uint8Array(value.pcm.length * 2), view = new DataView(pcm.buffer)
          for (const [i, sample] of value.pcm.entries()) view.setInt16(i * 2, sample, true)
          this.samples += value.pcm.length
          if (value.kind === 'staged') {
            if (!onStaged) throw new PcmCaptureFailure('protocol')
            onStaged(pcm, value.startSample)
          } else onFrame(pcm, value.startSample)
        } catch (error) { fail(error) }
      }
      this.source = context.createMediaStreamSource(media)
      this.source.connect(node); node.connect(context.destination)
    } catch (error) {
      await this.dispose()
      if (error instanceof DOMException && error.name === 'NotAllowedError') throw new RecordingError('permission')
      if (error instanceof DOMException && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw new RecordingError('deviceMissing')
      throw error
    }
  }

  /** Release Worklet credit only after the Host writes audio into the provider socket.
   * @param samples - cumulative accepted sample count, not recognition progress.
   */
  accept(samples: number): void { this.node?.port.postMessage({ kind: 'credit', samples }) }

  /** Place a reversible cutoff on a real Silero window, or resume the same Worklet.
   * @param kind - park keeps VAD lookahead active; lock retains subsequent rollback audio locally.
   * @param timeoutMs - owner-resolved receipt deadline.
   * @returns actual emitted sample position after the ordered receipt.
   */
  async checkpointAt(kind: 'park' | 'checkpoint' | 'lock' | 'resume', timeoutMs: number): Promise<number> {
    this.lifetime.signal.throwIfAborted()
    if (!this.node || this.stopping || this.checkpoint) throw new PcmCaptureFailure('protocol')
    const pending = Promise.withResolvers<number>()
    this.checkpoint = { kind: kind === 'park' ? 'parked' : kind === 'lock' ? 'locked' : kind === 'resume' ? 'resumed' : 'checkpointed', ...pending }
    const timer = setTimeout(() => { pending.reject(new PcmCaptureFailure('timeout')) }, timeoutMs)
    this.node.port.postMessage({ kind })
    try { return await pending.promise }
    finally { clearTimeout(timer); this.checkpoint = undefined }
  }

  /** Flush admitted samples before releasing the microphone.
   * @param timeoutMs - maximum wait for the Worklet flush receipt.
   * @param retainDevice - disable and retain the same device for a mode-owned next task.
   * @param committed - close an already locked review instead of flushing a live recording.
   * @returns cumulative emitted samples after resources settle; rollback-only audio is excluded.
   */
  async finish(timeoutMs: number, retainDevice = false, committed = false): Promise<number> {
    if (!this.node || this.stopping) throw new RecordingError('cancelled')
    this.stopping = true
    const timer = setTimeout(() => { this.finished.reject(new RecordingError('interrupted')) }, timeoutMs)
    this.node.port.postMessage({ kind: committed ? 'commit' : 'finish' })
    try { return await this.finished.promise }
    finally {
      clearTimeout(timer)
      if (retainDevice && !this.lifetime.signal.aborted) {
        for (const track of this.media?.getTracks() ?? []) track.enabled = false
        this.node.port.onmessage = null; this.node.port.close(); this.node.disconnect(); this.node = undefined
        this.source?.disconnect(); this.source = undefined
      } else await this.dispose()
    }
  }

  /** Cancel and join context closure. Late permission grants stop themselves immediately.
   * @returns shared cleanup completion.
   */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.lifetime.abort(new RecordingError('cancelled')); this.finished.reject(new RecordingError('cancelled'))
    this.checkpoint?.reject(new RecordingError('cancelled'))
    for (const track of this.media?.getTracks() ?? []) track.stop()
    this.media = undefined
    if (this.node) { this.node.port.onmessage = null; this.node.port.close(); this.node.disconnect(); this.node = undefined }
    this.source?.disconnect(); this.source = undefined
    const context = this.context; this.context = undefined
    this.disposal = (async () => { try { if (context && context.state !== 'closed') await context.close() } finally { this.onDispose() } })()
    return this.disposal
  }
}
