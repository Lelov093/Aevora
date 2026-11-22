/** Authenticated, explicit synthesis requests; no Session or Agent mutations. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import { ttsFailureOf } from '@deepseek-ai/dsh-text-to-speech'
import type { TtsResult, TtsStreamLimits, TtsCapabilities, TtsStreamFrame, TtsStreamCommand } from './types.ts'
import { TtsStreamOperation } from './stream.ts'
export type * from './types.ts'

/** Resource bounds before invoking synthesis. */
export interface Config extends TtsStreamLimits {
  /** Maximum UTF-8 prose bytes accepted before invoking a provider. */
  maxTextBytes: number
}

declare module '@deepseek-ai/cordis' { interface Context { ttsController: TtsController } }

/** Owns browser synthesis admission and sanitized failure reports. */
export default class TtsController extends TypertRemoteService {
  static inject = ['textToSpeech', 'typert']
  static Config = z.object({
    maxTextBytes: z.natural().min(1).default(1024 * 1024),
    maxPendingTextBytes: z.natural().min(1024).default(64 * 1024),
    maxQueuedAudioMs: z.natural().min(100).default(2000),
    maxAudioChunkMs: z.natural().min(1).max(100).default(100),
    consumerTimeoutMs: z.natural().min(1000).default(30_000),
    maxBufferedFrames: z.natural().min(8).default(256),
  })
  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'ttsController', { namespace: 'tts' }) }

  /** Read local streaming support and resource limits without a synthesis request.
   * @returns selected provider support and Host-owned queue budgets.
   */
  @Remote
  capabilities(): TtsCapabilities {
    let streaming = false
    try { this.ctx.textToSpeech.resolveStreaming(); streaming = true }
    catch (_unavailableProvider) { /* A user can configure or select a provider before enabling speech. */ }
    return { streaming, limits: { ...this.config } }
  }

  /** Stream incremental prose and consume playback receipts through the authenticated native carrier.
   * @param signal - one physical Remote operation; carrier loss cancels it without replay.
   * @returns PCM chunks, alignment, usage and accepted-text acknowledgements.
   */
  @Remote({ mode: 'stream' })
  async *stream(signal: AbortSignal): RemoteStream<TtsStreamFrame, TtsStreamCommand> {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('Speech streaming requires a Remote invocation')
    try {
      const spec = this.ctx.textToSpeech.resolveStreaming()
      yield* new TtsStreamOperation(this.ctx, spec, this.config, signal).run(invocation.uplink<TtsStreamCommand>())
    } catch (error) {
      signal.throwIfAborted()
      const failure = ttsFailureOf(error)
      throw new RemoteError('tts/synthesis-failed', 'Speech stopped; check voice settings before starting another read', {
        reason: failure?.code ?? 'unknown',
        stage: failure?.stage ?? 'task',
        usage: failure?.usage ?? { inputTokens: null, outputTokens: null, characters: null },
      })
    }
  }

  /**
   * Synthesize selected prose without modifying conversation state.
   * @param text - complete visible prose selected by the user.
   * @param signal - request lifetime.
   * @returns mono PCM16 audio and measured usage.
   */
  @Remote
  async synthesize(text: string, signal: AbortSignal): Promise<TtsResult> {
    signal.throwIfAborted()
    if (!text.trim() || Buffer.byteLength(text) > this.config.maxTextBytes) {
      throw new RemoteError('tts/invalid-text', 'Select non-empty text within the configured resource limit', { reason: 'invalid-text' })
    }
    try {
      const result = await this.ctx.textToSpeech.synthesize(this.ctx.textToSpeech.resolve({ text }), signal)
      signal.throwIfAborted()
      return { audioBase64: Buffer.from(result.pcm).toString('base64'), sampleRate: result.sampleRate, usage: result.usage }
    } catch (error) {
      signal.throwIfAborted()
      const failure = ttsFailureOf(error)
      // Provider messages can contain endpoints, request text, or credentials.
      throw new RemoteError('tts/synthesis-failed', 'Speech synthesis failed; check voice settings before trying again', {
        reason: failure?.code ?? 'unknown',
        stage: failure?.stage ?? 'task',
        usage: failure?.usage ?? { inputTokens: null, outputTokens: null, characters: null },
      })
    }
  }
}
