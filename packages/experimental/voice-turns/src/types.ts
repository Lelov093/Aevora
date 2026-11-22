/** Ordered task-local audio and local endpoint observations; no transcript is sent here. */
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Ephemeral identity for one reversible automatic end review. */
export type TurnReviewId = Branded<'TurnReviewId'>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'voice-turns/unavailable': { readonly reason: 'unprepared' | 'busy' | 'runtime'; readonly phase: 'preparation' | 'startup' | 'inference' }
  }
}
/** Ordered input for one listening task and its explicit cutoff. */
export type TurnCommand =
  | { readonly kind: 'audio'; readonly startSample: number; readonly audioBase64: string }
  | { readonly kind: 'review'; readonly reviewId: TurnReviewId; readonly samples: number }
  | { readonly kind: 'seal'; readonly reviewId?: TurnReviewId; readonly samples: number; readonly explicit: boolean }
  | { readonly kind: 'commit'; readonly reviewId: TurnReviewId; readonly samples: number; readonly coveredSamples: number }
  | { readonly kind: 'reset' }

/** Sample positions are mono PCM16 at the protocol's fixed 16 kHz. */
export type TurnFrame =
  | { readonly kind: 'ready'; readonly parallel: boolean; readonly maxFrameSamples: number; readonly maxPendingSamples: number }
  | { readonly kind: 'accepted'; readonly samples: number; readonly speaking: boolean }
  | { readonly kind: 'candidate'; readonly samples: number }
  | { readonly kind: 'complete'; readonly samples: number; readonly probability: number }
  | { readonly kind: 'reviewed'; readonly reviewId: TurnReviewId; readonly samples: number; readonly ready: boolean }
  | { readonly kind: 'sealed'; readonly reviewId?: TurnReviewId; readonly samples: number; readonly valid: boolean }
  | { readonly kind: 'committed'; readonly reviewId: TurnReviewId; readonly samples: number; readonly coveredSamples: number; readonly valid: boolean }
  | { readonly kind: 'reset' }

/** File presence is configuration evidence, not a successful model load. */
export interface TurnReadiness {
  readonly configured: boolean
  readonly filesPresent: boolean
  readonly model: 'smart-turn-v3.1-reference'
  /** Effective preference for the next voice mode. */
  readonly parallel: boolean
  readonly maxRecognitionTasks: number
}

export type { PlaybackObservation, InterruptionRequest, InterruptionResult, VoiceEvaluationId, VoiceCandidateId } from './conversation-types.ts'
