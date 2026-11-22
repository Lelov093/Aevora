/** One ordered audio queue over a physical, non-reconnecting TTS Remote stream. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { decodePcm } from './audio.ts'
import { speechDiagnostic, type SpeechDiagnostic } from './failure.ts'
import type { VoicePlaybackState, VoicePauseId, VoicePauseReason, VoicePlaybackId } from './output.ts'

type Handle = ReturnType<ClientRemote['tts']['stream']>
type Frame = Handle extends AsyncIterable<infer Item> ? Item : never
type Capabilities = Extract<Awaited<ReturnType<ClientRemote['tts']['capabilities']>>, { ok: true }>['value']
type Limits = Capabilities['limits']
type Usage = Extract<Frame, { kind: 'usage' }>['usage']
type Command = Parameters<Handle['send']>[0]

/** Player-confirmed progress, separate from accepted text and received audio. */
export type StreamPlaybackState = VoicePlaybackState

/** Local permission; the service adds its native submission identity. */
export interface PlaybackPause {
  readonly id: VoicePauseId
  readonly batchId: VoicePlaybackId
  readonly reason: VoicePauseReason
}

interface AudioOwner {
  audio: AudioContext
  tail: Promise<void>
  transitioning: boolean
  detach: () => void
}

interface Scheduled {
  source: AudioBufferSourceNode
  start: number
  startSample: number
  samples: number
  finished: boolean
}
interface Operation {
  failed: (diagnostic: SpeechDiagnostic) => void
  handle: Handle | undefined
  abort: AbortController
  limits: Limits
  owner: AudioOwner
  id: VoicePlaybackId
  holds: Map<VoicePauseReason, PlaybackPause>
  revision: number
  ready: boolean
  systemPaused: boolean
  deadline: ReturnType<typeof setTimeout> | undefined
  commands: Array<{ kind: 'text'; text: string } | { kind: 'boundary' }>
  pendingBytes: number
  sending: { sequence: number; bytes: number } | undefined
  textSequence: number
  textOffset: number
  audioSequence: number
  finishWanted: boolean
  finishSent: boolean
  nextStart: number
  scheduled: Scheduled[]
  receipts: Map<string, Usage>
  providerDone: boolean
  done: boolean
}

