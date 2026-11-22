/** Optional Host plugin that mounts the existing AgentLoop Trace Producer. */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { MemoryAccessibilityPolicy } from './activation.ts'
import { installActivationTraceProducer } from './trace-producer.ts'

/** Loader configuration for the explicit Trace Producer plugin. */
export interface Config {
  readonly budgetTokens?: number
  readonly minimumRecallability?: number
  readonly policyVersion?: string
  readonly compilerVersion?: string
  readonly accessibilityPolicy?: MemoryAccessibilityPolicy
  readonly attachPreparedManifest?: boolean
}

const accessibilityPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deterministic-v0.1') }).strict(),
  z.object({
    kind: z.literal('exponential-v1'),
    timeConstantMs: z.number().positive(),
    calibrationRef: z.string().min(1).optional(),
  }).strict(),
])

const configSchema = z.object({
  budgetTokens: z.number().int().nonnegative().optional(),
  minimumRecallability: z.number().min(0).max(1).optional(),
  policyVersion: z.string().min(1).optional(),
  compilerVersion: z.string().min(1).optional(),
  accessibilityPolicy: accessibilityPolicySchema.optional(),
  attachPreparedManifest: z.boolean().default(false),
}).strict().superRefine((config, context) => {
  if (config.accessibilityPolicy?.kind === 'exponential-v1' && config.policyVersion === undefined) {
    context.addIssue({ code: 'custom', path: ['policyVersion'], message: 'An explicit policyVersion is required for exponential-v1' })
  }
})

function normalizeAccessibilityPolicy(
  policy: z.infer<typeof accessibilityPolicySchema> | undefined,
): MemoryAccessibilityPolicy | undefined {
  if (policy === undefined || policy.kind === 'deterministic-v0.1') return policy
  return {
    kind: 'exponential-v1',
    timeConstantMs: policy.timeConstantMs,
    ...(policy.calibrationRef === undefined ? {} : { calibrationRef: policy.calibrationRef }),
  }
}

/** Host service required by the optional producer. */
export const inject = ['memory']

/** Loader-visible plugin name. */
export const name = 'conscious-ocean-trace-producer'

/** Mount the Trace Producer with explicit, validated request preparation options. */
export function apply(ctx: Context, rawConfig: Config = {}): void {
  const config = configSchema.parse(rawConfig)
  const accessibilityPolicy = normalizeAccessibilityPolicy(config.accessibilityPolicy)
  const options = {
    ...(config.budgetTokens === undefined ? {} : { budgetTokens: config.budgetTokens }),
    ...(config.minimumRecallability === undefined ? {} : { minimumRecallability: config.minimumRecallability }),
    ...(config.policyVersion === undefined ? {} : { policyVersion: config.policyVersion }),
    ...(config.compilerVersion === undefined ? {} : { compilerVersion: config.compilerVersion }),
    ...(accessibilityPolicy === undefined ? {} : { accessibilityPolicy }),
    now: Date.now,
    attachPreparedManifest: config.attachPreparedManifest,
  }
  ctx.effect(() => installActivationTraceProducer(ctx, ctx.memory, options), 'conscious-ocean: trace producer')
}
