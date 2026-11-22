/** Runtime schemas for the frozen Conscious Ocean trace and manifest contracts. */

import { z } from 'zod'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import {
  ActivationRequestId,
  ActivationTraceId,
  CognitiveSourceId,
  ContextManifestId,
} from './types.ts'

const sourceIdSchema = z.string().min(1).transform(CognitiveSourceId)
const traceIdSchema = z.string().min(1).transform(ActivationTraceId)
const requestIdSchema = z.string().min(1).transform(ActivationRequestId)
const sessionIdSchema = z.string().min(1).transform(SessionId)
const sessionSeqSchema = z.number().int().nonnegative().transform(SessionSeq)
const cursorSchema = z.number().int().min(-1).transform(value => value === -1 ? -1 : SessionSeq(value))

/** Validated coverage state for one activation phase. */
export const activationCoverageSchema = z.enum(['complete', 'partial', 'not_instrumented', 'unavailable'])

/** Validated lifecycle state for one Activation Trace. */
export const activationTraceStatusSchema = z.enum([
  'forming', 'prepared', 'submitted', 'completed', 'failed', 'cancelled', 'rejected_before_dispatch', 'unknown',
])

/** Validated redacted event in an Activation Trace. */
export const activationTraceEventSchema = z.object({
  traceId: traceIdSchema,
  eventSeq: z.number().int().positive(),
  time: z.number().int().nonnegative(),
  stage: z.enum([
    'activation.started', 'activation.frame_ready', 'activation.candidates_found',
    'activation.candidate_assessed', 'activation.relation_expanded', 'activation.candidate_filtered',
    'activation.budget_selected', 'activation.compiled', 'activation.validated', 'activation.submitted',
    'activation.completed', 'activation.failed', 'activation.cancelled',
  ]),
  candidateState: z.enum(['discovered', 'denied', 'assessed', 'activated', 'selected', 'omitted', 'compiled', 'attached', 'submitted']).optional(),
  sourceRefs: z.array(sourceIdSchema),
  reasonCode: z.string().min(1).optional(),
  policyVersion: z.string().min(1),
  sessionSeq: sessionSeqSchema.optional(),
  data: z.json().optional(),
}).strict()

/** Validated ordered fragment in a Context Manifest. */
export const contextFragmentSchema = z.object({
  fragmentId: z.string().min(1),
  order: z.number().int().positive(),
  sourceRefs: z.array(sourceIdSchema).min(1),
  sourceRevision: z.number().int().positive(),
  targetSection: z.string().min(1),
  estimatedTokens: z.number().int().nonnegative().optional(),
  actualTokens: z.number().int().nonnegative().optional(),
  compiled: z.boolean(),
  contentEvidence: z.enum(['observed', 'derived', 'unavailable']),
  attached: z.enum(['yes', 'no', 'unknown']),
  submitted: z.enum(['yes', 'no', 'unknown']),
  sourceEventSeqs: z.array(sessionSeqSchema).optional(),
}).strict()

/** Validated candidate omission emitted by the Context Compiler. */
export const contextOmissionSchema = z.object({
  sourceRefs: z.array(sourceIdSchema).min(1),
  reasonCode: z.string().min(1),
  estimatedTokens: z.number().int().nonnegative().optional(),
}).strict()

/** Validated ordered source list produced by Context Packing. */
export const contextManifestSchema = z.object({
  manifestId: z.string().min(1).transform(ContextManifestId),
  traceId: traceIdSchema,
  sessionId: sessionIdSchema,
  sessionWatermark: cursorSchema,
  policyVersion: z.string().min(1),
  compilerVersion: z.string().min(1),
  budgetTokens: z.number().int().nonnegative(),
  status: z.enum(['prepared', 'submitted', 'unknown']),
  fragments: z.array(contextFragmentSchema),
  omissions: z.array(contextOmissionSchema).optional(),
}).strict()

/** Validated complete Activation Trace. */
export const activationTraceSchema = z.object({
  traceId: traceIdSchema,
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  sessionId: sessionIdSchema,
  agentScope: z.string().min(1),
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  requestKind: z.enum(['main', 'compaction']),
  policyVersion: z.string().min(1),
  compilerVersion: z.string().min(1),
  sessionWatermark: cursorSchema,
  status: activationTraceStatusSchema,
  coverage: z.object({
    sourceSnapshot: activationCoverageSchema,
    candidateDecisions: activationCoverageSchema,
    finalContext: activationCoverageSchema,
  }).strict(),
  events: z.array(activationTraceEventSchema),
  manifest: contextManifestSchema.optional(),
}).strict()
