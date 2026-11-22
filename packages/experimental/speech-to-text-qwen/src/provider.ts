/** Qwen streaming recognition with bounded queues and one socket per explicit task. */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { z } from 'zod'
import { SpeechFailure } from '@deepseek-ai/dsh-experimental-speech-to-text'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'
import type { SpeechProvider, SpeechProviderId, SpeechInput, Transcript, SpeechStreamEvent, SpeechUsage, SpeechAudioSource } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Connection settings captured before credential resolution. */
export interface QwenOptions {
  endpoint: string
  model: string
  key: string | undefined
  handshakeMs: number
  finishTimeoutMs: number
  taskTimeoutMs: number
  maxFrameBytes: number
  maxQueuedBytes: number
  maxAudioBytes: number
  maxTextBytes: number
}

const envelope = z.object({ header: z.object({ task_id: z.string(), event: z.enum(['task-started', 'result-generated', 'task-finished', 'task-failed']),
  error_code: z.string().optional() }), payload: z.object({ output: z.unknown().optional(), usage: z.unknown().optional() }) })
const counters = z.object({ input_tokens: z.number().nonnegative().nullable().optional(),
  output_tokens: z.number().nonnegative().nullable().optional(),
  duration: z.number().nonnegative().nullable().optional() }).nullable().optional()
const sentence = z.object({ sentence: z.object({ heartbeat: z.boolean().optional(), sentence_id: z.number().int().nonnegative(),
  text: z.string().default(''), sentence_end: z.boolean().optional(), begin_time: z.number().nonnegative().nullable().optional(),
  end_time: z.number().nonnegative().nullable().optional() }) })

/** Wait for owned work while honoring cancellation; the underlying promise remains observed.
 * @param pending - work owned and joined by the caller.
 * @param signal - operation lifetime.
 * @returns the result unless cancellation wins.
 */
export function wait<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason instanceof Error ? signal.reason : new DOMException('Recognition cancelled', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(pending).then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error instanceof Error ? error : new SpeechFailure('protocol')) })
    if (signal.aborted) abort()
  })
}

