/** Authenticated, cancellation-aware Client access to the speech capability. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import { SpeechFailure, speechFailureOf } from '@deepseek-ai/dsh-experimental-speech-to-text'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechPreparationOptions, SpeechProviderId, SpeechSelection, SpeechSelectionPatch, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { SpeechCatalog, TranscriptionRequest, SpeechStreamLimits, SpeechStreamCommand, SpeechStreamFrame } from './types.ts'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'

export type * from './types.ts'

async function receive<T>(pending: Promise<IteratorResult<T>>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = (): void => { cancelled.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([pending, cancelled.promise]) }
  finally { signal.removeEventListener('abort', abort) }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental speech Remote controller. */
    speechController: SpeechController
  }
}

/** Limits applied before decoding or calling a provider. */
export interface Config extends SpeechStreamLimits {
  /** Maximum decoded WAV bytes per request. */
  maxAudioBytes: number
  /** Maximum PCM recording duration in seconds. */
  maxDurationSeconds: number
}

/** Speech calls never activate or submit to an Agent. */
export default class SpeechController extends TypertRemoteService {
  static inject = ['speechToText', 'typert']
  static Config = z.object({
    maxAudioBytes: z.natural().min(46).default(4 * 1024 * 1024),
    maxDurationSeconds: z.number().min(1).default(120),
    maxFrameSamples: z.natural().min(128).max(1600).default(1600),
    maxPendingSamples: z.natural().min(1600).default(32000),
    consumerTimeoutMs: z.natural().min(1000).default(15_000),
    maxTranscriptBytes: z.natural().min(128).default(128 * 1024),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'speechController', { namespace: 'speech' })
  }

  /**
   * Read provider choices without preparing a recognizer.
   * @returns available providers, resolved default, and recording limits.
   */
  @Remote
  catalog(): SpeechCatalog {
    return { ...this.ctx.speechToText.snapshot(), ...this.config }
  }

  /**
   * Follow provider readiness independently of Session and preparation lifetimes.
   * @param signal - Client observation lifetime.
   * @returns initial and subsequent complete readiness snapshots.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<SpeechCatalog> {
    for await (const snapshot of this.ctx.speechToText.follow(signal)) yield { ...snapshot, ...this.config }
  }

  /**
   * Persist the user's recognition preferences.
   * @param patch - changed preference fields.
   * @returns after preferences are saved.
   */
  @Remote
  configure(patch: SpeechSelectionPatch): Promise<void> { return this.ctx.speechToText.configure(patch) }

  /**
   * Start or join one Host-owned preparation task.
   * @param providerId - selected recognizer.
   * @param options - task-local source selection validated by the provider.
   */
  @Remote
  prepare(providerId: SpeechProviderId, options?: SpeechPreparationOptions): void { this.ctx.speechToText.prepare(providerId, options) }

  /**
   * Explicitly cancel resource preparation.
   * @param providerId - selected recognizer.
   * @returns after the preparation task settles.
   */
  @Remote
  cancelPreparation(providerId: SpeechProviderId): Promise<void> { return this.ctx.speechToText.cancelPreparation(providerId) }

