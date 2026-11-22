/** JSON-safe synthesis results and sanitized Remote failures. */
import type { TtsUsage, TtsTaskId, TtsStreamEvent, TtsFailureStage } from '@deepseek-ai/dsh-text-to-speech/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Complete mono PCM16-LE output; missing billing fields remain null. */
export interface TtsResult {
  readonly audioBase64: string
  readonly sampleRate: number
  readonly usage: TtsUsage
}

/** Host-owned resource limits also used by the Client before it queues text or audio. */
export interface TtsStreamLimits {
  /** Maximum UTF-8 bytes awaiting provider consumption. */
  readonly maxPendingTextBytes: number
  /** Maximum cumulative UTF-8 text bytes in one logical speech operation. */
  readonly maxTextBytes: number
  /** Maximum audio duration sent ahead of contiguous playback receipts. */
  readonly maxQueuedAudioMs: number
  /** Maximum duration represented by one PCM audio frame. */
  readonly maxAudioChunkMs: number
  /** Maximum wait for playback credit, in milliseconds. */
  readonly consumerTimeoutMs: number
  /** Maximum queued control, metadata or text frames per operation queue. */
  readonly maxBufferedFrames: number
}

/** Local capability read; it neither resolves a credential nor starts synthesis. */
export interface TtsCapabilities { readonly streaming: boolean; readonly limits: TtsStreamLimits }

/** Ordered prose and playback acknowledgements on one native Remote stream. */
export type TtsStreamCommand =
  | { readonly kind: 'text'; readonly sequence: number; readonly offset: number; readonly text: string }
  | { readonly kind: 'finish' }
  | { readonly kind: 'boundary' }
  | { readonly kind: 'played'; readonly samples: number }

/** JSON stream frames; only the bounded audio payload is base64 encoded. */
export type TtsStreamFrame =
  | { readonly kind: 'ready'; readonly limits: TtsStreamLimits }
  | { readonly kind: 'text-accepted'; readonly sequence: number }
  | {
    readonly kind: 'audio'
    readonly taskId: TtsTaskId
    readonly sequence: number
    readonly startSample: number
    readonly sampleRate: number
    readonly audioBase64: string
  }
  | Exclude<TtsStreamEvent, { readonly kind: 'audio' }>
  | { readonly kind: 'done'; readonly samples: number }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Empty prose or configured input resource limit. */
    'tts/invalid-text': { readonly reason: string }
    /** Provider failure; no automatic retry and no fabricated zero usage. */
    'tts/synthesis-failed': { readonly reason: string; readonly stage: TtsFailureStage; readonly usage: TtsUsage }
  }
}
