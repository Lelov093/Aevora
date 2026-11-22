/** One official Qwen task with bounded pending output and awaited socket release. */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { z } from 'zod'
import { TtsFailure } from '@deepseek-ai/dsh-text-to-speech'
import type { TtsStreamEvent, TtsTaskId, TtsUsage } from '@deepseek-ai/dsh-text-to-speech/types'
import type { QwenOptions } from './provider.ts'

const eventSchema = z.object({
  header: z.object({ task_id: z.string(), event: z.string() }),
  payload: z.unknown().optional(),
})
const usagePayloadSchema = z.object({
  usage: z.object({ input_tokens: z.number().int().nonnegative().nullish(), output_tokens: z.number().int().nonnegative().nullish(),
    characters: z.number().int().nonnegative().nullish() }).nullish(),
}).optional()
const resultPayloadSchema = z.object({
  output: z.object({ type: z.enum(['sentence-begin', 'sentence-synthesis', 'sentence-end']), original_text: z.string().optional(),
    sentence: z.object({ index: z.number().int().nonnegative(), words: z.array(z.object({
      text: z.string(), begin_index: z.number().int().nonnegative(), end_index: z.number().int().nonnegative(),
      begin_time: z.number().nonnegative(), end_time: z.number().nonnegative(),
    })).optional() }).optional(),
  }),
})

/** Await a caller-owned read without retaining cancellation listeners.
 * @param pending - the single outstanding input read, retained across normal task rotation.
 * @param signal - operation lifetime.
 * @param idleMs - optional normal input-idle deadline.
 * @returns input, or undefined at the idle boundary.
 */
export function waitForInput<T>(pending: Promise<T>, signal: AbortSignal, idleMs?: number): Promise<T | undefined> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const abort = (): void => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new DOMException('Speech cancelled', 'AbortError')) }
    const timer = idleMs === undefined ? undefined : setTimeout(() => { cleanup(); resolve(undefined) }, idleMs)
    signal.addEventListener('abort', abort, { once: true })
    pending.then((value) => { cleanup(); resolve(value) }, (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new TtsFailure('protocol')) })
    if (signal.aborted) abort()
  })
}

/** One task's socket, bounded output, protocol phase and cleanup. */
export class QwenTask implements AsyncIterable<TtsStreamEvent> {
  /** One protocol task identity, never reused after failure. */
  readonly id = randomUUID() as TtsTaskId
  /** Resolves only after task-started, rejects on failed admission. */
  readonly ready = Promise.withResolvers<void>()
  private readonly released = Promise.withResolvers<void>()
  private readonly lifetime = new AbortController()
  /** Caller and task lifetime, including text-idle producer cleanup. */
  readonly signal: AbortSignal
  private readonly socket: WebSocket
  private readonly totalTimer: ReturnType<typeof setTimeout>
  private audioTimer: ReturnType<typeof setTimeout> | undefined
  private phase: 'connecting' | 'running' | 'finished' | 'failed' = 'connecting'
  private readonly frames: { frame: TtsStreamEvent; bytes: number }[] = []
  private wake = Promise.withResolvers<void>()
  private error: unknown
  private queuedBytes = 0
  private audioBytes = 0
  private characters = 0
  private inputEnded = false
  private remainder: Buffer | undefined
  private usage: TtsUsage = { inputTokens: null, outputTokens: null, characters: null }

