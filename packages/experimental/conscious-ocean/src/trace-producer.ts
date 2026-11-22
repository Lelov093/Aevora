/** Optional Host Trace Producer bound to the real AgentLoop lifecycle. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import type { MemoryProvider, MemoryScope } from '@deepseek-ai/dsh-experimental-memory'
import { prepareDeterministicMemoryActivation } from './activation.ts'
import type { MemoryAccessibilityPolicy } from './activation.ts'
import { createContextManifestAttachment } from './context-attachment.ts'
import type {
  CognitionRequestAttempt, CognitionRequestSubmittedEvent, CognitionTraceEndEvent, CognitionTraceStartEvent,
} from './session-events.ts'
import { ActivationRequestId, ActivationTraceId } from './types.ts'
import type { ActivationTraceEvent, ActivationTraceStatus, ContextManifest } from './types.ts'

/** Configuration for the optional request-lifecycle producer. */
export interface ActivationTraceProducerOptions {
  /** Candidate budget used by the deterministic confirmed-Memory baseline. */
  readonly budgetTokens?: number
  /** Memory scope resolved for each Agent. */
  readonly scopeOf?: (agent: Agent) => MemoryScope
  /** Minimum read-time recall accessibility accepted by deterministic activation. */
  readonly minimumRecallability?: number
  /** Stable policy identifier stored in the trace batch. */
  readonly policyVersion?: string
  /** Stable compiler identifier stored in the prepared Manifest. */
  readonly compilerVersion?: string
  /** Deterministic clock used by keyless tests and replay fixtures. */
  readonly now?: () => number
  /** Optional explicit accessibility recipe for Context Activation. */
  readonly accessibilityPolicy?: MemoryAccessibilityPolicy
  /** Opt in to AgentLoop admission of selected Memory as a model-visible message. */
  readonly attachPreparedManifest?: boolean
}

interface ActiveTrace {
  readonly session: Session
  readonly traceId: ReturnType<typeof ActivationTraceId>
  readonly requestId: ReturnType<typeof ActivationRequestId>
  readonly turn: number
  readonly step: number
  manifest: ContextManifest
  pendingAttachedManifest: ContextManifest | undefined
  readonly coverage: {
    readonly sourceSnapshot: 'complete' | 'partial' | 'not_instrumented' | 'unavailable'
    readonly candidateDecisions: 'complete' | 'partial' | 'not_instrumented' | 'unavailable'
    readonly finalContext: 'complete' | 'partial' | 'not_instrumented' | 'unavailable'
  }
  readonly startEvent: CognitionTraceStartEvent
  requestHeaderSeq?: SessionSeqType
  readonly contextEventSeqs: SessionSeqType[]
  readonly requestAttempts: RequestAttemptState[]
  assistantEventSeq?: SessionSeqType
  assistantInterrupted?: boolean
  attemptEventSeq?: SessionSeqType
  readonly attemptEventSeqs: SessionSeqType[]
}

interface RequestAttemptState extends CognitionRequestAttempt {
  settlementEventSeq?: SessionSeqType
  settlementType?: 'assistant/message' | 'assistant/attempt'
}

const DEFAULT_BUDGET_TOKENS = 1800
const DEFAULT_SCOPE: MemoryScope = { kind: 'user' }
const installedProducers = new WeakMap<Context, () => void>()

function traceKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function sessionWatermark(session: Session): -1 | SessionSeqType {
  return session.seq === 0 ? -1 : SessionSeq(Number(session.seq) - 1)
}

function statusForStep(active: ActiveTrace): ActivationTraceStatus {
  if (active.assistantInterrupted === true) return 'cancelled'
  if (active.assistantEventSeq !== undefined) return 'completed'
  if (active.attemptEventSeq !== undefined) return 'failed'
  return 'unknown'
}

