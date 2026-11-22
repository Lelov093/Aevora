/** Replaceable synthesis providers with cancellation and awaited withdrawal. */
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { TtsAudio, TtsInput, TtsProvider, TtsProviderId, TtsSpec, TtsUsage, TtsStreamSpec, TtsStreamEvent, TtsTextPiece, TtsFailureStage } from './types.ts'
export type * from './types.ts'

/** Sanitized provider failure with observed usage; null fields mean unknown. */
export class TtsFailure extends Error {
  /** Stable identity across separately loaded provider and consumer modules. */
  readonly isDSHTtsFailure: true = true
  constructor(readonly code: 'unconfigured' | 'authentication' | 'network' | 'protocol' | 'provider' | 'limit' | 'timeout',
    readonly usage: TtsUsage = { inputTokens: null, outputTokens: null, characters: null },
    readonly stage: TtsFailureStage = 'task') {
    super(`Speech synthesis failed: ${code}`)
  }
}

/** Recognize a provider failure across module copies without reading its message.
 * @param value - failure thrown by a registered provider.
 * @returns marked typed failure, or undefined for an unrelated exception.
 */
export function ttsFailureOf(value: unknown): TtsFailure | undefined {
  if (typeof value === 'object' && value !== null
    && 'isDSHTtsFailure' in value && value.isDSHTtsFailure === true) return value as TtsFailure
  return undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context { textToSpeech: TextToSpeech }
}

/** Deployment selection resolved for each explicit read-aloud request. */
export interface Config {
  /** Exact provider id; empty selects only when one locally configured route exists. */
  defaultProvider: Volatile<string>
}

interface Registration {
  provider: TtsProvider
  lifetime: AbortController
  pending: Set<Promise<void>>
}

/** Owns synthesis admission and provider lifetime, without changing Agent state. */
export default class TextToSpeech extends Service {
  static Config = z.object({ defaultProvider: z.string().default('').volatile() })
  private readonly providers = new Map<TtsProviderId, Registration>()
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'textToSpeech')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.all([...this.providers.values()].map(item => this.remove(item)))
    }, 'text-to-speech: providers')
  }

  /**
   * Admit requests until the returned withdrawal cancels and joins them.
   * @param provider - implementation owned by the registering plugin.
   * @returns awaited withdrawal.
   */
  register(provider: TtsProvider): () => Promise<void> {
    if (this.lifetime.signal.aborted) throw new Error('Speech synthesis service is disposed')
    if (this.providers.has(provider.id)) throw new Error(`Duplicate speech synthesis provider: ${provider.id}`)
    const item: Registration = { provider, lifetime: new AbortController(), pending: new Set() }
    this.providers.set(provider.id, item)
    return () => this.remove(item)
  }

  private async remove(item: Registration): Promise<void> {
    if (this.providers.get(item.provider.id) !== item) return
    this.providers.delete(item.provider.id)
    item.lifetime.abort()
    await Promise.allSettled(item.pending)
  }

  /**
   * Pin the selected provider for one explicit request.
   * @param input - explicit prose.
   * @returns pinned provider and text.
   */
  resolve(input: TtsInput): TtsSpec {
    return { provider: this.selected(), text: input.text }
  }

  private selected(): TtsProvider {
    this.lifetime.signal.throwIfAborted()
    const selected = this.config.defaultProvider.get()
    const usable = [...this.providers.values()].map(item => item.provider).filter(provider => provider.available?.() !== false)
    const provider = selected ? this.providers.get(selected as TtsProviderId)?.provider : usable.length === 1 ? usable[0] : undefined
    if (provider === undefined || provider.available?.() === false) throw new Error('Speech synthesis provider is unavailable')
    return provider
  }

  /** Pin a locally available streaming provider without contacting it.
   * @returns provider with incremental synthesis support.
   */
  resolveStreaming(): TtsStreamSpec {
    const provider = this.selected()
    if (provider.stream === undefined) throw new TtsFailure('unconfigured')
    const item = this.providers.get(provider.id)
    if (item === undefined) throw new TtsFailure('unconfigured')
    return { provider, stream: provider.stream.bind(provider), signal: AbortSignal.any([this.lifetime.signal, item.lifetime.signal]) }
  }

  /**
   * Run synthesis while the caller, provider and service remain active.
   * @param spec - resolved operation.
   * @param caller - caller lifetime.
   * @returns complete audio after cleanup.
   */
  async synthesize(spec: TtsSpec, caller: AbortSignal): Promise<TtsAudio> {
    const item = this.providers.get(spec.provider.id)
    if (item?.provider !== spec.provider) throw new Error('Speech synthesis provider was withdrawn')
    const signal = AbortSignal.any([caller, item.lifetime.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const settlement = Promise.withResolvers<void>()
    item.pending.add(settlement.promise)
    try { return await spec.provider.synthesize({ text: spec.text }, signal) }
    finally { settlement.resolve(); item.pending.delete(settlement.promise) }
  }

  /** Consume a pinned provider until completion, cancellation or iterator release.
   * @param spec - explicitly resolved stream provider.
   * @param input - caller-owned incremental prose.
   * @param caller - consumer lifetime.
   * @returns ordered provider frames; withdrawal waits for cleanup.
   */
  async *stream(spec: TtsStreamSpec, input: AsyncIterable<TtsTextPiece>, caller: AbortSignal): AsyncIterable<TtsStreamEvent> {
    const item = this.providers.get(spec.provider.id)
    if (item?.provider !== spec.provider) throw new TtsFailure('unconfigured')
    const operation = new AbortController()
    const signal = AbortSignal.any([caller, item.lifetime.signal, this.lifetime.signal, operation.signal])
    signal.throwIfAborted()
    const settlement = Promise.withResolvers<void>()
    item.pending.add(settlement.promise)
    try { yield* spec.stream(input, signal) }
    finally { operation.abort(); settlement.resolve(); item.pending.delete(settlement.promise) }
  }
}
