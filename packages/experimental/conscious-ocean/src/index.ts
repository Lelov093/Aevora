/** Experimental Conscious Ocean contracts, providers, and conservative Session mapping. */

import type { Context } from '@deepseek-ai/cordis'
import { consciousOceanSessionProjectionDefinition } from './projection.ts'
import './session-events.ts'
import { installActivationTraceProducer } from './trace-producer.ts'
import type { ActivationTraceProducerOptions } from './trace-producer.ts'

export type * from './types.ts'
export type * from './provider.ts'
export type * from './projection.ts'
export type * from './scene-projection.ts'
export type * from './session-events.ts'
export type * from './session-scene-loader.ts'
export type * from './activation.ts'
export type * from './context-attachment.ts'
export type * from './context-compiler.ts'
export { buildMemoryCognitiveWorld } from './memory-world.ts'
export type * from './trace-producer.ts'
export type {
  ConfirmedMemoryInput, MemoryAdmissionState, MemoryDeletionState, MemoryEpistemicState, MemoryEvidence,
  MemoryItem, MemoryKind, MemoryProvider, MemoryQuery, MemoryRecallState, MemoryScope,
  MemoryStorageTier, MemoryUpdate, MemoryValidityState,
} from '@deepseek-ai/dsh-experimental-memory'
export { MemoryId } from '@deepseek-ai/dsh-experimental-memory'
export { ActivationRequestId, ActivationTraceId, CognitiveSourceId, ContextManifestId } from './types.ts'
export { mapSessionEvent } from './session-event-mapping.ts'
export { loadSessionSceneProjection } from './session-scene-loader.ts'
export type { SessionEventCategory, SessionEventMapping } from './session-event-mapping.ts'
export { consciousOceanSessionProjectionDefinition, consciousOceanSessionProjectionView } from './projection.ts'
export { createCognitiveWorldProvider, createSceneProjectionOwner, createSessionProjectionProvider, createSessionSceneProjectionOwner, createTraceProjectionProvider } from './provider.ts'
export { buildOceanSceneProjection } from './scene-projection.ts'
export { prepareDeterministicMemoryActivation, memorySourceId } from './activation.ts'
export { createContextManifestAttachment } from './context-attachment.ts'
export { compileContextManifest } from './context-compiler.ts'
export { installActivationTraceProducer } from './trace-producer.ts'
export { activationTraceSchema, contextFragmentSchema, contextManifestSchema } from './schema.ts'

/** Projection registry dependency for the read-only Session view. */
export const inject = ['sessionProjections']

/** Optional Host dependency for the request-lifecycle Trace Producer. */
export const traceProducerInject = ['memory']

/**
 * Register the read-only Session Projection; no Memory or activation producer is mounted.
 * @param ctx - Host context carrying the Session Projection registry.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.sessionProjections.register(consciousOceanSessionProjectionDefinition)
}

/** Mount the optional Trace Producer when the confirmed Memory service is present. */
export function applyTraceProducer(ctx: Context, options: ActivationTraceProducerOptions = {}): void {
  ctx.effect(() => installActivationTraceProducer(ctx, ctx.memory, options), 'conscious-ocean: trace producer')
}
