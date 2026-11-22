/** Explicit foreground-initiated speech, admitted only by locally submitted prompt identities. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { StreamingSpeechText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { StreamPlayback } from './stream-playback.ts'
import { speechDiagnostic, type SpeechDiagnostic } from './failure.ts'
import type { VoiceReplyOutcome, VoiceRequestId, VoicePause, VoicePauseReason, VoicePlaybackObservation } from './output.ts'

type Capabilities = Extract<Awaited<ReturnType<ClientRemote['tts']['capabilities']>>, { ok: true }>['value']
type RequestId = ReturnType<SessionFace['getSnapshot']>['pendingSubmissions'][number]['requestId']

/** Mode and transient outcomes; playback progress remains in its own owning source. */
export interface AutomaticVoiceState {
  readonly session: SessionId | null
  readonly enabled: boolean
  readonly busy: boolean
  readonly available: boolean
  readonly notice: { readonly sequence: number; readonly kind: 'failed' | 'retried'; readonly diagnostic: SpeechDiagnostic | null } | null
}

interface StepSpeech {
  attempt: number
  buffers: StreamingSpeechText[]
  lengths: number[]
  ended: boolean
}

interface ReplySpeech {
  requestId: VoiceRequestId
  turn: number
  userSeq: number
  minStep: number
  started: boolean
  finished: boolean
  muted: boolean
  bytes: number
  limits: Capabilities['limits']
  step: number | null
  attempt: number | null
}

/** One Client's explicit automatic mode; no history read or restore can enable it. */
export class AutomaticVoice {
  /** Per-request terminal result for explicitly authorized speech consumers. */
  readonly replies = createSnapshotStore<VoiceReplyOutcome | null>(null)
  /** Ephemeral request/attempt identity and separately sourced audio observations. */
  readonly playback = createSnapshotStore<VoicePlaybackObservation | null>(null)
  private restricted = false
  /** Explicit mode and its root-owned transient feedback. */
  readonly state = createSnapshotStore<AutomaticVoiceState>({ session: null, enabled: false, busy: false, available: false, notice: null })
  /** Shared incremental audio owner; manual playback replaces it through the apply callbacks. */
  readonly player: StreamPlayback
  private capabilities: Capabilities | undefined
  private activation = 0
  private refreshGeneration = 0
  private noticeSequence = 0
  private disposed = false
  private readonly releases = new Set<Promise<void>>()
  private observers: (() => void)[] = []
  private readonly requests = new Set<RequestId>()
  private readonly existing = new Set<RequestId>()
  private readonly steps = new Map<number, StepSpeech>()
  private current: ReplySpeech | undefined
  private readonly offPlayback: () => void

  constructor(private readonly ctx: Context, private readonly beforePlay: () => void,
    player?: StreamPlayback) {
    this.player = player ?? new StreamPlayback(ctx.remote.tts)
    this.offPlayback = this.player.state.subscribe(() => { this.publishPlayback() })
    void this.refresh()
  }