function appendEvent(ctx: Context, session: Session, type: 'cognition/trace-start', data: CognitionTraceStartEvent): void
function appendEvent(ctx: Context, session: Session, type: 'cognition/trace-end', data: CognitionTraceEndEvent): void
function appendEvent(ctx: Context, session: Session, type: 'cognition/trace-start' | 'cognition/trace-end', data: CognitionTraceStartEvent | CognitionTraceEndEvent): void {
  try {
    session.append(type, data)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`conscious-ocean trace event ${type} could not be recorded: ${message}`)
  }
}

function appendBatch(ctx: Context, session: Session, active: ActiveTrace, events: readonly ActivationTraceEvent[]): void {
  try {
    session.append('cognition/activation-batch', {
      traceId: active.traceId,
      requestId: active.requestId,
      batchSeq: 1,
      sessionWatermark: active.startEvent.sessionWatermark,
      events,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`conscious-ocean activation batch could not be recorded: ${message}`)
  }
}

function appendRequestSubmitted(
  ctx: Context,
  session: Session,
  data: CognitionRequestSubmittedEvent,
): SessionSeqType | undefined {
  try {
    return session.append('cognition/request-submitted', data).seq
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`conscious-ocean request submission event could not be recorded: ${message}`)
    return undefined
  }
}

function markManifestSubmitted(manifest: ContextManifest): ContextManifest {
  return {
    ...manifest,
    status: 'submitted',
    fragments: manifest.fragments.map(fragment => ({ ...fragment, submitted: 'yes' as const })),
  }
}

/**
 * Install a trace producer without changing AgentLoop message admission or Compaction.
 *
 * The producer observes `agent/pre-step`, durable request headers, assistant settlements,
 * and `step/end`. It records deterministic Memory preparation. When
 * `attachPreparedManifest` is enabled, the existing AgentLoop admission path receives
 * the prepared context message and remains the owner of persistence and request assembly.
 *
 * @param ctx - Host context that owns the lifecycle listeners.
 * @param memory - confirmed Memory provider used for candidate preparation.
 * @param options - deterministic policy, scope, and optional accessibility settings.
 * @returns an idempotent disposer; repeated installation on one Context returns the same producer.
 */
