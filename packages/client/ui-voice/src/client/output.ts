/** Client-only authorization and settlement for one explicitly enabled voice mode. */
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Ephemeral identity of one reply's audio queue. */
export type VoicePlaybackId = Branded<'VoicePlaybackId'>
/** Ephemeral permission to release exactly one pause reason. */
export type VoicePauseId = Branded<'VoicePauseId'>
/** Independent owners cannot release each other's pause. */
export type VoicePauseReason = 'user' | 'candidate'

/** Local audio observations; neither clock estimates nor receipts prove hearing. */
export interface VoicePlaybackState {
  readonly batchId: VoicePlaybackId | null
  readonly phase: 'idle' | 'synthesizing' | 'playing' | 'pausing' | 'paused' | 'resuming'
  readonly userPaused: boolean
  readonly candidatePaused: boolean
  readonly systemPaused: boolean
  readonly receivedSamples: number
  readonly playedSamples: number
  readonly position: { readonly samples: number; readonly basis: 'audio-context-clock' } | null
  readonly sampleRate: number
  readonly tasks: number
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null; readonly characters: number | null }
  readonly outcome: 'done' | 'stopped' | null
}

/** Playback tied to the current native submission and latest spoken step attempt. */
export interface VoicePlaybackObservation extends VoicePlaybackState {
  readonly requestId: VoiceRequestId
  readonly userSeq: number
  readonly step: number | null
  readonly attempt: number | null
}

/** A release permission is valid only for its original request and playback batch. */
export interface VoicePause {
  readonly id: VoicePauseId
  readonly batchId: VoicePlaybackId
  readonly reason: VoicePauseReason
  readonly requestId: VoiceRequestId
}

/** Identity minted by the native composer before prompt admission. */
export type VoiceRequestId = ReturnType<SessionFace['beginSubmission']>['requestId']

/** A logical reply settles only after text and confirmed tail playback settle. */
export interface VoiceReplyOutcome {
  readonly requestId: VoiceRequestId
  readonly outcome: 'pending' | 'done' | 'stopped' | 'failed' | 'retried'
}

/** Injected control plane; implementation classes remain inside their owner. */
export interface VoiceOutput {
  readonly mode: ObservableSnapshot<{ readonly session: SessionId | null; readonly enabled: boolean; readonly busy: boolean }>
  readonly replies: ObservableSnapshot<VoiceReplyOutcome | null>
  readonly playback: ObservableSnapshot<VoicePlaybackObservation | null>
  /** Join audio releases already requested by stop(); does not stop a later batch.
   * @returns after the captured releases have settled, with failures retained by the output owner.
   */
  settleStop(): Promise<void>
  /** Prepare audio from a user gesture; unrelated prompts remain unauthorized.
   * @param sessionId - foreground Session.
   * @returns after audio activation and view binding succeed.
   */
  arm(sessionId: SessionId): Promise<void>
  /** Authorize one upcoming native submission.
   * @param requestId - stable identity from beginSubmission.
   */
  authorize(requestId: VoiceRequestId): void
  /** Gate this reply, including audio that has not arrived yet.
   * @param requestId - currently admitted native submission.
   * @param reason - independent user or candidate owner.
   * @returns permission after graph suspension, or null if replaced or failed.
   */
  pause(requestId: VoiceRequestId, reason: VoicePauseReason): Promise<VoicePause | null>
  /** Release only the matching pause; system interruptions require a user gesture.
   * @param pause - permission from pause().
   * @returns whether the permission still belonged to the current reply.
   */
  resume(pause: VoicePause): Promise<boolean>
  /** Terminate a candidate's matching reply without cancelling text generation.
   * @param pause - permission from pause().
   * @returns whether the matching reply was stopped.
   */
  confirmStop(pause: VoicePause): boolean
  /** Revoke automatic speech without cancelling the text Agent. */
  stop(): void
}