  /** Refresh only local capability information, without starting or reopening synthesis. */
  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration
    try {
      const result = await this.ctx.remote.tts.capabilities()
      if (this.disposed || generation !== this.refreshGeneration) return
      this.capabilities = result.ok ? result.value : undefined
      this.state.set({ ...this.state.getSnapshot(), available: this.capabilities?.streaming === true })
    } catch (_unavailableConnection) {
      if (!this.disposed && generation === this.refreshGeneration) {
        this.capabilities = undefined
        this.state.set({ ...this.state.getSnapshot(), available: false })
      }
    }
  }

  /** Toggle current-view mode from the user gesture; already running replies are not admitted.
   * @param sessionId - current composer owner.
   * @param restricted - require explicit authorization for each native prompt identity.
   */
  async toggle(sessionId: SessionId, restricted = false): Promise<void> {
    const previous = this.state.getSnapshot()
    if (previous.busy) return
    if (previous.enabled && previous.session === sessionId) { this.disable(); return }
    const binding = this.ctx.sessions.binding(sessionId)
    const retained = this.ctx.sessions.retainInfo(sessionId).getSnapshot()
    if (binding === undefined || !retained.retainedBy.mainView || !this.capabilities?.streaming) return
    this.disable()
    this.restricted = restricted
    const activation = ++this.activation
    this.state.set({ ...this.state.getSnapshot(), session: sessionId, enabled: false, busy: true })
    try {
      // AudioContext construction and resume both begin before the first await.
      const preparation = this.player.prepare()
      await preparation
      if (this.disposed || activation !== this.activation) return
      const conversation = this.ctx.uiConversation.binding(binding)
      const chat = conversation.target('chat')
      const initial = chat.getSnapshot()
      const watermark = Math.max(0, ...(initial?.timeline.turnOrder ?? []))
      for (const submission of binding.session.getSnapshot().pendingSubmissions) this.existing.add(submission.requestId)
      const observe = (): void => {
        if (activation !== this.activation) return
        const session = binding.session.getSnapshot()
        for (const submission of session.pendingSubmissions) {
          if (!this.restricted && !this.existing.has(submission.requestId)) this.requests.add(submission.requestId)
        }
        const snapshot = chat.getSnapshot()
        if (snapshot !== undefined) {
          try { this.accept(snapshot, watermark) }
          catch (error) { this.mute('failed', speechDiagnostic(error, 'text')) }
        }
      }
      this.observers = [binding.session.subscribe(observe), chat.subscribe(observe),
        this.player.state.subscribe(() => { this.settlePlayback() }),
        this.ctx.sessions.retainInfo(sessionId).subscribe(observe)]
      this.state.set({ ...this.state.getSnapshot(), enabled: true, busy: false })
    } catch (error) {
      if (activation === this.activation) { this.disable(); this.notice('failed', speechDiagnostic(error, 'playback')) }
    }
  }

  private accept(snapshot: ChatSnapshot, watermark: number): void {
    let admission: { turn: number; seq: number; minStep: number; requestId: VoiceRequestId } | undefined
    if (this.requests.size > 0) {
      for (const number of snapshot.timeline.turnOrder) {
        if (number < watermark) continue
        const turn = snapshot.timeline.turns.get(number)
        if (turn === undefined) continue
        const users = [...snapshot.nodes.turnDataSource(number, 'user').getSnapshot(),
          ...snapshot.nodes.turnDataSource(number, 'steering').getSnapshot()]
        for (const user of users) {
          const source = user.source
          if (typeof source !== 'object' || source === null || !('rpcId' in source) || typeof source.rpcId !== 'string') continue
          const request = [...this.requests].find(id => id === source.rpcId)
          if (request === undefined) continue
          this.requests.delete(request)
          const step = turn.steps.find(item => item.start !== undefined && item.start.seq <= user.seq
            && (item.end === undefined || item.end.seq >= user.seq))
          if (admission === undefined || user.seq > admission.seq) {
            admission = { turn: number, seq: user.seq, minStep: step?.step ?? 0, requestId: request }
          }
        }
      }
    }
    if (admission !== undefined && admission.seq !== this.current?.userSeq) {
      this.player.stop()
      this.steps.clear()
      const limits = this.capabilities?.streaming ? this.capabilities.limits : undefined
      if (limits === undefined) { this.current = undefined; this.notice('failed'); return }
      this.current = { requestId: admission.requestId, turn: admission.turn, userSeq: admission.seq, minStep: admission.minStep,
        started: false, finished: false, muted: false, bytes: 0, limits, step: null, attempt: null }
      this.player.begin(limits, (diagnostic) => { this.mute('failed', diagnostic) })
    }
    const current = this.current
    if (current === undefined || current.muted || current.finished) return
    if (this.restricted) {
      for (const number of snapshot.timeline.turnOrder) {
        if (number < current.turn) continue
        const users = [...snapshot.nodes.turnDataSource(number, 'user').getSnapshot(), ...snapshot.nodes.turnDataSource(number, 'steering').getSnapshot()]
        if (users.some(user => user.seq > current.userSeq)) { this.mute(); return }
      }
    }
    const limits = current.limits
    const turn = snapshot.timeline.turns.get(current.turn)
    if (turn === undefined) return
    for (const step of turn.steps) {
      if (step.step < current.minStep) continue
      const data = step.data.get('assistant-step')
      if (data === undefined) continue
      if (data.status === 'interrupted') { this.mute(); return }
      if (data.attemptSeq === undefined) { this.mute('failed'); return }
      let speech = this.steps.get(step.step)
      if (speech !== undefined && speech.attempt !== data.attemptSeq) { this.mute('retried'); return }
      if (speech === undefined) {
        speech = { attempt: data.attemptSeq, buffers: [], lengths: [], ended: false }
        this.steps.set(step.step, speech)
      }
      if (speech.ended) continue
      const text = data.blocks.filter(block => block.kind === 'text')
      for (let index = 0; index < text.length; index++) {
        const block = text[index]
        if (block === undefined) continue
        const buffer = speech.buffers[index] ??= new StreamingSpeechText()
        const lastLength = speech.lengths[index] ?? 0
        current.bytes += new TextEncoder().encode(block.text.slice(lastLength)).byteLength
        speech.lengths[index] = block.text.length
        if (current.bytes > limits.maxTextBytes) throw new Error('Speech source is too large')
        const update = buffer.update(block.text, data.status === 'settled' || step.status === 'closed' || index < text.length - 1)
        if (update.rewritten) { this.mute('retried'); return }
        for (const part of update.parts) {
          if (!current.started) {
            this.beforePlay()
            current.started = true
          }
          current.step = step.step
          current.attempt = data.attemptSeq
          this.publishPlayback()
          this.player.append(part)
        }
      }
      if (data.status === 'settled' || step.status === 'closed') {
        speech.ended = true
        if (current.started) this.player.boundary()
      }
    }
    if (turn.status === 'closed') {
      const reason = turn.end?.data.reason.kind
      // A visible answer can still be useful when a reasoning-heavy provider
      // reaches its output cap; keep hard failures and interruptions silent.
      if (this.restricted && reason !== 'completed' && !(reason === 'max-tokens' && current.started)) {
        this.mute('failed'); return
      }
      current.finished = true
      this.player.finish()
      this.settlePlayback()
    }
  }

  /** Admit one native submission without enabling other prompts.
   * @param requestId - identity already registered with the Session.
   */
  authorize(requestId: VoiceRequestId): void {
    if (!this.restricted || !this.state.getSnapshot().enabled) throw new Error('Voice output is not armed')
    this.requests.add(requestId)
    this.replies.set({ requestId, outcome: 'pending' })
  }

  private publishPlayback(): void {
    const current = this.current
    this.playback.set(current === undefined ? null : { ...this.player.state.getSnapshot(), requestId: current.requestId,
      userSeq: current.userSeq, step: current.step, attempt: current.attempt })
  }

  /** Pause only an admitted reply; later first audio remains gated.
   * @param requestId - native submission identity.
   * @param reason - independent pause owner.
   * @returns a request-bound permission, or null after replacement/failure.
   */
  async pause(requestId: VoiceRequestId, reason: VoicePauseReason): Promise<VoicePause | null> {
    const current = this.current
    if (current?.requestId !== requestId || current.muted || !this.state.getSnapshot().enabled) return null
    const hold = await this.player.pause(reason)
    return hold === null || this.current !== current ? null : { ...hold, requestId }
  }

  /** Release only this reply's matching permission.
   * @param pause - permission returned by pause().
   * @returns false for obsolete replies or permissions.
   */
  async resume(pause: VoicePause): Promise<boolean> {
    if (this.current?.requestId !== pause.requestId) return false
    return this.player.resume(pause)
  }

  /** Stop a matching reply without cancelling its native text turn.
   * @param pause - unreleased pause permission.
   * @returns whether the matching audio was stopped.
   */
  confirmStop(pause: VoicePause): boolean {
    if (this.current?.requestId !== pause.requestId || !this.player.confirmStop(pause)) return false
    this.mute()
    return true
  }

  /** Toggle a user-owned pause from the foreground control.
   * @param session - current composer identity.
   * @returns after audio transition settles; failures use the existing speech notice.
   */
  async togglePause(session: SessionId): Promise<void> {
    const current = this.current
    if (this.state.getSnapshot().session !== session || current === undefined) return
    const paused = this.player.state.getSnapshot()
    const hold = await this.pause(current.requestId, 'user')
    if (hold !== null && (paused.userPaused || paused.systemPaused)) await this.resume(hold)
  }

  /** A manual read revokes continuous ownership instead of leaving automatic input armed. */
  interrupt(): void { if (this.restricted) this.disable(); else this.mute() }

  private settlePlayback(): void {
    const current = this.current
    if (!current || current.muted || !current.finished) return
    const playback = this.player.state.getSnapshot()
    if (playback.outcome === 'done') this.replies.set({ requestId: current.requestId, outcome: 'done' })
  }

  /** Stop this reply without disabling future locally initiated replies.
   * @param notice - optional localized reason for a non-user stop.
   * @param diagnostic - sanitized failure observations retained with the notice.
   */
  mute(notice?: 'failed' | 'retried', diagnostic?: SpeechDiagnostic): void {
    const reply = this.replies.getSnapshot()
    if (reply?.outcome === 'pending') this.replies.set({ ...reply, outcome: notice ?? 'stopped' })
    if (this.current !== undefined) this.current.muted = true
    this.player.stop()
    if (notice !== undefined) this.notice(notice, diagnostic)
  }

  /** Stop an active mode when a newly mounted composer owns another Session.
   * @param sessionId - Session that remains current in the visible composer.
   */
  ensureSession(sessionId: SessionId): void {
    const current = this.state.getSnapshot().session
    if (current !== null && current !== sessionId) this.disable()
  }

  /** Clear mode synchronously, then join owned audio cleanup at disposal. */
  disable(): void {
    const reply = this.replies.getSnapshot()
    if (reply?.outcome === 'pending') this.replies.set({ ...reply, outcome: 'stopped' })
    this.activation++
    this.player.stop()
    for (const off of this.observers.splice(0)) off()
    this.requests.clear(); this.existing.clear(); this.steps.clear(); this.current = undefined
    this.publishPlayback()
    this.state.set({ ...this.state.getSnapshot(), session: null, enabled: false, busy: false })
    const generation = this.activation
    const release = this.player.release().catch((error: unknown) => {
      if (!this.disposed && generation === this.activation) this.notice('failed', speechDiagnostic(error, 'playback'))
    })
    this.releases.add(release)
    void release.finally(() => { this.releases.delete(release) })
  }

  /** Join audio releases already requested by disable(), without stopping a later playback batch.
   * @returns after the captured release operations have settled.
   */
  async settleStop(): Promise<void> { await Promise.allSettled([...this.releases]) }

  private notice(kind: 'failed' | 'retried', diagnostic?: SpeechDiagnostic): void {
    if (!this.disposed) this.state.set({ ...this.state.getSnapshot(),
      notice: { kind, sequence: ++this.noticeSequence, diagnostic: diagnostic ?? null } })
    if (diagnostic !== undefined) console.warn('Speech stopped:', diagnostic)
  }

  /** Dismiss only the outcome still being shown.
   * @param sequence - rendered outcome identity.
   */
  dismiss(sequence: number): void {
    if (this.state.getSnapshot().notice?.sequence === sequence) this.state.set({ ...this.state.getSnapshot(), notice: null })
  }

  /** Stop all observations and wait for audio and physical streams to be released. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.refreshGeneration++
    this.disable()
    this.offPlayback()
    await Promise.allSettled(this.releases)
  }
}