export function installActivationTraceProducer(
  ctx: Context,
  memory: MemoryProvider,
  options: ActivationTraceProducerOptions = {},
): () => void {
  const existing = installedProducers.get(ctx)
  if (existing !== undefined) return existing
  const activeBySession = new WeakMap<Session, Map<string, ActiveTrace>>()
  const sessionsById = new Map<string, Session>()
  const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS
  const scopeOf = options.scopeOf ?? (() => DEFAULT_SCOPE)
  const current = (session: Session, turn: number, step: number): ActiveTrace | undefined => (
    activeBySession.get(session)?.get(traceKey(turn, step))
  )
  const byTrace = (session: Session, traceId: string): ActiveTrace | undefined => (
    [...(activeBySession.get(session)?.values() ?? [])].find(active => String(active.traceId) === traceId)
  )
  const put = (active: ActiveTrace): void => {
    const traces = activeBySession.get(active.session) ?? new Map<string, ActiveTrace>()
    traces.set(traceKey(active.turn, active.step), active)
    activeBySession.set(active.session, traces)
    sessionsById.set(String(active.session.id), active.session)
  }
  const remove = (active: ActiveTrace): void => {
    const traces = activeBySession.get(active.session)
    traces?.delete(traceKey(active.turn, active.step))
    if (traces?.size === 0) sessionsById.delete(String(active.session.id))
  }
  const finish = (active: ActiveTrace, status: ActivationTraceStatus): void => {
    remove(active)
    appendEvent(ctx, active.session, 'cognition/trace-end', {
      traceId: active.traceId,
      requestId: active.requestId,
      status,
      sessionWatermark: sessionWatermark(active.session),
      coverage: { ...active.coverage, finalContext: status === 'rejected_before_dispatch' ? 'unavailable' : active.coverage.finalContext },
      manifest: active.manifest,
      ...(active.requestHeaderSeq === undefined ? {} : { requestHeaderSeq: active.requestHeaderSeq }),
      ...(active.contextEventSeqs.length === 0 ? {} : { contextEventSeqs: [...active.contextEventSeqs] }),
      ...(active.requestAttempts.length === 0 ? {} : { requestAttempts: active.requestAttempts.map(attempt => ({ ...attempt })) }),
      ...(active.assistantEventSeq === undefined ? {} : { assistantEventSeq: active.assistantEventSeq }),
      ...(active.attemptEventSeq === undefined ? {} : { attemptEventSeq: active.attemptEventSeq }),
      ...(active.attemptEventSeqs.length === 0 ? {} : { attemptEventSeqs: [...active.attemptEventSeqs] }),
      attemptCount: active.attemptEventSeqs.length + (active.assistantEventSeq === undefined ? 0 : 1),
    })
  }
  const stopPreStep = ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    if (signal.aborted) return next()
    const requestId = ActivationRequestId(`request:${String(agent.session.id)}:${turn}:${step}`)
    const prepared = prepareDeterministicMemoryActivation(memory, {
      sessionId: agent.session.id,
      requestId: String(requestId),
      agentScope: String(agent.id),
      turn,
      step,
      attempt: 1,
      sessionWatermark: sessionWatermark(agent.session),
      scope: scopeOf(agent),
      budgetTokens,
      ...(options.minimumRecallability === undefined ? {} : { minimumRecallability: options.minimumRecallability }),
      ...(options.policyVersion === undefined ? {} : { policyVersion: options.policyVersion }),
      ...(options.compilerVersion === undefined ? {} : { compilerVersion: options.compilerVersion }),
      ...(options.now === undefined ? {} : { now: options.now() }),
      ...(options.accessibilityPolicy === undefined ? {} : { accessibilityPolicy: options.accessibilityPolicy }),
    })
    const startEvent: CognitionTraceStartEvent = {
      traceId: prepared.trace.traceId,
      requestId,
      sessionId: agent.session.id,
      agentScope: String(agent.id),
      turn,
      step,
      attempt: 1,
      requestKind: 'main',
      policyVersion: prepared.trace.policyVersion,
      compilerVersion: prepared.trace.compilerVersion,
      sessionWatermark: sessionWatermark(agent.session),
    }
    const active: ActiveTrace = {
      session: agent.session,
      traceId: prepared.trace.traceId,
      requestId,
      turn,
      step,
      manifest: prepared.manifest,
      pendingAttachedManifest: undefined,
      coverage: prepared.trace.coverage,
      startEvent,
      contextEventSeqs: [],
      requestAttempts: [],
      attemptEventSeqs: [],
    }
    put(active)
    appendEvent(ctx, agent.session, 'cognition/trace-start', startEvent)
    signal.addEventListener('abort', () => {
      queueMicrotask(() => {
        const live = current(agent.session, turn, step)
        if (live !== undefined && live.requestAttempts.length === 0) finish(live, 'cancelled')
      })
    }, { once: true })
    try {
      appendBatch(ctx, agent.session, active, prepared.trace.events)
      const attachment = options.attachPreparedManifest === true
        ? createContextManifestAttachment(prepared)
        : undefined
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
        finish(active, 'rejected_before_dispatch')
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- cancellation can race with the downstream waterfall.
      } else if (attachment !== undefined && !signal.aborted) {
        active.pendingAttachedManifest = attachment.manifest
        return { ...decision, messages: [...decision.messages, attachment.message] }
      }
      return decision
    } catch (error: unknown) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- cancellation can race while downstream pre-step listeners await.
      finish(active, signal.aborted ? 'cancelled' : 'failed')
      throw error
    }
  })
  const stopSession = ctx.on('session/event', (session, event) => {
    if (event.type === 'request/header') {
      const active = latestActive(session, activeBySession)
      if (active !== undefined) active.requestHeaderSeq = event.seq
      return
    }
    if (event.type === 'assistant/message') {
      const active = current(session, event.data.turn, event.data.step)
      if (active !== undefined) {
        active.assistantEventSeq = event.seq
        active.assistantInterrupted = event.data.interrupted === true
        settleRequestAttempt(active, event.seq, 'assistant/message')
      }
      return
    }
    if (event.type === 'user/message' && event.data.source.kind === 'conscious-ocean-context') {
      const active = byTrace(session, String(event.data.source.traceId))
      if (active !== undefined) {
        active.contextEventSeqs.push(event.seq)
        if (active.pendingAttachedManifest !== undefined) {
          active.manifest = active.pendingAttachedManifest
          active.pendingAttachedManifest = undefined
        }
      }
      return
    }
    if (event.type === 'assistant/attempt') {
      const active = current(session, event.data.turn, event.data.step)
      if (active !== undefined) {
        active.attemptEventSeq = event.seq
        active.attemptEventSeqs.push(event.seq)
        settleRequestAttempt(active, event.seq, 'assistant/attempt')
      }
      return
    }
    if (event.type === 'step/end') {
      queueMicrotask(() => {
        const active = current(session, event.data.turn, event.data.step)
        if (active !== undefined) finish(active, statusForStep(active))
      })
    }
  })
  const stopStream = ctx.on('llm/stream', (request: GenerateOptions, next) => {
    if (!isAgentLoopRequest(request) || request.sessionId === undefined) return next()
    const session = sessionsById.get(String(request.sessionId))
    if (session === undefined) return next()
    const active = activeForRequest(session, request, activeBySession)
    if (active === undefined) return next()
    const requestAttempt = active.requestAttempts.length + 1
    const submissionSeq = appendRequestSubmitted(ctx, session, {
      traceId: active.traceId,
      requestId: active.requestId,
      sessionId: session.id,
      agentScope: active.startEvent.agentScope,
      turn: active.turn,
      step: active.step,
      requestAttempt,
      requestKind: active.startEvent.requestKind,
      requestOwner: 'dsh-agent-loop',
      ...(active.requestHeaderSeq === undefined ? {} : { requestHeaderSeq: active.requestHeaderSeq }),
      contextEventSeqs: [...active.contextEventSeqs],
    })
    if (submissionSeq !== undefined) {
      active.requestAttempts.push({ requestAttempt, submissionEventSeq: submissionSeq })
      active.manifest = markManifestSubmitted(active.manifest)
    }
    return next()
  })
  const dispose = (): void => {
    stopPreStep()
    stopSession()
    stopStream()
    if (installedProducers.get(ctx) === dispose) installedProducers.delete(ctx)
  }
  installedProducers.set(ctx, dispose)
  return dispose
}

function settleRequestAttempt(
  active: ActiveTrace,
  settlementEventSeq: SessionSeqType,
  settlementType: 'assistant/message' | 'assistant/attempt',
): void {
  const pending = active.requestAttempts.findLast(attempt => attempt.settlementEventSeq === undefined)
  if (pending === undefined) return
  pending.settlementEventSeq = settlementEventSeq
  pending.settlementType = settlementType
}

function activeForRequest(
  session: Session,
  request: GenerateOptions,
  activeBySession: WeakMap<Session, Map<string, ActiveTrace>>,
): ActiveTrace | undefined {
  const traces = [...(activeBySession.get(session)?.values() ?? [])]
    .sort((left, right) => right.turn - left.turn || right.step - left.step)
  return traces.find(active => request.messages.some(message => (
    message.source?.kind === 'conscious-ocean-context'
      && String(message.source.traceId) === String(active.traceId)
  )))
}

function latestActive(
  session: Session,
  activeBySession: WeakMap<Session, Map<string, ActiveTrace>>,
): ActiveTrace | undefined {
  const values = [...(activeBySession.get(session)?.values() ?? [])]
  return values.sort((left, right) => right.turn - left.turn || right.step - left.step)[0]
}
