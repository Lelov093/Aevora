/** JSON-safe inputs and results of the experimental speech Remote namespace. */
import type { SpeechProviderId, SpeechSnapshot, SpeechStreamEvent, SpeechUsage } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Audio encoding or intake limits prevented transcription. */
    'speech/invalid-audio': { readonly reason: string }
    /** The selected provider rejected transcription. */
    'speech/transcription-failed': { readonly reason: string }
  }
}

/** Complete recording submitted for transcription, separate from Session admission. */
export interface TranscriptionRequest {
  readonly audioBase64: string
  readonly providerId?: SpeechProviderId
  readonly language?: string
}

/** Current provider choices and audio intake limits. */
export interface SpeechCatalog extends SpeechSnapshot {
  readonly maxAudioBytes: number
  readonly maxDurationSeconds: number
}

/** Explicit bounds spanning capture, Remote and provider intake. */
export interface SpeechStreamLimits {
  /** Maximum PCM samples in a single uplink command. */
  readonly maxFrameSamples: number
  /** Maximum unconsumed PCM samples retained by the Remote. */
  readonly maxPendingSamples: number
  /** Maximum wait for the consumer to accept queued audio. */
  readonly consumerTimeoutMs: number
  /** Maximum UTF-8 bytes retained across transcript sentences. */
  readonly maxTranscriptBytes: number
}

/** PCM frames are sequential and contiguous; finish follows the final sample exactly once. */
export type SpeechStreamCommand =
  | { readonly kind: 'audio'; readonly sequence: number; readonly startSample: number; readonly audioBase64: string }
  | { readonly kind: 'finish'; readonly samples: number }

/** Initial intake permission, followed by provider events. Readiness never implies recognition completion. */
export type SpeechStreamFrame = SpeechStreamEvent
  | { readonly kind: 'ready'; readonly sampleRate: number; readonly maxDurationSeconds: number; readonly limits: SpeechStreamLimits }
  | { readonly kind: 'failed'; readonly reason: string; readonly usage: SpeechUsage }
