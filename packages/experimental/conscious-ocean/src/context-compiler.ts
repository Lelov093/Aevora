/** Deterministic Context Manifest compiler for confirmed Memory candidates. */

import type { MemoryItem } from '@deepseek-ai/dsh-experimental-memory'
import type { SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type {
  ActivationTraceId, CognitiveSourceId, ContextManifest, ContextManifestId,
} from './types.ts'

/** One selected candidate passed from Activation to the Compiler. */
export interface ContextCompilerCandidate {
  readonly item: MemoryItem
  readonly sourceId: CognitiveSourceId
  readonly estimatedTokens: number
}

/** One omitted candidate passed from Activation to the Compiler. */
export interface ContextCompilerOmission {
  readonly sourceId: CognitiveSourceId
  readonly reasonCode: string
  readonly estimatedTokens?: number
}

/** Inputs owned by the request-scoped Context Compiler. */
export interface ContextCompilerInput {
  readonly manifestId: ContextManifestId
  readonly traceId: ActivationTraceId
  readonly sessionId: SessionId
  readonly sessionWatermark: SessionSeqCursor
  readonly policyVersion: string
  readonly compilerVersion: string
  readonly budgetTokens: number
  readonly selected: readonly ContextCompilerCandidate[]
  readonly omitted: readonly ContextCompilerOmission[]
}

/**
 * Compile selected Memory records into a stable ordered Manifest.
 *
 * The compiler does not select candidates or change their epistemic state. It
 * only emits ordered fragments, source revisions, source event references and
 * explicit omission reasons for the already-decided request.
 *
 * @param input - request identity, policy versions and selected candidates.
 * @returns a prepared Context Manifest with deterministic fragments and omissions.
 */
export function compileContextManifest(input: ContextCompilerInput): ContextManifest {
  const fragments = input.selected.map((candidate, index) => ({
    fragmentId: `${String(input.manifestId)}:${index + 1}`,
    order: index + 1,
    sourceRefs: [candidate.sourceId],
    sourceRevision: candidate.item.revision,
    targetSection: 'runtime-context',
    estimatedTokens: candidate.estimatedTokens,
    compiled: true,
    contentEvidence: 'derived' as const,
    attached: 'no' as const,
    submitted: 'unknown' as const,
    ...(candidate.item.sourceEvidence.flatMap(evidence => evidence.eventSeq === undefined ? [] : [evidence.eventSeq]).length === 0
      ? {}
      : { sourceEventSeqs: candidate.item.sourceEvidence.flatMap(evidence => evidence.eventSeq === undefined ? [] : [evidence.eventSeq]) }),
  }))
  return {
    manifestId: input.manifestId,
    traceId: input.traceId,
    sessionId: input.sessionId,
    sessionWatermark: input.sessionWatermark,
    policyVersion: input.policyVersion,
    compilerVersion: input.compilerVersion,
    budgetTokens: input.budgetTokens,
    status: 'prepared',
    fragments,
    omissions: input.omitted.map(omission => ({
      sourceRefs: [omission.sourceId],
      reasonCode: omission.reasonCode,
      ...(omission.estimatedTokens === undefined ? {} : { estimatedTokens: omission.estimatedTokens }),
    })),
  }
}
