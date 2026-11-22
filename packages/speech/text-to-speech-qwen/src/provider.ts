/** Official incremental Qwen protocol shared by complete and streaming synthesis. */
import type { TtsAudio, TtsInput, TtsProvider, TtsProviderId, TtsStreamEvent, TtsTaskId, TtsUsage, TtsTextPiece } from '@deepseek-ai/dsh-text-to-speech/types'
import { TtsFailure } from '@deepseek-ai/dsh-text-to-speech'
import { QwenTask, waitForInput } from './task.ts'

/** Resolved settings pinned for one operation, including normal task rotation. */
export interface QwenOptions {
  endpoint: string
  model: string
  voice: string
  sampleRate: number
  rate: number
  timeoutMs: number
  handshakeMs: number
  textIdleMs: number
  audioIdleMs: number
  maxBufferedAudioBytes: number
  maxAudioBytes: number
  maxFrameBytes: number
  key: string | undefined
}

/** Synthesizes through bounded tasks without retrying failed or cancelled work. */
export class QwenTtsProvider implements TtsProvider {
  constructor(private readonly options: () => Promise<QwenOptions>, readonly id = 'qwen-online' as TtsProviderId) {}

  /**
   * Aggregate the same incremental protocol for complete-output callers.
   * @param input - complete visible prose.
   * @param signal - caller lifetime.
   * @returns complete PCM after socket cleanup, retaining unknown usage.
   */
  async synthesize(input: TtsInput, signal: AbortSignal): Promise<TtsAudio> {
    const options = await this.resolve(signal)
    const characters = Array.from(input.text).length
    if (characters === 0 || characters > 200_000) throw new TtsFailure('limit')
    const chunks: Uint8Array[] = []
    const tasks = new Map<TtsTaskId, TtsUsage>()
    let bytes = 0
    const text: AsyncIterable<TtsTextPiece> = {
      [Symbol.asyncIterator]: () => {
        let done = false
        return { next: () => {
          if (done) return Promise.resolve({ done: true, value: undefined })
          done = true
          return Promise.resolve({ done: false, value: { kind: 'text', text: input.text } })
        } }
      },
    }
    for await (const frame of this.run(text, signal, options)) {
      if (frame.kind === 'audio') {
        bytes += frame.pcm.byteLength
        if (bytes > options.maxAudioBytes) throw new TtsFailure('limit', aggregateUsage(tasks))
        chunks.push(frame.pcm)
      }
      if (frame.kind === 'usage' || frame.kind === 'task-finished') tasks.set(frame.taskId, frame.usage)
    }
    return { pcm: Buffer.concat(chunks), sampleRate: options.sampleRate, usage: aggregateUsage(tasks) }
  }

  /**
   * Yield audio while text arrives. Idle rotation is normal completion, never retry.
   * @param input - caller-owned text iterator, cancelled through the same signal.
   * @param signal - complete operation lifetime.
   * @returns task, audio, alignment and usage frames.
   */
  async *stream(input: AsyncIterable<TtsTextPiece>, signal: AbortSignal): AsyncIterable<TtsStreamEvent> {
    yield* this.run(input, signal, await this.resolve(signal))
  }

  private async resolve(signal: AbortSignal): Promise<QwenOptions> {
    signal.throwIfAborted()
    const options = await this.options()
    signal.throwIfAborted()
    if (!options.key || !options.endpoint || !options.voice) throw new TtsFailure('unconfigured', undefined, 'configuration')
    return options
  }

  private async *run(input: AsyncIterable<TtsTextPiece>, signal: AbortSignal, options: QwenOptions): AsyncIterable<TtsStreamEvent> {
    const iterator = input[Symbol.asyncIterator]()
    let next = iterator.next()
    while (true) {
      const first = await waitForInput(next, signal)
      if (first === undefined || first.done) return
      if (first.value.kind === 'boundary') { next = iterator.next(); continue }
      const firstText = first.value.text
      const task = new QwenTask(options, signal)
      const feeding = (async () => {
        await task.ready.promise
        task.append(firstText)
        next = iterator.next()
        while (true) {
          const item = await waitForInput(next, task.signal, options.textIdleMs)
          if (item === undefined || item.done) { task.finish(); return }
          if (item.value.kind === 'boundary') { next = iterator.next(); task.finish(); return }
          task.append(item.value.text)
          next = iterator.next()
        }
      })().catch((error: unknown) => { task.fail(error) })
      try { yield* task }
      finally { await task.close(); await feeding }
      signal.throwIfAborted()
    }
  }
}

/** Sum each task once, retaining unknown fields.
 * @param tasks - latest reported snapshot per task.
 * @returns operation usage, without inventing zero billing.
 */
function aggregateUsage(tasks: ReadonlyMap<TtsTaskId, TtsUsage>): TtsUsage {
  const sum = (key: keyof TtsUsage): number | null => {
    if (tasks.size === 0) return null
    let total = 0
    for (const usage of tasks.values()) { if (usage[key] === null) return null; total += usage[key] }
    return total
  }
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), characters: sum('characters') }
}
