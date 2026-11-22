/** Bounded TTS Remote orchestration; native Gateway owns authentication and transport. */
import { TtsFailure } from '@deepseek-ai/dsh-text-to-speech'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import type { TtsStreamSpec, TtsTaskId, TtsUsage, TtsTextPiece } from '@deepseek-ai/dsh-text-to-speech/types'
import type { TtsStreamCommand, TtsStreamFrame, TtsStreamLimits } from './types.ts'

function cancellable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason instanceof Error ? signal.reason : new DOMException('Speech cancelled', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    pending.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error instanceof Error ? error : new TtsFailure('protocol')) })
    if (signal.aborted) abort()
  })
}

/** One side-effecting stream; its inputs are never replayed after transport loss. */
export class TtsStreamOperation {
  private readonly lifetime = new AbortController()
  private readonly signal: AbortSignal
  private readonly frames: TtsStreamFrame[] = []
  private readonly text: { sequence?: number; piece: TtsTextPiece; bytes: number }[] = []
  private wake = Promise.withResolvers<void>()
  private inputWake = Promise.withResolvers<void>()
  private credit = Promise.withResolvers<void>()
  private readonly usage = new Map<TtsTaskId, TtsUsage>()
  private textEnded = false
  private finished = false
  private failure: Error | undefined
  private pendingTextBytes = 0
  private textBytes = 0
  private textOffset = 0
  private inputSequence = 0
  private audioSequence = 0
  private sentSamples = 0
  private playedSamples = 0

  constructor(private readonly ctx: Context, private readonly spec: TtsStreamSpec,
    private readonly limits: TtsStreamLimits, caller: AbortSignal) {
    this.signal = AbortSignal.any([caller, this.lifetime.signal, spec.signal])
  }

  private push(frame: TtsStreamFrame): void {
    this.signal.throwIfAborted()
    if (this.frames.length >= this.limits.maxBufferedFrames) throw new TtsFailure('limit', this.observedUsage())
    this.frames.push(frame)
    this.wake.resolve()
  }

  private async receive(input: AsyncIterable<TtsStreamCommand>): Promise<void> {
    const iterator = input[Symbol.asyncIterator]()
    while (true) {
      const item = await cancellable(iterator.next(), this.signal)
      if (item.done) {
        if (!this.textEnded) throw new TtsFailure('protocol', this.observedUsage())
        return
      }
      const command = item.value
      switch (command.kind) {
        case 'text': {
          if (this.textEnded || command.sequence !== this.inputSequence || command.offset !== this.textOffset || !command.text.trim()) {
            throw new TtsFailure('protocol', this.observedUsage())
          }
          const bytes = Buffer.byteLength(command.text)
          this.pendingTextBytes += bytes
          this.textBytes += bytes
          if (this.pendingTextBytes > this.limits.maxPendingTextBytes || this.textBytes > this.limits.maxTextBytes) {
            throw new TtsFailure('limit', this.observedUsage())
          }
          this.inputSequence++
          this.textOffset += command.text.length
          this.text.push({ sequence: command.sequence, piece: { kind: 'text', text: command.text }, bytes })
          this.inputWake.resolve()
          break
        }
        case 'finish':
          if (this.textEnded) throw new TtsFailure('protocol', this.observedUsage())
          this.textEnded = true
          this.inputWake.resolve()
          break
        case 'boundary':
          if (this.textEnded || this.text.length >= this.limits.maxBufferedFrames) throw new TtsFailure('limit', this.observedUsage())
          this.text.push({ piece: { kind: 'boundary' }, bytes: 0 })
          this.inputWake.resolve()
          break
        case 'played':
          if (!Number.isSafeInteger(command.samples) || command.samples < this.playedSamples || command.samples > this.sentSamples) {
            throw new TtsFailure('protocol', this.observedUsage())
          }
          this.playedSamples = command.samples
          this.credit.resolve()
          this.credit = Promise.withResolvers<void>()
          break
        default: assertNever(command)
      }
    }
  }

