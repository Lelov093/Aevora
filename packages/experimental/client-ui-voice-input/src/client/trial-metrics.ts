/** Mode-owned observations for an explicitly requested local trial summary; no transcript or audio is retained. */
import type { VoicePlaybackObservation } from '@deepseek-ai/dsh-client-ui-voice/client'
import type { LiveRecognition } from './live-recognition.ts'

/** Sum of received values and a separate count of missing receipts; not a complete provider bill. */
export interface VoiceTrialCounter {
  observedSubtotal: number
  unknownReceipts: number
}
type SpeechCounters = Record<'inputTokens' | 'outputTokens' | 'audioSeconds', VoiceTrialCounter>
type PlaybackCounters = Record<'inputTokens' | 'outputTokens' | 'characters', VoiceTrialCounter>

/** Finalized local trial counters; unsuccessful intakes and partial receipts do not establish cloud failure or full cost. */
export interface VoiceTrialReport {
  readonly source: 'client-observations'
  readonly providerBillingTotal: null
  readonly attemptedUserAdmissions: number
  readonly attemptedSemanticRequests: number
  readonly asr: {
    readonly requestsAttempted: number
    readonly completed: number
    readonly failed: number
    readonly cancelled: number
    readonly notRequested: number
    readonly uploadedSamples: number
    readonly acceptedSamples: number
    readonly usage: SpeechCounters
  }
  readonly tts: {
    readonly batchesObserved: number
    readonly physicalTasksObserved: number
    readonly completedBatches: number
    readonly stoppedBatches: number
    readonly usage: PlaybackCounters
  }
  readonly pendingLocalIntakes: number
  readonly pendingPlaybackBatch: boolean
}

function counter(): VoiceTrialCounter { return { observedSubtotal: 0, unknownReceipts: 0 } }
function add(target: VoiceTrialCounter, value: number | null): void {
  if (value === null) target.unknownReceipts++
  else target.observedSubtotal += value
}

/** Bounded aggregate observations: completed intakes are released and only the latest playback batch is retained. */
export class VoiceTrialMetrics {
  private readonly pending = new Set<Pick<LiveRecognition, 'observation'>>()
  private readonly asr = { requestsAttempted: 0, completed: 0, failed: 0, cancelled: 0, notRequested: 0,
    uploadedSamples: 0, acceptedSamples: 0,
    usage: { inputTokens: counter(), outputTokens: counter(), audioSeconds: counter() } satisfies SpeechCounters }
  private readonly tts = { batchesObserved: 0, physicalTasksObserved: 0, completedBatches: 0, stoppedBatches: 0,
    usage: { inputTokens: counter(), outputTokens: counter(), characters: counter() } satisfies PlaybackCounters }
  private playback: VoicePlaybackObservation | undefined
  private submissions = 0
  private judgements = 0

  /** Observe one intake until its local completion or mode disposal.
   * @param recognition - mode-owned intake with no transcript in its observation.
   */
  trackRecognition(recognition: Pick<LiveRecognition, 'observation'>): void { this.pending.add(recognition) }

  /** Replace a live observation with its final local disposition, exactly once.
   * @param recognition - tracked intake; cancellation retains last reported partial usage.
   */
  settleRecognition(recognition: Pick<LiveRecognition, 'observation'>): void {
    if (!this.pending.delete(recognition)) return
    const value = recognition.observation
    if (!value.requested) { this.asr.notRequested++; return }
    this.asr.requestsAttempted++
    if (value.phase === 'done') this.asr.completed++
    else if (value.phase === 'failed') this.asr.failed++
    else this.asr.cancelled++
    this.asr.uploadedSamples += value.uploadedSamples; this.asr.acceptedSamples += value.acceptedSamples
    for (const key of ['inputTokens', 'outputTokens', 'audioSeconds'] as const) add(this.asr.usage[key], value.usage[key])
  }

  /** Retain each batch's latest native task count and aggregate receipt, without summing intermediate snapshots.
   * @param observation - playback owned by this mode's admitted reply.
   */
  observePlayback(observation: VoicePlaybackObservation): void {
    if (this.playback && this.playback.batchId !== observation.batchId) this.settlePlayback()
    this.playback = observation
  }

  private settlePlayback(): void {
    const value = this.playback
    if (!value) return
    this.tts.batchesObserved++; this.tts.physicalTasksObserved += value.tasks
    if (value.outcome === 'done') this.tts.completedBatches++
    if (value.outcome === 'stopped') this.tts.stoppedBatches++
    for (const key of ['inputTokens', 'outputTokens', 'characters'] as const) add(this.tts.usage[key], value.usage[key])
    this.playback = undefined
  }

  /** Count one attempted native user admission, independently of model execution steps. */
  submitted(): void { this.submissions++ }
  /** Count one attempted auxiliary request; Host Session records contain its authoritative outcome. */
  judged(): void { this.judgements++ }

  /** Settle remaining local observations after recognition and output cleanup have joined. */
  finish(): void {
    for (const recognition of this.pending) this.settleRecognition(recognition)
    this.settlePlayback()
  }

  /** Copy finalized counters; partial receipts and unobserved server work remain distinguishable from zero.
   * @returns local observations only, excluding transcripts, audio and credentials.
   */
  report(): VoiceTrialReport {
    return { source: 'client-observations' as const, providerBillingTotal: null,
      attemptedUserAdmissions: this.submissions, attemptedSemanticRequests: this.judgements,
      asr: structuredClone(this.asr), tts: structuredClone(this.tts),
      pendingLocalIntakes: this.pending.size, pendingPlaybackBatch: this.playback !== undefined }
  }
}