/** Per-task protocol, input and resource owner. */
class QwenRecognition {
  private readonly id = randomUUID()
  private readonly lifetime = new AbortController()
  private readonly signal: AbortSignal
  private readonly socket: WebSocket
  private readonly ready = Promise.withResolvers<void>()
  private readonly closed = Promise.withResolvers<void>()
  private wake = Promise.withResolvers<void>()
  private readonly frames: { event: SpeechStreamEvent; bytes: number }[] = []
  private readonly sentences = new Map<number, { text: string; final: boolean }>()
  private queuedBytes = 0
  private totalTextBytes = 0
  private sentBytes = 0
  private phase: 'starting' | 'running' | 'finishing' | 'finished' | 'failed' = 'starting'
  private failure: Error | undefined
  private usage: SpeechUsage = { inputTokens: null, outputTokens: null, audioSeconds: null }
  private readonly totalTimer: ReturnType<typeof setTimeout>
  private readonly startTimer: ReturnType<typeof setTimeout>
  private finishTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: QwenOptions, language: string, private readonly caller: AbortSignal) {
    this.signal = AbortSignal.any([caller, this.lifetime.signal])
    this.signal.throwIfAborted()
    this.socket = new WebSocket(options.endpoint, { headers: { Authorization: `Bearer ${options.key}` },
      handshakeTimeout: options.handshakeMs, maxPayload: options.maxFrameBytes, followRedirects: false })
    this.totalTimer = setTimeout(() => { this.fail(new SpeechFailure('timeout', this.usage)) }, options.taskTimeoutMs)
    this.startTimer = setTimeout(() => { this.fail(new SpeechFailure('timeout', this.usage)) }, options.handshakeMs)
    void this.ready.promise.catch((_failedAdmission: unknown) => { /* Iteration reports the same failure. */ })
    this.signal.addEventListener('abort', this.abort, { once: true })
    this.socket.on('error', () => { this.fail(new SpeechFailure('network', this.usage)) })
    this.socket.on('unexpected-response', (_request, response) => {
      response.resume()
      this.fail(new SpeechFailure(response.statusCode === 401 || response.statusCode === 403 ? 'authentication' : 'network', this.usage))
    })
    this.socket.on('close', () => {
      if (this.phase !== 'finished' && this.phase !== 'failed') this.fail(new SpeechFailure('network', this.usage))
      this.closed.resolve()
    })
    this.socket.on('open', () => {
      if (this.signal.aborted) return
      void this.send(JSON.stringify({ header: { action: 'run-task', task_id: this.id, streaming: 'duplex' },
        payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: options.model,
          parameters: { format: 'pcm', sample_rate: 16000, heartbeat: true,
            ...(language === 'auto' ? {} : { language_hints: [language] }) }, input: {} } }))
        .catch((error: unknown) => { this.fail(error) })
    })
    this.socket.on('message', (data, binary) => {
      if (this.phase === 'finished' || this.phase === 'failed') return
      try {
        if (binary) throw new SpeechFailure('protocol', this.usage)
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
        this.receive(JSON.parse(bytes.toString('utf8')))
      } catch (error) { this.fail(error instanceof SpeechFailure ? error : new SpeechFailure('protocol', this.usage)) }
    })
  }

  private readonly abort = (): void => {
    this.ready.reject(this.signal.reason); this.wake.resolve()
    this.socket.terminate()
  }

  private fail(error: unknown): void {
    if (this.signal.aborted || this.phase === 'finished' || this.phase === 'failed') return
    this.failure = error instanceof Error ? error : new SpeechFailure('protocol', this.usage)
    this.phase = 'failed'; this.lifetime.abort(this.failure)
  }

  private push(event: SpeechStreamEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (this.queuedBytes + bytes > this.options.maxQueuedBytes) throw new SpeechFailure('limit', this.usage)
    this.queuedBytes += bytes; this.frames.push({ event, bytes }); this.wake.resolve()
  }

  private receive(raw: unknown): void {
    const event = envelope.parse(raw)
    if (event.header.task_id !== this.id) throw new SpeechFailure('protocol', this.usage)
    const usage = counters.parse(event.payload.usage)
    if (usage != null) {
      this.usage = { inputTokens: usage.input_tokens ?? this.usage.inputTokens,
        outputTokens: usage.output_tokens ?? this.usage.outputTokens,
        audioSeconds: usage.duration ?? this.usage.audioSeconds }
      this.push({ kind: 'usage', usage: this.usage })
    }
    switch (event.header.event) {
      case 'task-started':
        if (this.phase !== 'starting') throw new SpeechFailure('protocol', this.usage)
        clearTimeout(this.startTimer); this.phase = 'running'; this.ready.resolve(); break
      case 'task-failed':
        throw new SpeechFailure(event.header.error_code === 'InvalidApiKey' || event.header.error_code === 'AuthenticationFailed'
          ? 'authentication' : 'provider', this.usage)
      case 'result-generated': {
        if (this.phase !== 'running' && this.phase !== 'finishing') throw new SpeechFailure('protocol', this.usage)
        const result = sentence.parse(event.payload.output).sentence
        if (result.heartbeat === true) return
        if (result.sentence_id < 1 || result.sentence_end === undefined) throw new SpeechFailure('protocol', this.usage)
        const previous = this.sentences.get(result.sentence_id)
        if (previous?.final) {
          if (previous.text !== result.text || !result.sentence_end) throw new SpeechFailure('protocol', this.usage)
          return
        }
        this.totalTextBytes += Buffer.byteLength(result.text) - Buffer.byteLength(previous?.text ?? '') + (previous ? 0 : 64)
        if (this.totalTextBytes > this.options.maxTextBytes) throw new SpeechFailure('limit', this.usage)
        this.sentences.set(result.sentence_id, { text: result.text, final: result.sentence_end })
        this.push({ kind: 'sentence', id: result.sentence_id, text: result.text, final: result.sentence_end,
          beginMs: result.begin_time ?? null, endMs: result.end_time ?? null }); break
      }
      case 'task-finished':
        if (this.phase !== 'finishing' || [...this.sentences.values()].some(value => !value.final)) throw new SpeechFailure('protocol', this.usage)
        this.push({ kind: 'done', usage: this.usage }); this.phase = 'finished'; this.wake.resolve(); break
    }
  }

  private async send(data: string | Uint8Array): Promise<void> {
    this.signal.throwIfAborted()
    if (this.socket.bufferedAmount + Buffer.byteLength(data) > this.options.maxQueuedBytes) throw new SpeechFailure('limit', this.usage)
    await wait(new Promise<void>((resolve, reject) => { this.socket.send(data, (error) => { if (error) reject(new SpeechFailure('network', this.usage)); else resolve() }) }), this.signal)
  }

  private async produce(input: AsyncIterable<Uint8Array>): Promise<void> {
    await wait(this.ready.promise, this.signal)
    const iterator = input[Symbol.asyncIterator]()
    try {
      while (true) {
        const item = await wait(iterator.next(), this.signal)
        if (item.done) break
        if (item.value.byteLength === 0 || item.value.byteLength % 2 !== 0 || item.value.byteLength > this.options.maxFrameBytes) throw new SpeechFailure('protocol', this.usage)
        this.sentBytes += item.value.byteLength
        if (this.sentBytes > this.options.maxAudioBytes) throw new SpeechFailure('limit', this.usage)
        await this.send(item.value)
        this.push({ kind: 'accepted', bytes: this.sentBytes })
      }
      this.phase = 'finishing'
      this.finishTimer = setTimeout(() => { this.fail(new SpeechFailure('timeout', this.usage)) }, this.options.finishTimeoutMs)
      await this.send(JSON.stringify({ header: { action: 'finish-task', task_id: this.id, streaming: 'duplex' }, payload: { input: {} } }))
    } finally { await iterator.return?.() }
  }

  /** Run one bounded duplex task and join socket closure and producer teardown.
   * @param input - ordered PCM16 mono chunks.
   * @returns incremental observations without reconnect or replay.
   */
  async *run(input: SpeechAudioSource): AsyncIterable<SpeechStreamEvent> {
    const producer = this.produce(input(this.signal)).catch((error: unknown) => { this.fail(error) })
    try {
      while (true) {
        this.caller.throwIfAborted()
        if (this.failure === undefined) this.signal.throwIfAborted()
        const frame = this.frames.shift()
        if (frame) { this.queuedBytes -= frame.bytes; yield frame.event; continue }
        if (this.failure !== undefined) throw this.failure
        if (this.phase === 'finished') return
        try { await wait(this.wake.promise, this.signal) }
        catch (error) { this.caller.throwIfAborted(); if (!this.lifetime.signal.aborted) throw error }
        this.wake = Promise.withResolvers<void>()
      }
    } finally {
      clearTimeout(this.totalTimer); clearTimeout(this.startTimer); clearTimeout(this.finishTimer)
      this.lifetime.abort(); this.signal.removeEventListener('abort', this.abort)
      this.socket.terminate(); await producer; await this.closed.promise
      this.frames.length = 0; this.sentences.clear()
    }
  }
}