  private async *prose(): AsyncIterable<TtsTextPiece> {
    while (true) {
      this.signal.throwIfAborted()
      const next = this.text.shift()
      if (next !== undefined) {
        this.pendingTextBytes -= next.bytes
        if (next.sequence !== undefined) this.push({ kind: 'text-accepted', sequence: next.sequence })
        yield next.piece
        continue
      }
      if (this.textEnded) return
      await cancellable(this.inputWake.promise, this.signal)
      this.inputWake = Promise.withResolvers<void>()
    }
  }

  private async waitForPlayback(predicate: () => boolean): Promise<void> {
    while (predicate()) {
      const deadline = new AbortController()
      const timer = setTimeout(() => { deadline.abort(new TtsFailure('timeout', this.observedUsage())) }, this.limits.consumerTimeoutMs)
      try { await cancellable(this.credit.promise, AbortSignal.any([this.signal, deadline.signal])) }
      finally { clearTimeout(timer) }
    }
  }

  private async synthesize(): Promise<void> {
    let sampleRate = 0
    for await (const event of this.ctx.textToSpeech.stream(this.spec, this.prose(), this.signal)) {
      if (event.kind === 'task-started') {
        if (sampleRate !== 0 && sampleRate !== event.sampleRate) throw new TtsFailure('protocol', this.observedUsage())
        sampleRate = event.sampleRate
      }
      if (event.kind === 'usage' || event.kind === 'task-finished') this.usage.set(event.taskId, event.usage)
      if (event.kind !== 'audio') { this.push(event); continue }
      if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || event.pcm.byteLength % 2) {
        throw new TtsFailure('protocol', this.observedUsage())
      }
      const samplesPerChunk = Math.max(1, Math.floor(sampleRate * this.limits.maxAudioChunkMs / 1000))
      const window = Math.max(samplesPerChunk, Math.floor(sampleRate * this.limits.maxQueuedAudioMs / 1000))
      for (let offset = 0; offset < event.pcm.byteLength; offset += samplesPerChunk * 2) {
        const chunk = event.pcm.subarray(offset, offset + samplesPerChunk * 2)
        await this.waitForPlayback(() => this.sentSamples - this.playedSamples + chunk.byteLength / 2 > window)
        const startSample = this.sentSamples
        this.sentSamples += chunk.byteLength / 2
        this.push({ kind: 'audio', taskId: event.taskId, sequence: this.audioSequence++, startSample,
          sampleRate, audioBase64: Buffer.from(chunk).toString('base64') })
      }
    }
    await this.waitForPlayback(() => this.playedSamples < this.sentSamples)
    this.push({ kind: 'done', samples: this.sentSamples })
    this.finished = true
    this.wake.resolve()
  }

  private observedUsage(): TtsUsage {
    const total = (key: keyof TtsUsage): number | null => {
      if (this.usage.size === 0) return null
      let sum = 0
      for (const usage of this.usage.values()) { if (usage[key] === null) return null; sum += usage[key] }
      return sum
    }
    return { inputTokens: total('inputTokens'), outputTokens: total('outputTokens'), characters: total('characters') }
  }

  private fail(error: unknown): void {
    if (this.signal.aborted) return
    this.failure = error instanceof Error ? error : new TtsFailure('protocol', this.observedUsage())
    this.lifetime.abort(error)
    this.wake.resolve()
  }

  /** Start both native directions, yield output, and join all owned work on release.
   * @param input - Gateway-validated command stream.
   * @returns ordered frames without transport-level retry.
   */
  async *run(input: AsyncIterable<TtsStreamCommand>): AsyncIterable<TtsStreamFrame> {
    const receive = this.receive(input).catch((error: unknown) => { this.fail(error) })
    const synthesize = this.synthesize().catch((error: unknown) => { this.fail(error) })
    try {
      yield { kind: 'ready', limits: this.limits }
      while (true) {
        if (this.failure !== undefined) throw this.failure
        this.signal.throwIfAborted()
        const frame = this.frames.shift()
        if (frame !== undefined) { yield frame; continue }
        if (this.finished) return
        await cancellable(this.wake.promise, this.signal)
        this.wake = Promise.withResolvers<void>()
      }
    } finally {
      this.lifetime.abort()
      await Promise.allSettled([receive, synthesize])
      this.frames.length = 0
      this.text.length = 0
    }
  }
}
