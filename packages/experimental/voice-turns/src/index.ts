/** Optional local voice activity and endpoint inference, scoped to one authenticated Session stream. */
import { access } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { Config } from './config.ts'
import { ModelWorker } from './worker.ts'
import { TurnDetector, type TurnModels } from './detector.ts'
import type { TurnCommand, TurnFrame, TurnReadiness } from './types.ts'
import { VoiceConversation } from './conversation.ts'
import type { PlaybackObservation, InterruptionRequest, InterruptionResult } from './conversation-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Local experimental voice activity and endpoint provider. */
    voiceTurns: VoiceTurns
  }
}

const activitySchema = z.object({ speaking: z.boolean(), ended: z.boolean() }).strict()
const probabilitySchema = z.object({ probability: z.number().min(0).max(1) }).strict()

type ResourcePaths = Record<'pythonPath' | 'modelPath' | 'vadModelPath', string>
type ModeOwner = { controller: AbortController; peer: string; conversation: VoiceConversation | undefined }

async function receive<T>(pending: Promise<IteratorResult<T>>, signal: AbortSignal, timeoutMs: number): Promise<IteratorResult<T>> {
  signal.throwIfAborted()
  const stopped = Promise.withResolvers<never>()
  const abort = (): void => { stopped.reject(signal.reason) }
  const timer = setTimeout(() => { stopped.reject(new Error('Voice mode input timed out')) }, timeoutMs)
  signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([pending, stopped.promise]) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}

/** One owner per Session; disconnect releases both model processes and never restarts them. */
export default class VoiceTurns extends TypertRemoteService {
  static inject = ['typert', 'subprocess']
  static Config = Config
  private readonly owners = new Map<SessionId, ModeOwner>()
  private readonly operations = new Set<Promise<void>>()
  private conversation: VoiceConversation | undefined

