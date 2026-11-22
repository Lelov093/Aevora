/** Sample-watermarked endpoint decisions; asynchronous predictions never outrun newer speech. */
import type { Config } from './config.ts'
import type { TurnFrame, TurnReviewId } from './types.ts'

/** Small inference interface shared by the managed provider and deterministic tests. */
export interface TurnModels {
  /** @param pcm - borrowed task-local mono PCM16. @returns current VAD facts. */
  vad(pcm: Uint8Array): Promise<{ speaking: boolean; ended: boolean }>
  /** @param pcm - bounded recent audio. @returns trained endpoint probability. */
  endpoint(pcm: Uint8Array): Promise<number>
  /** Drain the partial VAD window at the captured cutoff. @returns whether speech remains active. */
  flush(): Promise<boolean>
  /** Clear VAD history between physical ASR tasks. */
  reset(): Promise<void>
}

/** One listening task; raw audio is limited to the model's eight-second window. */
export class TurnDetector {
  private samples = 0
  private speech = 0
  private recent = Buffer.alloc(0)
  private generation = 0
  private prediction: Promise<void> | undefined
  private predictedAt = 0
  private sealed = false
  private reviewToken: { id: TurnReviewId; speech: number; samples: number; prepared: boolean } | undefined

  constructor(private readonly models: TurnModels, private readonly config: Pick<Config, 'threshold'> & { silenceSeconds: number },
    private readonly emit: (frame: TurnFrame) => void, private readonly failed: (error: unknown) => void) {}

  private isSealed(): boolean { return this.sealed }

  /** Consume one ordered frame before publishing its VAD observation.
   * @param pcm - validated PCM.
   * @param startSample - contiguous task position.
   * @returns after the VAD input operation settles.
   */
  async accept(pcm: Uint8Array, startSample: number): Promise<void> {
    if (this.sealed || startSample !== this.samples) throw new Error('Voice sample order changed')
    this.samples += pcm.length / 2
    this.recent = Buffer.concat([this.recent, pcm]).subarray(-128000 * 2)
    const generation = this.generation
    const activity = await this.models.vad(pcm)
    if (generation !== this.generation) return
    if (activity.speaking || activity.ended) this.speech = this.samples
    this.emit({ kind: 'accepted', samples: this.samples, speaking: activity.speaking })
    if (this.speech > 0 && !activity.speaking && !this.prediction
      && (activity.ended || this.samples - this.predictedAt >= this.config.silenceSeconds * 16000)) {
      const speech = this.speech, cutoff = this.samples
      this.predictedAt = cutoff
      const audio = Buffer.from(this.recent)
      this.emit({ kind: 'candidate', samples: cutoff })
      const prediction = this.models.endpoint(audio).then((probability) => {
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid endpoint probability')
        if (generation !== this.generation || this.sealed || speech !== this.speech) return
        if (probability > this.config.threshold) {
          this.emit({ kind: 'complete', samples: cutoff, probability })
        }
      }).catch(this.failed)
      this.prediction = prediction
      void prediction.finally(() => { if (this.prediction === prediction) this.prediction = undefined })
    }
  }

  /** Check an aligned live cutoff without consuming the current ASR task.
   * @param reviewId - mode-owned identity, invalidated by the next review.
   * @param samples - actual Worklet checkpoint, aligned to the Silero window.
   * @returns whether the current speech permits a reversible closing attempt.
   */
  async review(reviewId: TurnReviewId, samples: number): Promise<boolean> {
    this.reviewToken = undefined
    if (this.sealed || samples !== this.samples || samples % 512 !== 0) throw new Error('Invalid voice review cutoff')
    const generation = this.generation, speech = this.speech
    await this.prediction
    if (speech === 0 || await this.models.flush()) return false
    const probability = await this.models.endpoint(Buffer.from(this.recent))
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid endpoint probability')
    if (generation !== this.generation || this.isSealed() || speech !== this.speech || probability <= this.config.threshold) return false
    this.reviewToken = { id: reviewId, speech, samples, prepared: false }
    return true
  }

  /** Check VAD and the complete audio through the Worklet-flushed position.
   * @param samples - flushed sample count.
   * @param explicit - user explicitly ended speech.
   * @param reviewId - automatic review identity; absent only for explicit completion.
   * @returns whether every flushed frame still permits admission.
   */
  async seal(samples: number, explicit: boolean, reviewId?: TurnReviewId): Promise<boolean> {
    const token = this.reviewToken, generation = this.generation
    const valid = !this.sealed && samples === this.samples && (explicit || reviewId !== undefined
      && token?.id === reviewId && token.speech === this.speech && samples % 512 === 0)
    await this.prediction
    const speaking = await this.models.flush()
    if (!valid || !explicit && speaking || generation !== this.generation
      || !explicit && reviewId && (token !== this.reviewToken || token?.speech !== this.speech)) return false
    if (explicit) { this.sealed = true; this.generation++; this.recent = Buffer.alloc(0); return true }
    const probability = await this.models.endpoint(Buffer.from(this.recent))
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid endpoint probability')
    if (generation !== this.generation || this.sealed || probability <= this.config.threshold
      || reviewId && (token !== this.reviewToken || token?.speech !== this.speech)) return false
    if (reviewId && token && token === this.reviewToken && token.speech === this.speech) {
      token.samples = samples; token.prepared = true
    } else return false
    return true
  }

  /** Commit a reviewed ASR cutoff only after the final live tail has reached VAD.
   * @param reviewId - prepared review identity.
   * @param samples - immutable ASR cutoff whose complete audio was checked by seal.
   * @param coveredSamples - final locked capture position, including VAD-only lookahead.
   * @returns false for a superseded review, without consuming the task.
   */
  async commit(reviewId: TurnReviewId, samples: number, coveredSamples: number): Promise<boolean> {
    if (coveredSamples !== this.samples || coveredSamples < samples || coveredSamples % 512 !== 0) throw new Error('Invalid voice commit coverage')
    const token = this.reviewToken
    await this.prediction
    const speaking = await this.models.flush()
    if (this.sealed || !token?.prepared || token !== this.reviewToken || token.id !== reviewId
      || token.samples !== samples || token.speech !== this.speech || speaking) return false
    this.sealed = true; this.generation++; this.reviewToken = undefined; this.recent = Buffer.alloc(0)
    return true
  }

  /** Reset between tasks after pending inference has settled. */
  async reset(): Promise<void> {
    this.generation++
    await this.prediction
    await this.models.reset()
    this.samples = 0; this.speech = 0; this.predictedAt = 0
    this.reviewToken = undefined
    this.recent = Buffer.alloc(0); this.sealed = false
  }

  /** Invalidate late decisions and release retained audio before worker shutdown. */
  async dispose(): Promise<void> {
    this.generation++; this.sealed = true; this.reviewToken = undefined; this.recent = Buffer.alloc(0)
    await this.prediction
  }
}