  /** Upload a single live recording without submitting or mutating a Session.
   * @param selection - pinned recognizer and language, independent from synthesis.
   * @param signal - native Remote cancellation; disconnect never reconnects or replays audio.
   * @returns PCM intake limits, live transcript and measured usage.
   */
  @Remote({ mode: 'stream' })
  async *stream(selection: SpeechSelection, signal: AbortSignal): RemoteStream<SpeechStreamFrame, SpeechStreamCommand> {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('Live recognition requires a Remote invocation')
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new SpeechFailure('timeout')) }, this.config.maxDurationSeconds * 1000 + this.config.consumerTimeoutMs)
    const combined = AbortSignal.any([signal, deadline.signal])
    let usage: import('@deepseek-ai/dsh-experimental-speech-to-text/types').SpeechUsage = { inputTokens: null, outputTokens: null, audioSeconds: null }
    try {
      const spec = this.ctx.speechToText.resolveStream(selection)
      const format = spec.provider.info.streaming
      if (format === undefined) throw new SpeechFailure('unconfigured')
      const sampleRate = format.sampleRate, limits = this.config
      if (limits.maxPendingSamples < limits.maxFrameSamples) throw new SpeechFailure('limit')
      const upstream = invocation.uplink<SpeechStreamCommand>()
      async function* audio(taskSignal: AbortSignal): AsyncIterable<Uint8Array> {
        let sequence = 0, samples = 0
        const sourceSignal = AbortSignal.any([combined, taskSignal]), iterator = upstream[Symbol.asyncIterator]()
        while (true) {
          const item = await receive(iterator.next(), sourceSignal)
          if (item.done) throw new SpeechFailure('protocol')
          const command = item.value
          if (command.kind === 'finish') {
            if (command.samples !== samples) throw new SpeechFailure('protocol')
            return
          }
          if (command.sequence !== sequence || command.startSample !== samples
            || command.audioBase64.length > Math.ceil(limits.maxFrameSamples * 2 / 3) * 4) throw new SpeechFailure('protocol')
          const bytes = Buffer.from(command.audioBase64, 'base64')
          if (bytes.toString('base64') !== command.audioBase64 || bytes.byteLength === 0 || bytes.byteLength % 2
            || bytes.byteLength > limits.maxFrameSamples * 2) throw new SpeechFailure('protocol')
          samples += bytes.byteLength / 2; sequence++
          if (samples > sampleRate * limits.maxDurationSeconds || samples * 2 > limits.maxAudioBytes) throw new SpeechFailure('limit')
          yield bytes
        }
      }
      yield { kind: 'ready', sampleRate, limits, maxDurationSeconds: limits.maxDurationSeconds }
      let textBytes = 0
      const sentences = new Map<number, number>()
      for await (const event of this.ctx.speechToText.stream(spec, audio, combined)) {
        if (event.kind === 'usage' || event.kind === 'done') usage = event.usage
        if (event.kind === 'sentence') {
          const bytes = Buffer.byteLength(event.text) + 64
          textBytes += bytes - (sentences.get(event.id) ?? 0); sentences.set(event.id, bytes)
          if (textBytes > limits.maxTranscriptBytes) throw new SpeechFailure('limit', usage)
        }
        yield event
      }
    } catch (error) {
      signal.throwIfAborted()
      const failure = speechFailureOf(error) ?? speechFailureOf(combined.reason)
      // Ordered business failure preserves validated partial text before the carrier closes.
      yield { kind: 'failed', reason: failure?.code ?? 'unknown', usage: {
        inputTokens: failure?.usage.inputTokens ?? usage.inputTokens,
        outputTokens: failure?.usage.outputTokens ?? usage.outputTokens,
        audioSeconds: failure?.usage.audioSeconds ?? usage.audioSeconds,
      } }
    } finally { clearTimeout(timer); deadline.abort() }
  }

  /**
   * Validate and transcribe one recording through the explicit provider selection.
   * @param request - canonical WAV encoded as base64, provider id and language hint.
   * @param signal - Client cancellation or Remote contribution disposal.
   * @returns final transcript without adding a Session event.
   */
  @Remote
  async transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<Transcript> {
    signal.throwIfAborted()
    const encoded = request.audioBase64
    if (encoded.length > Math.ceil(this.config.maxAudioBytes / 3) * 4) {
      throw new RemoteError('speech/invalid-audio', 'Audio is invalid or exceeds the configured byte limit', { reason: 'encoding-or-size' })
    }
    const audio = Buffer.from(encoded, 'base64')
    try {
      if (audio.toString('base64') !== encoded) throw new Error('Audio must use canonical base64 encoding')
      if (audio.length > this.config.maxAudioBytes) throw new Error('Audio exceeds the configured byte limit')
      validateWave(audio, this.config.maxDurationSeconds)
      const spec = this.ctx.speechToText.resolve({ audio,
        ...request.providerId === undefined ? {} : { providerId: request.providerId },
        ...request.language === undefined ? {} : { language: request.language },
      })
      return await this.ctx.speechToText.transcribe(spec, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = speechFailureOf(error)?.code ?? 'unknown'
      throw new RemoteError('speech/transcription-failed', 'Recognition failed; check voice settings and connection', { reason })
    }
  }
}
