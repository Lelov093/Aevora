/** One cancellable read-aloud operation per Client plugin instance. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, MessageId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { decodePcm } from './audio.ts'
import { speechDiagnostic, type SpeechDiagnostic } from './failure.ts'

/** User-visible output state; no audio or credentials are persisted. */
export interface PlaybackState {
  owner: string | null
  phase: 'idle' | 'synthesizing' | 'playing'
  failure: number | null
  diagnostic: SpeechDiagnostic | null
}

interface Operation { owner: string; abort: AbortController; audio: AudioContext; source?: AudioBufferSourceNode; usage?: SpeechDiagnostic['usage'] }

/** Owns synthesis cancellation, audio resources and late-result rejection. */
export class VoicePlayback {
  /** Current output owner, phase and dismissible failure. */
  readonly state = createSnapshotStore<PlaybackState>({ owner: null, phase: 'idle', failure: null, diagnostic: null })
  private active: Operation | undefined
  private failureSequence = 0
  private readonly pending = new Set<Promise<void>>()
  private readonly closing = new Set<Promise<void>>()
  constructor(private readonly remote: Pick<ClientRemote['tts'], 'synthesize'>, private readonly createAudio = () => new AudioContext(),
    private readonly report: (diagnostic: SpeechDiagnostic) => void = () => {}) {}

  /**
   * Replace the current read with one explicitly selected reply.
   * @param session - current view owner.
   * @param message - finalized reply.
   * @param text - visible plain prose.
   * @returns settlement after synthesis and playback admission.
   */
  read(session: SessionId, message: MessageId, text: string): Promise<void> {
    const pending = this.run(session, message, text)
    this.pending.add(pending)
    void pending.finally(() => { this.pending.delete(pending) })
    return pending
  }

  private async run(session: SessionId, message: MessageId, text: string): Promise<void> {
    this.stop()
    const owner = `${session}/${message}`
    let operation: Operation | undefined
    let stage: 'synthesis' | 'playback' = 'playback'
    try {
      // Start the browser audio context in the user gesture, before network work.
      const audio = this.createAudio()
      operation = { owner, abort: new AbortController(), audio }
      this.active = operation
      this.state.set({ owner, phase: 'synthesizing', failure: null, diagnostic: null })
      await audio.resume()
      if (this.active !== operation) return
      stage = 'synthesis'
      const result = await this.remote.synthesize(text, operation.abort.signal)
      if (this.active !== operation) return
      if (!result.ok) throw result.error
      operation.usage = result.value.usage
      stage = 'playback'
      const buffer = decodePcm(audio, result.value.audioBase64, result.value.sampleRate)
      const source = audio.createBufferSource()
      operation.source = source
      source.buffer = buffer
      source.connect(audio.destination)
      source.onended = () => { if (this.active === operation) this.stop() }
      this.state.set({ owner, phase: 'playing', failure: null, diagnostic: null })
      source.start()
    } catch (error) {
      if (operation !== undefined && this.active !== operation) return
      this.stop()
      const diagnostic = speechDiagnostic(error, stage, operation?.usage)
      this.state.set({ owner: null, phase: 'idle', failure: ++this.failureSequence, diagnostic })
      this.report(diagnostic)
    }
  }

  /**
   * Cancel synthesis and release playback resources.
   * @param owner - only stop this mounted reply when specified.
   */
  stop(owner?: string): void {
    const active = this.active
    if (owner !== undefined && active?.owner !== owner) return
    this.active = undefined
    if (active) {
      active.abort.abort()
      if (active.source) { active.source.onended = null; active.source.stop(); active.source.disconnect() }
      const closing = active.audio.close().catch((error: unknown) => {
        const diagnostic = speechDiagnostic(error, 'playback', active.usage)
        this.state.set({ owner: null, phase: 'idle', failure: ++this.failureSequence, diagnostic })
        this.report(diagnostic)
      })
      this.closing.add(closing)
      void closing.finally(() => { this.closing.delete(closing) })
    }
    this.state.set({ ...this.state.getSnapshot(), owner: null, phase: 'idle' })
  }

  /**
   * Dismiss the specified failure without hiding a later one.
   * @param sequence - toast being dismissed.
   */
  dismiss(sequence: number): void {
    const current = this.state.getSnapshot()
    if (current.failure === sequence) this.state.set({ ...current, failure: null, diagnostic: null })
  }

  /** Stop output and join request/audio release before the plugin unloads. */
  async dispose(): Promise<void> {
    this.stop()
    await Promise.allSettled([...this.pending, ...this.closing])
  }
}