  /** @param ctx - native Remote and subprocess lifetime. @param config - offline resources and inference limits. */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'voiceTurns', { namespace: 'voiceTurns' })
    ctx.inject(['agents', 'sessionProjections', 'llm'], async (scope) => {
      const conversation = new VoiceConversation(scope, config)
      scope.effect(() => async () => {
        if (this.conversation === conversation) this.conversation = undefined
        await conversation.dispose()
      }, 'voice-turns: conversation')
      if (await conversation.initialize()) this.conversation = conversation
    })
    const paths = this.resourcePaths()
    for (const path of Object.values(paths)) {
      if (path && !isAbsolute(path)) throw new Error('Voice turn resource paths must be absolute')
    }
    if (paths.modelPath && basename(paths.modelPath) !== 'smart-turn-v3.1-cpu.onnx') throw new Error('This provider requires the Smart Turn v3.1 CPU weights matching its reference preprocessing')
    ctx.effect(() => async () => {
      for (const owner of this.owners.values()) owner.controller.abort()
      await Promise.allSettled(this.operations)
    }, 'voice-turns: model processes')
  }

  private resourcePaths(): ResourcePaths {
    return { pythonPath: this.config.pythonPath.get(), modelPath: this.config.modelPath.get(),
      vadModelPath: this.config.vadModelPath.get() }
  }

  private async inspectResources(resources: ResourcePaths, parallel: boolean): Promise<TurnReadiness> {
    const paths = Object.values(resources)
    const configured = paths.every(path => path.length > 0)
    const results = configured ? await Promise.allSettled(paths.map(path => access(path))) : []
    return { configured, filesPresent: configured && results.every(result => result.status === 'fulfilled'),
      model: 'smart-turn-v3.1-reference', parallel, maxRecognitionTasks: this.config.maxRecognitionTasks }
  }

  private modeConversation(parallel: boolean): VoiceConversation | undefined {
    if (!parallel) return undefined
    if (!this.conversation) throw new RemoteError('voice-turns/conversation-unavailable',
      'Parallel voice requires native Session, Projection and LLM services', { reason: 'disabled' })
    return this.conversation
  }

  /** Inspect configured files without running Python, loading weights or downloading.
   * @returns file presence separately from successful runtime loading.
   */
  @Remote
  async readiness(): Promise<TurnReadiness> {
    const parallel = this.config.parallel.get()
    this.modeConversation(parallel)
    return this.inspectResources(this.resourcePaths(), parallel)
  }

  /** Persist an ordered phase observation from the authenticated output consumer.
   * @param sessionId - authorized Session.
   * @param observation - Client-reported samples and lifecycle.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  observePlayback(sessionId: SessionId, observation: PlaybackObservation): void {
    if (!this.conversation || !this.ctx.invocation) throw new RemoteError('voice-turns/conversation-unavailable',
      'Parallel voice is unavailable', { reason: 'disabled' })
    const owner = this.owners.get(sessionId)
    if (owner ? owner.peer !== this.ctx.invocation.peer.id || owner.conversation !== this.conversation : observation.outcome === null) {
      throw new RemoteError('voice-turns/conversation-unavailable', 'Voice output owner changed', { reason: 'changed' })
    }
    this.conversation.observe(sessionId, observation, this.ctx.invocation.peer.id, owner !== undefined)
  }

  /** Classify one candidate through the configured native model; the input and result are logged.
   * @param sessionId - authorized Session.
   * @param request - immutable candidate revision.
   * @param signal - authenticated caller lifetime.
   * @returns label and observed usage; no Session prompt is submitted.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async evaluateInterruption(sessionId: SessionId, request: InterruptionRequest, signal: AbortSignal): Promise<InterruptionResult> {
    const owner = this.owners.get(sessionId)
    if (!owner?.conversation || owner.conversation !== this.conversation || !this.ctx.invocation) throw new RemoteError('voice-turns/conversation-unavailable',
      'Parallel voice is unavailable', { reason: 'disabled' })
    if (owner.peer !== this.ctx.invocation.peer.id) {
      throw new RemoteError('voice-turns/conversation-unavailable', 'Voice input owner changed', { reason: 'changed' })
    }
    return owner.conversation.evaluate(sessionId, request, this.ctx.invocation.peer.id, signal)
  }

  /** Own one foreground mode with pinned resources and pause timing, without locking ordinary text submissions.
   * @param sessionId - authorized native Session identity.
   * @param signal - authenticated stream lifetime.
   * @returns ordered local VAD and endpoint observations; no ASR, Agent or synthesis call.
   */
  @Remote({ mode: 'stream', resources: { session: (sessionId: SessionId) => sessionId } })
  async *listen(sessionId: SessionId, signal: AbortSignal): RemoteStream<TurnFrame, TurnCommand> {
    if (this.owners.has(sessionId)) throw new RemoteError('voice-turns/unavailable', 'Continuous voice is already active for this session', { reason: 'busy', phase: 'preparation' })
    const paths = this.resourcePaths()
    const silenceSeconds = this.config.silenceSeconds.get()
    const parallel = this.config.parallel.get()
    if (!(await this.inspectResources(paths, parallel)).filesPresent) throw new RemoteError('voice-turns/unavailable', 'Prepare local voice turn resources before starting', { reason: 'unprepared', phase: 'preparation' })
    signal.throwIfAborted()
    if (this.owners.has(sessionId)) throw new RemoteError('voice-turns/unavailable', 'Continuous voice is already active for this session', { reason: 'busy', phase: 'preparation' })
    const conversation = this.modeConversation(parallel)
    const owner = new AbortController(), lifetime = AbortSignal.any([signal, owner.signal])
    const invocation = this.ctx.invocation
    if (!invocation) throw new Error('Voice mode requires an invocation')
    const ownership = { controller: owner, peer: invocation.peer.id, conversation }
    this.owners.set(sessionId, ownership)
    conversation?.open(sessionId)
    const settled = Promise.withResolvers<void>(); this.operations.add(settled.promise)
    const workers: ModelWorker[] = []
    let detector: TurnDetector | undefined
    const frames: TurnFrame[] = []
    let wake = Promise.withResolvers<void>(), error: unknown, ended = false
    const emit = (frame: TurnFrame): void => {
      if (frames.length >= Math.ceil(this.config.maxPendingSamples / this.config.maxFrameSamples) + 8) {
        fail(new Error('Voice observation buffer exceeded its limit')); return
      }
      frames.push(frame); wake.resolve()
    }
    const fail = (failure: unknown): void => { error = failure; owner.abort(failure); wake.resolve() }
    const aborted = (): void => { wake.resolve() }
    lifetime.addEventListener('abort', aborted, { once: true })
    let consuming: Promise<void> | undefined
    try {
      const vadConfig = { vadModelPath: paths.vadModelPath, vadThreshold: this.config.vadThreshold,
        silenceSeconds, minSpeechSeconds: this.config.minSpeechSeconds, threads: this.config.threads }
      const vad = new ModelWorker(this.ctx, [process.execPath, fileURLToPath(new URL('../runtime/vad.mjs', import.meta.url)), JSON.stringify(vadConfig)], this.config, lifetime)
      workers.push(vad)
      const endpoint = new ModelWorker(this.ctx, [paths.pythonPath, '-I', fileURLToPath(new URL('../runtime/smart_turn.py', import.meta.url)), paths.modelPath, String(this.config.threads)], this.config, lifetime)
      workers.push(endpoint)
      try { await Promise.all(workers.map(worker => worker.start(lifetime))) }
      catch (_startupFailure) { throw new RemoteError('voice-turns/unavailable', 'Local voice models could not start; check the prepared environment and matching weights', { reason: 'runtime', phase: 'startup' }) }
      const models: TurnModels = {
        vad: async pcm => activitySchema.parse(await vad.request({ kind: 'audio', audioBase64: Buffer.from(pcm).toString('base64') }, lifetime)),
        endpoint: async pcm => probabilitySchema.parse(await endpoint.request({ audioBase64: Buffer.from(pcm).toString('base64') }, lifetime)).probability,
        flush: async () => activitySchema.parse(await vad.request({ kind: 'flush' }, lifetime)).speaking,
        reset: async () => { activitySchema.parse(await vad.request({ kind: 'reset' }, lifetime)) },
      }
      detector = new TurnDetector(models, { threshold: this.config.threshold, silenceSeconds }, emit, fail)
      const active = detector
      consuming = (async () => {
        try {
          const iterator = invocation.uplink<TurnCommand>()[Symbol.asyncIterator]()
          while (true) {
            const item = await receive(iterator.next(), lifetime, this.config.idleTimeoutMs)
            if (item.done) break
            const command = item.value
            lifetime.throwIfAborted()
            if (command.kind === 'reset') { await active.reset(); emit({ kind: 'reset' }); continue }
            if (command.kind === 'review') {
              z.uuid().parse(command.reviewId)
              emit({ kind: 'reviewed', reviewId: command.reviewId, samples: command.samples, ready: await active.review(command.reviewId, command.samples) }); continue
            }
            if (command.kind === 'seal') {
              if (!command.explicit && command.reviewId === undefined) throw new Error('Automatic seal requires a review identity')
              if (command.reviewId !== undefined) z.uuid().parse(command.reviewId)
              emit({ kind: 'sealed', ...(command.reviewId === undefined ? {} : { reviewId: command.reviewId }),
                samples: command.samples, valid: await active.seal(command.samples, command.explicit, command.reviewId) }); continue
            }
            if (command.kind === 'commit') {
              z.uuid().parse(command.reviewId)
              emit({ kind: 'committed', reviewId: command.reviewId, samples: command.samples, coveredSamples: command.coveredSamples,
                valid: await active.commit(command.reviewId, command.samples, command.coveredSamples) }); continue
            }
            const pcm = Buffer.from(command.audioBase64, 'base64')
            if (!Number.isSafeInteger(command.startSample) || command.startSample < 0 || !pcm.length || pcm.length % 2
              || pcm.length > this.config.maxFrameSamples * 2 || pcm.toString('base64') !== command.audioBase64) throw new Error('Invalid voice PCM frame')
            await active.accept(pcm, command.startSample)
          }
          ended = true; wake.resolve()
        } catch (failure) { fail(failure) }
      })()
      yield { kind: 'ready', parallel, maxFrameSamples: this.config.maxFrameSamples, maxPendingSamples: this.config.maxPendingSamples }
      while (!ended) {
        if (error !== undefined) throw new RemoteError('voice-turns/unavailable', 'Local voice turn inference stopped; resume explicitly after checking resources', { reason: 'runtime', phase: 'inference' })
        lifetime.throwIfAborted()
        const frame = frames.shift()
        if (frame) { yield frame; continue }
        await wake.promise; wake = Promise.withResolvers<void>()
      }
    } finally {
      owner.abort()
      await Promise.allSettled(workers.map(worker => worker.dispose()))
      await detector?.dispose()
      await consuming
      lifetime.removeEventListener('abort', aborted)
      if (this.owners.get(sessionId) === ownership) { this.owners.delete(sessionId); conversation?.close(sessionId) }
      this.operations.delete(settled.promise); settled.resolve()
    }
  }
}