/** Prepares audio only from a gesture, then shares that context while automatic speech is armed. */
export class StreamPlayback {
  /** Current audio owner progress; no audio bytes or credentials are persisted. */
  readonly state = createSnapshotStore<StreamPlaybackState>({ phase: 'idle', receivedSamples: 0, playedSamples: 0,
    batchId: null, userPaused: false, candidatePaused: false, systemPaused: false, position: null,
    sampleRate: 0, tasks: 0, usage: { inputTokens: null, outputTokens: null, characters: null }, outcome: null })
  private audio: AudioOwner | undefined
  private active: Operation | undefined
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly remote: Pick<ClientRemote['tts'], 'stream'>, private readonly createAudio = () => new AudioContext()) {}

  /** Prepare the audio context during explicit user activation. */
  async prepare(): Promise<void> {
    const audio = this.createAudio()
    const owner: AudioOwner = { audio, tail: Promise.resolve(), transitioning: false, detach: () => {} }
    const changed = (): void => {
      const op = this.active
      if (op?.owner !== owner || owner.transitioning || audio.state === 'running') return
      if (op.holds.size > 0 && audio.state === 'suspended') return
      op.systemPaused = true
      this.limitPause(op)
      this.publishPause(op, 'paused')
    }
    audio.addEventListener('statechange', changed)
    owner.detach = () => { audio.removeEventListener('statechange', changed) }
    this.audio = owner
    const activation = audio.resume()
    owner.tail = activation.catch((_activationFailed: unknown) => { /* prepare reports this failure to its owner. */ })
    await activation
    if (this.audio !== owner) throw new Error('Speech activation was replaced')
  }

  /** Reserve one queue; the physical stream opens only when text can be sent.
   * @param limits - capability snapshot read before enabling automatic speech.
   * @param failed - owner callback for a non-cancellation failure.
   */
  begin(limits: Limits, failed: (diagnostic: SpeechDiagnostic) => void): void {
    this.stop()
    const owner = this.audio
    if (owner === undefined) throw new Error('Audio must be prepared by a user gesture')
    const abort = new AbortController()
    const op: Operation = { handle: undefined, failed, abort, limits, owner, id: randomUUID() as VoicePlaybackId,
      holds: new Map(), revision: 0, ready: false, systemPaused: false, deadline: undefined, commands: [], pendingBytes: 0,
      sending: undefined, textSequence: 0, textOffset: 0, audioSequence: 0, finishWanted: false, finishSent: false,
      nextStart: owner.audio.currentTime, scheduled: [], receipts: new Map(), providerDone: false, done: false }
    this.active = op
    this.state.set({ phase: 'synthesizing', receivedSamples: 0, playedSamples: 0, sampleRate: 0, tasks: 0,
      batchId: op.id, userPaused: false, candidatePaused: false, systemPaused: false, position: null,
      usage: { inputTokens: null, outputTokens: null, characters: null }, outcome: null })
    void this.syncAudio(op)
  }

  private track(pending: Promise<void>): void {
    this.pending.add(pending)
    void pending.finally(() => { this.pending.delete(pending) })
  }

  private fail(op: Operation, error: unknown): void {
    if (this.active !== op || op.abort.signal.aborted) return
    const diagnostic = speechDiagnostic(error, 'playback', this.state.getSnapshot().usage)
    this.stop()
    op.failed(diagnostic)
  }

  private position(op: Operation): NonNullable<StreamPlaybackState['position']> {
    const state = this.state.getSnapshot()
    let samples = state.playedSamples
    for (const entry of op.scheduled) {
      const elapsed = Math.min(entry.samples, Math.max(0, Math.floor((op.owner.audio.currentTime - entry.start) * state.sampleRate)))
      if (elapsed > 0) samples = Math.max(samples, entry.startSample + elapsed)
    }
    return { samples, basis: 'audio-context-clock' }
  }

  private publishPause(op: Operation, phase: StreamPlaybackState['phase']): void {
    this.state.set({ ...this.state.getSnapshot(), phase, userPaused: op.holds.has('user'),
      candidatePaused: op.holds.has('candidate'), systemPaused: op.systemPaused, position: this.position(op) })
  }

  private limitPause(op: Operation): void {
    if (op.deadline !== undefined) return
    op.deadline = setTimeout(() => {
      if (this.active !== op) return
      const usage = this.state.getSnapshot().usage
      this.stop()
      op.failed({ reason: 'timeout', stage: 'playback', usage })
    }, op.limits.consumerTimeoutMs)
  }

  private syncAudio(op: Operation): Promise<void> {
    const revision = ++op.revision
    op.ready = false
    const paused = op.holds.size > 0 || op.systemPaused
    this.publishPause(op, paused ? 'pausing' : 'resuming')
    const pending = op.owner.tail.then(async () => {
      if (this.active !== op || revision !== op.revision) return
      op.owner.transitioning = true
      try {
        if (paused) await op.owner.audio.suspend()
        else await op.owner.audio.resume()
      } finally { op.owner.transitioning = false }
      if (this.active !== op || revision !== op.revision) return
      if (!paused && op.owner.audio.state !== 'running') throw new Error('Audio did not resume')
      op.ready = true
      this.publishPause(op, paused ? 'paused' : op.scheduled.length > 0 ? 'playing' : 'synthesizing')
      if (!paused) {
        clearTimeout(op.deadline)
        op.deadline = undefined
        if (op.providerDone) this.complete(op)
        else this.pump(op)
      }
    }).catch((error: unknown) => { this.fail(op, error) })
    op.owner.tail = pending
    this.track(pending)
    return pending
  }

  private async settleAudio(op: Operation): Promise<void> {
    while (this.active === op) {
      const transition = op.owner.tail
      await transition
      if (transition === op.owner.tail) return
    }
  }

  /** Suspend the dedicated output graph without discarding sources or text.
   * @param reason - owner of this independently releasable pause.
   * @returns a batch-bound permission after suspension, or null after replacement/failure.
   */
  async pause(reason: VoicePauseReason): Promise<PlaybackPause | null> {
    const op = this.active
    if (op === undefined || op.done) return null
    let hold = op.holds.get(reason)
    if (hold === undefined) {
      hold = { id: randomUUID() as VoicePauseId, batchId: op.id, reason }
      op.holds.set(reason, hold)
      // A pre-existing system suspension is not permission for candidate recovery.
      if (!op.owner.transitioning && op.ready && op.holds.size === 1 && op.owner.audio.state !== 'running') op.systemPaused = true
      this.limitPause(op)
      void this.syncAudio(op)
    }
    await this.settleAudio(op)
    return this.active === op && op.holds.get(reason) === hold ? hold : null
  }

  private matches(op: Operation | undefined, hold: PlaybackPause): op is Operation {
    return op !== undefined && op.id === hold.batchId && op.holds.get(hold.reason)?.id === hold.id
  }

  /** Release one permission; candidate release cannot resume a system suspension.
   * @param hold - permission from this batch.
   * @returns false for expired, released or replaced permissions.
   */
  async resume(hold: PlaybackPause): Promise<boolean> {
    const op = this.active
    if (!this.matches(op, hold)) return false
    op.holds.delete(hold.reason)
    if (hold.reason === 'user') op.systemPaused = false
    void this.syncAudio(op)
    await this.settleAudio(op)
    return this.active === op || (op.done && this.state.getSnapshot().batchId === op.id)
  }

  /** Confirm a matching pause as terminal without touching newer audio.
   * @param hold - unreleased permission from this batch.
   * @returns whether this batch was stopped.
   */
  confirmStop(hold: PlaybackPause): boolean {
    if (!this.matches(this.active, hold)) return false
    this.stop()
    return true
  }

  /** Stage one fresh piece, bounded before native send() can retain it.
   * @param text - newly committed plain text.
   */
  append(text: string): void {
    const op = this.active
    if (op === undefined || op.finishWanted) throw new Error('No writable speech operation')
    if (!text.trim()) return
    const bytes = new TextEncoder().encode(text).byteLength
    if (op.pendingBytes + bytes > op.limits.maxPendingTextBytes || op.commands.length >= op.limits.maxBufferedFrames) {
      throw new Error('Speech text queue is full')
    }
    op.pendingBytes += bytes
    op.commands.push({ kind: 'text', text })
    this.pump(op)
  }

  /** Finish a native assistant step without closing the logical reply's speech stream. */
  boundary(): void {
    const op = this.active
    if (op === undefined || op.finishWanted) return
    if (op.commands.length >= op.limits.maxBufferedFrames) throw new Error('Speech boundary queue is full')
    op.commands.push({ kind: 'boundary' })
    this.pump(op)
  }

  /** Half-close text after the native reply ends; playback receipts remain writable. */
  finish(): void {
    const op = this.active
    if (op === undefined || op.finishWanted) return
    op.finishWanted = true
    this.pump(op)
  }

  private send(op: Operation, command: Command): void {
    if (this.active !== op || op.abort.signal.aborted) return
    op.handle?.send(command)
  }

  private complete(op: Operation): void {
    if (this.active !== op || !op.ready || op.holds.size > 0 || op.systemPaused) return
    op.done = true
    this.active = undefined
    clearTimeout(op.deadline)
    this.state.set({ ...this.state.getSnapshot(), phase: 'idle', userPaused: false, candidatePaused: false,
      systemPaused: false, outcome: 'done' })
  }

  private pump(op: Operation): void {
    if (op.sending !== undefined || this.active !== op || !op.ready || op.holds.size > 0 || op.systemPaused) return
    if (op.handle === undefined && op.commands.some(command => command.kind === 'text')) {
      const handle = this.remote.stream(op.abort.signal)
      op.handle = handle
      this.track(this.consume(op, handle).catch((error: unknown) => { this.fail(op, error) }))
    }
    while (true) {
      const next = op.commands.shift()
      if (next === undefined) {
        if (op.finishWanted && !op.finishSent) {
          op.finishSent = true
          if (op.handle === undefined) {
            op.providerDone = true
            this.complete(op)
          } else this.send(op, { kind: 'finish' })
        }
        return
      }
      if (next.kind === 'boundary') { this.send(op, next); continue }
      const sequence = op.textSequence++
      const bytes = new TextEncoder().encode(next.text).byteLength
      op.sending = { sequence, bytes }
      this.send(op, { kind: 'text', sequence, offset: op.textOffset, text: next.text })
      op.textOffset += next.text.length
      return
    }
  }

  private usage(op: Operation): Usage {
    const total = (field: keyof Usage): number | null => {
      if (op.receipts.size === 0) return null
      let sum = 0
      for (const usage of op.receipts.values()) { if (usage[field] === null) return null; sum += usage[field] }
      return sum
    }
    return { inputTokens: total('inputTokens'), outputTokens: total('outputTokens'), characters: total('characters') }
  }

  private schedule(op: Operation, frame: Extract<Frame, { kind: 'audio' }>): void {
    const state = this.state.getSnapshot()
    if (frame.sequence !== op.audioSequence++ || frame.startSample !== state.receivedSamples
      || frame.sampleRate !== state.sampleRate) throw new Error('Audio sequence or format changed')
    const audio = op.owner.audio
    const buffer = decodePcm(audio, frame.audioBase64, frame.sampleRate)
    const receivedSamples = frame.startSample + buffer.length
    if ((receivedSamples - state.playedSamples) / frame.sampleRate * 1000 > op.limits.maxQueuedAudioMs) {
      throw new Error('Audio queue exceeded its playback window')
    }
    const source = audio.createBufferSource()
    source.buffer = buffer
    source.connect(audio.destination)
    const start = Math.max(audio.currentTime, op.nextStart)
    const entry = { source, start, startSample: frame.startSample, samples: buffer.length, finished: false }
    op.scheduled.push(entry)
    op.nextStart = start + buffer.length / frame.sampleRate
    source.onended = () => {
      source.disconnect()
      if (this.active !== op) return
      entry.finished = true
      let played = this.state.getSnapshot().playedSamples
      while (op.scheduled[0]?.finished) {
        const complete = op.scheduled.shift()
        if (complete !== undefined) played = complete.startSample + complete.samples
      }
      const position = this.position(op)
      this.state.set({ ...this.state.getSnapshot(), playedSamples: played,
        position: { ...position, samples: Math.max(played, position.samples) } })
      try { this.send(op, { kind: 'played', samples: played }) }
      catch (error) {
        const diagnostic = speechDiagnostic(error, 'playback', this.state.getSnapshot().usage)
        this.stop()
        op.failed(diagnostic)
      }
    }
    this.state.set({ ...state, receivedSamples, phase: op.holds.size > 0 || op.systemPaused || !op.ready ? state.phase : 'playing' })
    source.start(start)
  }

  private async consume(op: Operation, handle: Handle): Promise<void> {
    try {
      for await (const frame of handle) {
        if (this.active !== op) return
        switch (frame.kind) {
          case 'ready': op.limits = frame.limits; break
          case 'text-accepted':
            if (op.sending?.sequence !== frame.sequence) throw new Error('Unexpected text acceptance')
            op.pendingBytes -= op.sending.bytes
            op.sending = undefined
            this.pump(op)
            break
          case 'task-started': {
            const state = this.state.getSnapshot()
            if (state.sampleRate !== 0 && state.sampleRate !== frame.sampleRate) throw new Error('Speech sample rate changed')
            op.receipts.set(frame.taskId, { inputTokens: null, outputTokens: null, characters: null })
            this.state.set({ ...state, sampleRate: frame.sampleRate, tasks: op.receipts.size, usage: this.usage(op) })
            break
          }
          case 'audio': this.schedule(op, frame); break
          case 'sentence': break // Without a requested alignment UI, no word position is inferred.
          case 'usage':
          case 'task-finished':
            op.receipts.set(frame.taskId, frame.usage)
            this.state.set({ ...this.state.getSnapshot(), usage: this.usage(op), tasks: op.receipts.size })
            break
          case 'done':
            if (frame.samples !== this.state.getSnapshot().playedSamples || op.scheduled.length !== 0) {
              throw new Error('Speech ended before confirmed playback')
            }
            op.providerDone = true
            this.complete(op)
            break
          default: assertNever(frame)
        }
      }
      if (!op.providerDone && !op.abort.signal.aborted) throw new Error('Speech stream ended without completion')
    } finally { handle.dispose() }
  }

  /** Stop every scheduled source and preserve only player-confirmed partial progress. */
  stop(): void {
    const op = this.active
    if (op === undefined) return
    this.active = undefined
    op.abort.abort()
    op.handle?.dispose()
    clearTimeout(op.deadline)
    const state = this.state.getSnapshot()
    const position = this.position(op)
    for (const entry of op.scheduled) {
      entry.source.onended = null
      entry.source.stop()
      entry.source.disconnect()
    }
    op.scheduled.length = 0
    op.commands.length = 0
    op.holds.clear()
    this.state.set({ ...state, phase: 'idle', userPaused: false, candidatePaused: false, systemPaused: false, position, outcome: 'stopped' })
  }

  /** Stop streaming and release the user-activated context and all owned consumers. */
  async release(): Promise<void> {
    this.stop()
    const audio = this.audio
    this.audio = undefined
    await Promise.allSettled(this.pending)
    if (audio !== undefined) {
      audio.detach()
      await audio.tail
      await audio.audio.close()
    }
  }
}
