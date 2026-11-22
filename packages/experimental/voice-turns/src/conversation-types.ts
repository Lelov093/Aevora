/** Durable, JSON-safe observations for optional parallel voice; no raw recording is retained. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** One semantic judgement, never reused for a revised transcript. */
export type VoiceEvaluationId = Branded<'VoiceEvaluationId'>
/** One captured utterance or overlap. */
export type VoiceCandidateId = Branded<'VoiceCandidateId'>
/** Audio queue identity shared with the Client output service. */
export type VoicePlaybackId = Branded<'VoicePlaybackId'>
/** Native identified user submission. */
export type VoiceRequestId = Branded<'session-request-id'>

/** Client observations distinguish confirmed buffer completion from a clock estimate. */
export interface PlaybackObservation {
  readonly requestId: VoiceRequestId
  readonly batchId: VoicePlaybackId
  readonly sequence: number
  readonly phase: 'idle' | 'synthesizing' | 'playing' | 'pausing' | 'paused' | 'resuming'
  readonly outcome: 'done' | 'stopped' | null
  readonly step: number | null
  readonly attempt: number | null
  readonly receivedSamples: number
  readonly playedSamples: number
  readonly sampleRate: number
  readonly position: { readonly samples: number; readonly basis: 'audio-context-clock' } | null
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null; readonly characters: number | null }
}

/** Snapshot requested for one bounded hypothesis; auxiliary text is explicitly logged. */
export interface InterruptionRequest {
  readonly evaluationId: VoiceEvaluationId
  readonly candidateId: VoiceCandidateId
  readonly requestId: VoiceRequestId
  readonly batchId: VoicePlaybackId
  readonly revision: number
  readonly startSample: number
  readonly endSample: number
  readonly text: string
}

/** Null counters are unknown; a model label is not an authorized Session prompt. */
export interface InterruptionResult {
  readonly evaluationId: VoiceEvaluationId
  readonly verdict: 'interrupt' | 'backchannel' | 'uncertain'
  readonly usage: {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly totalTokens?: number | undefined
    readonly cacheReadTokens?: number | undefined
    readonly cacheWriteTokens?: number | undefined
    readonly reasoningTokens?: number | undefined
  }
}

/** Restorable bounded voice facts, excluding microphones, promises and pause permissions. */
export interface VoiceConversationState {
  readonly userSeq: SessionSeq | null
  readonly requestId: VoiceRequestId | null
  readonly userText: string
  readonly assistantText: string
  readonly playback: PlaybackObservation | null
  readonly reporter: string | null
  readonly evaluation: { readonly input: InterruptionRequest; readonly result: InterruptionResult | null } | null
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Client-reported playback; never proves which words a person heard. */
    'voice/playback-observation': { readonly observation: PlaybackObservation; readonly reporter: string }
    /** Exact auxiliary request text and model route, committed before dispatch. */
    'voice/interruption-request': {
      readonly input: InterruptionRequest
      readonly provider: string
      readonly model: string
      readonly system: string
      readonly context: string
      readonly reporter: string
    }
    /** A settled judgement or contained failure; missing results stay unknown on replay. */
    'voice/interruption-result': {
      readonly result: InterruptionResult
      readonly response: string
      readonly elapsedMs: number
      readonly failure: 'cancelled' | 'model' | 'protocol' | 'limit' | null
    }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'voice-turns/conversation-unavailable': { readonly reason: 'disabled' | 'changed' | 'busy' | 'limit' | 'failed' }
  }
}