/** One independently configured online recognizer; no socket opens during registration or settings. */
export class QwenSpeechProvider implements SpeechProvider {
  readonly info
  constructor(id: SpeechProviderId, name: string, private readonly options: () => Promise<QwenOptions>) {
    this.info = { id, name, location: 'cloud' as const, languages: ['auto', 'zh', 'en', 'ja', 'ko'], streaming: { sampleRate: 16000 } }
  }

  /** @param input - ordered audio source. @param language - selected hint. @param signal - task lifetime. @returns live events. */
  async *stream(input: SpeechAudioSource, language: string, signal: AbortSignal): AsyncIterable<SpeechStreamEvent> {
    const options = await this.options()
    yield* this.recognize(options, input, language, signal)
  }

  private async *recognize(options: QwenOptions, input: SpeechAudioSource,
    language: string, signal: AbortSignal): AsyncIterable<SpeechStreamEvent> {
    signal.throwIfAborted()
    if (!options.key || !options.endpoint) throw new SpeechFailure('unconfigured')
    yield* new QwenRecognition(options, language, signal).run(input)
  }

  /** Recognize complete native WAV using the same protocol engine.
   * @param input - canonical 16 kHz WAV.
   * @param signal - request lifetime.
   * @returns final text with unknown server compute time.
   */
  async transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
    const audioSeconds = validateWave(input.audio, Number.MAX_SAFE_INTEGER)
    const options = await this.options()
    signal.throwIfAborted()
    if (input.audio.byteLength - 44 > options.maxAudioBytes) throw new SpeechFailure('limit')
    const sentences = new Map<number, string>()
    const chunkBytes = Math.min(3200, options.maxFrameBytes - options.maxFrameBytes % 2)
    if (chunkBytes < 2) throw new SpeechFailure('limit')
    // oxlint-disable-next-line typescript/require-await -- WAV slices satisfy the async source API without another recording buffer.
    async function* audio(): AsyncIterable<Uint8Array> {
      for (let offset = 44; offset < input.audio.byteLength; offset += chunkBytes) yield input.audio.subarray(offset, offset + chunkBytes)
    }
    for await (const event of this.recognize(options, audio, input.language, signal)) if (event.kind === 'sentence' && event.final) sentences.set(event.id, event.text)
    return { text: [...sentences].sort(([a], [b]) => a - b).map(([, text]) => text).join(''), audioSeconds, inferenceSeconds: null }
  }
}
