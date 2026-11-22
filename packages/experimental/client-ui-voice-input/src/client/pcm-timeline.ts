/** One physical capture with bounded, credit-preserving handoff between recognition tasks. */
import { PcmCapture, PcmCaptureFailure } from './pcm-capture.ts'

/** Task-facing capture operations; disposal releases that task, not a shared device. */
export type PcmInput = Pick<PcmCapture, 'prepare' | 'start' | 'accept' | 'checkpointAt' | 'finish' | 'dispose'>
type Frame = { pcm: Uint8Array; start: number; staged: boolean }
interface Intake {
  base: number
  accepted: number
  end: number | undefined
  cutoff: number | undefined
  retaining: boolean
  retained: Frame[]
  frame: ((pcm: Uint8Array, samples: number) => void) | undefined
  staged: ((pcm: Uint8Array, samples: number) => void) | undefined
}

/** The mode owns the device; task ports retain only bounded PCM and ordered credit positions. */
export class PcmTimeline {
  private readonly records: Intake[] = []
  private active: Intake | undefined
  private buffered: Frame[] = []
  private samples = 0
  private nextBase = 0
  private credited = 0
  private capacity = 0
  private started = false
  private closed = false

  constructor(private readonly capture: PcmCapture, private readonly maxTasks: number) {}

  private receive(pcm: Uint8Array, start: number, staged: boolean): void {
    if (this.closed) return
    if (start !== this.samples) throw new PcmCaptureFailure('protocol')
    this.samples += pcm.length / 2
    const item = { pcm, start, staged }
    const active = this.active
    if (active === undefined) {
      if (this.samples - this.nextBase > this.capacity) throw new PcmCaptureFailure('limit')
      this.buffered.push(item)
    } else {
      if (active.retaining) active.retained.push(item)
      const consume = staged ? active.staged : active.frame
      if (consume === undefined) throw new PcmCaptureFailure('protocol')
      consume(pcm, start - active.base)
    }
  }

  private credit(): void {
    while (this.records[0]?.end !== undefined && this.records[0].accepted === this.records[0].end) this.records.shift()
    const first = this.records[0]
    const accepted = first === undefined ? this.nextBase : first.accepted
    if (accepted > this.credited) { this.capture.accept(accepted); this.credited = accepted }
  }

  /** Reserve a task-local view without restarting the physical microphone.
   * @returns a port whose sample zero follows the preceding committed cutoff.
   */
  port(): PcmInput {
    const task: Intake = { base: this.nextBase, accepted: this.nextBase, end: undefined, cutoff: undefined,
      retaining: false, retained: [], frame: undefined, staged: undefined }
    return {
      prepare: rate => this.capture.prepare(rate),
      start: async (rate, limits, frame, failed, staged) => {
        if (this.closed || this.active !== undefined || this.records.length >= this.maxTasks) throw new PcmCaptureFailure('limit')
        task.base = this.nextBase; task.accepted = task.base
        task.frame = frame; task.staged = staged
        this.active = task; this.records.push(task); this.capacity = limits.maxPendingSamples
        if (!this.started) {
          this.started = true
          await this.capture.start(rate, limits, (pcm, start) => { this.receive(pcm, start, false) }, failed,
            (pcm, start) => { this.receive(pcm, start, true) })
        } else {
          const buffered = this.buffered; this.buffered = []
          for (const item of buffered) frame(item.pcm, item.start - task.base)
        }
      },
      accept: (samples) => {
        const absolute = task.base + samples
        if (absolute < task.accepted || (task.end !== undefined && absolute > task.end)) throw new PcmCaptureFailure('protocol')
        task.accepted = absolute; this.credit()
      },
      checkpointAt: async (kind, timeout) => {
        if (this.active !== task) throw new PcmCaptureFailure('protocol')
        if (kind === 'park') task.retaining = true
        const absolute = await this.capture.checkpointAt(kind, timeout)
        if (kind === 'checkpoint') task.cutoff = absolute
        if (kind === 'resume') { task.retaining = false; task.retained.length = 0 }
        return absolute - task.base
      },
      finish: async (timeout, _retainDevice, committed) => {
        if (this.active !== task) throw new PcmCaptureFailure('protocol')
        let covered: number
        if (committed) {
          covered = this.samples
          if (task.cutoff === undefined) throw new PcmCaptureFailure('protocol')
        } else {
          task.retaining = true
          await this.capture.checkpointAt('park', timeout)
          covered = await this.capture.checkpointAt('lock', timeout)
          task.cutoff = covered
        }
        task.end = task.cutoff
        this.nextBase = task.cutoff
        this.buffered = task.retained.filter(item => item.start >= this.nextBase)
        task.retained = []; this.active = undefined; this.credit()
        await this.capture.checkpointAt('resume', timeout)
        return covered - task.base
      },
      dispose: () => { task.frame = undefined; task.staged = undefined; task.retained.length = 0; return Promise.resolve() },
    }
  }

  /** Close the mode-owned physical capture and discard remaining task buffers.
   * @returns after the AudioContext and tracks are released.
   */
  async dispose(): Promise<void> {
    this.closed = true; this.active = undefined; this.buffered.length = 0; this.records.length = 0
    await this.capture.dispose()
  }
}
