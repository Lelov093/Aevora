/** Provider-neutral synthesis inputs and mono PCM output. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Registered synthesis provider identity. */
export type TtsProviderId = Branded<'TtsProviderId'>

/** One provider-side synthesis task; a stream may finish several normal tasks. */
export type TtsTaskId = Branded<'TtsTaskId'>

/** Sanitized provider failure location, without endpoint, prose or credentials. */
export type TtsFailureStage = 'configuration' | 'connection' | 'event' | 'audio' | 'task'

/** Observed billing fields; absent measurements remain unknown. */
export interface TtsUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly characters: number | null
}

/** Complete visible prose explicitly selected for speech. */
export interface TtsInput { readonly text: string }

/** Complete signed 16-bit little-endian mono PCM and measured billing. */
export interface TtsAudio {
  readonly pcm: Uint8Array
  readonly sampleRate: number
  readonly usage: TtsUsage
}

/** Provider-reported alignment; absent timing must not be inferred from byte ratios. */
export interface TtsWord {
  readonly text: string
  readonly beginIndex: number
  readonly endIndex: number
  readonly beginTimeMs: number
  readonly endTimeMs: number
}

/** Incremental output. Usage snapshots replace the same task's earlier snapshot. */
export type TtsStreamEvent =
  | { readonly kind: 'task-started'; readonly taskId: TtsTaskId; readonly sampleRate: number }
  | { readonly kind: 'audio'; readonly taskId: TtsTaskId; readonly pcm: Uint8Array }
  | { readonly kind: 'sentence'; readonly taskId: TtsTaskId; readonly index: number; readonly text: string; readonly words: readonly TtsWord[] }
  | { readonly kind: 'usage'; readonly taskId: TtsTaskId; readonly usage: TtsUsage }
  | { readonly kind: 'task-finished'; readonly taskId: TtsTaskId; readonly usage: TtsUsage }

/** Prose or a normal boundary before tool waiting; a boundary never retries a failed task. */
export type TtsTextPiece = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'boundary' }

/** One registered synthesis implementation. */
export interface TtsProvider {
  readonly id: TtsProviderId
  /**
   * Check local configuration without a network request; omitted means available.
   * @returns whether the route can accept a synthesis request.
   */
  available?(): boolean
  /**
   * Synthesize while honoring cancellation and owned-resource cleanup.
   * @param input - complete prose.
   * @param signal - cancellation lifetime.
   * @returns audio after provider cleanup.
   */
  synthesize(input: TtsInput, signal: AbortSignal): Promise<TtsAudio>
  /**
   * Consume incremental plain text and yield audio before the input ends. No implicit retry.
   * @param input - caller-owned text source; its owner releases it on cancellation.
   * @param signal - complete operation lifetime.
   * @returns ordered audio, task receipts and optional alignment.
   */
  stream?(input: AsyncIterable<TtsTextPiece>, signal: AbortSignal): AsyncIterable<TtsStreamEvent>
}

/** Resolved provider selection for one operation. */
export interface TtsSpec extends TtsInput { readonly provider: TtsProvider }

/** Provider pinned before admitting incremental text. */
export interface TtsStreamSpec {
  readonly provider: TtsProvider
  readonly stream: NonNullable<TtsProvider['stream']>
  /** Provider and service lifetime, also honored outside iterator reads. */
  readonly signal: AbortSignal
}