  constructor(private readonly options: QwenOptions, caller: AbortSignal) {
    this.signal = AbortSignal.any([caller, this.lifetime.signal])
    this.signal.throwIfAborted()
    this.socket = new WebSocket(options.endpoint, { headers: { Authorization: `Bearer ${options.key}` },
      handshakeTimeout: options.handshakeMs, maxPayload: options.maxFrameBytes, followRedirects: false })
    this.totalTimer = setTimeout(() => { this.fail(new TtsFailure('timeout', this.usage)) }, options.timeoutMs)
    void this.ready.promise.catch((_notStarted: unknown) => { /* Output iteration reports the same task failure. */ })
    this.signal.addEventListener('abort', this.abort, { once: true })
    this.socket.on('error', () => { this.fail(new TtsFailure('network', this.usage, 'connection')) })
    this.socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode
      response.resume()
      this.fail(new TtsFailure(status === 401 || status === 403 ? 'authentication' : 'network', this.usage, 'connection'))
    })
    this.socket.on('close', () => {
      if (this.phase !== 'finished' && this.phase !== 'failed') this.fail(new TtsFailure('network', this.usage, 'connection'))
      this.released.resolve()
    })
    this.socket.on('open', () => {
      if (this.phase !== 'connecting') return
      this.send('run-task', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: options.model,
        parameters: { text_type: 'PlainText', voice: options.voice, format: 'pcm', sample_rate: options.sampleRate,
          rate: options.rate }, input: {} })
    })
    this.socket.on('message', (data, binary) => {
      if (this.phase === 'finished' || this.phase === 'failed') return
      const frame = Array.isArray(data) ? Buffer.concat(data)
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
      if (binary) { this.audio(frame); return }
      let event: z.infer<typeof eventSchema>
      try { event = eventSchema.parse(JSON.parse(frame.toString('utf8'))) }
      catch (_invalidEvent) { this.fail(new TtsFailure('protocol', this.usage, 'event')); return }
      if (event.header.task_id !== this.id) { this.fail(new TtsFailure('protocol', this.usage, 'event')); return }
      const payload = usagePayloadSchema.safeParse(event.payload)
      if (!payload.success) { this.fail(new TtsFailure('protocol', this.usage, 'event')); return }
      const measured = payload.data?.usage
      if (measured != null) {
        this.usage = { inputTokens: measured.input_tokens ?? this.usage.inputTokens,
          outputTokens: measured.output_tokens ?? this.usage.outputTokens, characters: measured.characters ?? this.usage.characters }
        if (!this.push({ kind: 'usage', taskId: this.id, usage: this.usage })) return
      }
      switch (event.header.event) {
        case 'task-started':
          if (this.phase !== 'connecting') { this.fail(new TtsFailure('protocol', this.usage, 'event')); return }
          this.phase = 'running'
          this.push({ kind: 'task-started', taskId: this.id, sampleRate: options.sampleRate })
          this.ready.resolve()
          break
        case 'result-generated': {
          if (this.phase !== 'running') { this.fail(new TtsFailure('protocol', this.usage, 'event')); return }
          const result = resultPayloadSchema.safeParse(event.payload)
          if (!result.success) { this.fail(new TtsFailure('protocol', this.usage, 'event')); return }
          const output = result.data.output
          if (output.type === 'sentence-end' && output.sentence !== undefined && output.original_text !== undefined) {
            this.push({ kind: 'sentence', taskId: this.id, index: output.sentence.index, text: output.original_text,
              words: (output.sentence.words ?? []).map(word => ({ text: word.text, beginIndex: word.begin_index,
                endIndex: word.end_index, beginTimeMs: word.begin_time, endTimeMs: word.end_time })) })
          }
          break
        }
        case 'task-finished':
          if (this.phase !== 'running' || this.audioBytes === 0 || this.remainder !== undefined) {
            this.fail(new TtsFailure('protocol', this.usage, 'audio')); return
          }
          clearTimeout(this.audioTimer)
          if (!this.push({ kind: 'task-finished', taskId: this.id, usage: this.usage })) return
          this.phase = 'finished'
          this.socket.close()
          break
        case 'task-failed': this.fail(new TtsFailure('provider', this.usage)); break
        default: this.fail(new TtsFailure('protocol', this.usage, 'event'))
      }
    })
    if (this.signal.aborted) this.abort()
  }

  private readonly abort = (): void => { this.fail(this.signal.reason) }

  private push(frame: TtsStreamEvent): boolean {
    const bytes = frame.kind === 'audio' ? frame.pcm.byteLength : Buffer.byteLength(JSON.stringify(frame))
    this.queuedBytes += bytes
    if (this.queuedBytes > this.options.maxBufferedAudioBytes) { this.fail(new TtsFailure('limit', this.usage)); return false }
    this.frames.push({ frame, bytes })
    this.socket.pause()
    this.wake.resolve()
    return true
  }

  private audio(frame: Buffer): void {
    if (this.phase !== 'running') { this.fail(new TtsFailure('protocol', this.usage)); return }
    const combined = this.remainder === undefined ? frame : Buffer.concat([this.remainder, frame])
    const size = combined.length - combined.length % 2
    this.remainder = size === combined.length ? undefined : Buffer.from(combined.subarray(size))
    this.audioBytes += frame.length
    if (size > 0) this.push({ kind: 'audio', taskId: this.id, pcm: combined.subarray(0, size) })
    this.watchAudio()
  }

  private watchAudio(): void {
    clearTimeout(this.audioTimer)
    this.audioTimer = setTimeout(() => { this.fail(new TtsFailure('timeout', this.usage, 'audio')) }, this.options.audioIdleMs)
  }

  private send(action: string, payload: object): void {
    this.socket.send(JSON.stringify({ header: { action, task_id: this.id, streaming: 'duplex' }, payload }), (error: unknown) => {
      if (error) this.fail(new TtsFailure('network', this.usage))
    })
  }

  /** Send text after task admission, splitting only at the official message limit.
   * @param text - nonempty plain text.
   */
  append(text: string): void {
    if (this.phase !== 'running' || this.inputEnded) throw new TtsFailure('protocol', this.usage)
    const points = Array.from(text)
    this.characters += points.length
    if (points.length === 0 || this.characters > 200_000) throw new TtsFailure('limit', this.usage)
    for (let offset = 0; offset < points.length; offset += 20_000) {
      this.send('continue-task', { input: { text: points.slice(offset, offset + 20_000).join('') } })
    }
    this.watchAudio()
  }

  /** Normally close input; future text is admitted by a fresh task. */
  finish(): void {
    if (this.phase !== 'running' || this.inputEnded) return
    this.inputEnded = true
    this.send('finish-task', { input: {} })
    this.watchAudio()
  }

  /** Stop dependent work without replaying input.
   * @param error - sanitized failure or caller cancellation.
   */
  fail(error: unknown): void {
    if (this.phase === 'failed' || this.phase === 'finished') return
    this.phase = 'failed'
    this.error = error
    this.frames.length = 0
    this.ready.reject(error instanceof Error ? error : new TtsFailure('protocol'))
    this.wake.resolve()
    this.socket.terminate()
  }

  /** @returns ordered frames; consumption releases pending audio and metadata memory. */
  async *[Symbol.asyncIterator](): AsyncIterator<TtsStreamEvent> {
    while (true) {
      if (this.phase === 'failed') throw this.error
      const item = this.frames.shift()
      if (item !== undefined) {
        this.queuedBytes -= item.bytes
        if (this.frames.length === 0) this.socket.resume()
        yield item.frame
        continue
      }
      if (this.phase === 'finished') return
      await this.wake.promise
      this.wake = Promise.withResolvers<void>()
    }
  }

  /** Release timers, producer waits and socket before settlement. */
  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.abort)
    this.lifetime.abort()
    clearTimeout(this.totalTimer)
    clearTimeout(this.audioTimer)
    this.socket.terminate()
    await this.released.promise
    this.frames.length = 0
  }
}
