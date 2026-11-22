/** Evaluation-first advanced Memory field and retention-model contracts. */

import { z } from 'zod'

/** Candidate retention models available to an explicit evaluation recipe. */
export const memoryRetentionModelIdSchema = z.enum([
  'power-law-v1', 'act-r-base-level-v1', 'exponential-v1', 'interference-aware-v1',
])
/** Identifier for one candidate retention model. */
export type MemoryRetentionModelId = z.infer<typeof memoryRetentionModelIdSchema>

/** Output interpretation for an accessibility estimate. */
export const memoryAccessibilityOutputSchema = z.enum(['ranking-score', 'calibrated-probability'])
/** Interpretation of an accessibility estimate. */
export type MemoryAccessibilityOutput = z.infer<typeof memoryAccessibilityOutputSchema>

/** How selected candidate models are combined for one evaluation. */
export const memoryRetentionCombinationSchema = z.enum(['single', 'mean', 'weighted-mean'])
/** Combination rule for selected retention models. */
export type MemoryRetentionCombination = z.infer<typeof memoryRetentionCombinationSchema>

/** Explicit model selection for one advanced Memory evaluation or Profile. */
export const memoryRetentionSelectionSchema = z.object({
  version: z.string().min(1),
  models: z.array(memoryRetentionModelIdSchema).min(1),
  combination: memoryRetentionCombinationSchema,
  weights: z.array(z.number().finite().nonnegative()).optional(),
  output: memoryAccessibilityOutputSchema,
  calibrationRef: z.string().min(1).optional(),
}).strict().superRefine((selection, context) => {
  if (selection.combination === 'single' && selection.models.length !== 1) {
    context.addIssue({ code: 'custom', path: ['models'], message: 'Single retention selection requires exactly one model' })
  }
  if (selection.combination !== 'weighted-mean' && selection.weights !== undefined) {
    context.addIssue({ code: 'custom', path: ['weights'], message: 'Weights are only valid for weighted-mean selection' })
  }
  if (selection.combination === 'weighted-mean') {
    if (selection.weights === undefined || selection.weights.length !== selection.models.length) {
      context.addIssue({ code: 'custom', path: ['weights'], message: 'Weighted-mean selection requires one weight per model' })
    } else if (selection.weights.every(weight => weight === 0)) {
      context.addIssue({ code: 'custom', path: ['weights'], message: 'Weighted-mean selection requires a positive total weight' })
    }
  }
  if (selection.output === 'calibrated-probability' && selection.calibrationRef === undefined) {
    context.addIssue({ code: 'custom', path: ['calibrationRef'], message: 'Calibrated output requires a held-out calibration reference' })
  }
})
/** User- or Profile-selected retention recipe. */
export type MemoryRetentionSelection = z.infer<typeof memoryRetentionSelectionSchema>

/** A single elapsed-time observation consumed by candidate retention models. */
export interface MemoryRetentionObservation {
  /** Elapsed milliseconds since the model's reference event. */
  readonly elapsedMs: number
}

/**
 * Evaluate a power-law retention candidate with explicit parameters.
 * @param observation - elapsed-time observation for the candidate.
 * @param scaleMs - positive time scale in milliseconds.
 * @param exponent - positive power-law exponent.
 * @returns an uncalibrated ranking score.
 */
export function powerLawRetentionScore(observation: MemoryRetentionObservation, scaleMs: number, exponent: number): number {
  requirePositiveFinite(observation.elapsedMs, 'elapsedMs', true)
  requirePositiveFinite(scaleMs, 'scaleMs', false)
  requirePositiveFinite(exponent, 'exponent', false)
  return Math.pow(1 + observation.elapsedMs / scaleMs, -exponent)
}

/**
 * Evaluate an exponential comparison candidate with an explicit time constant.
 * @param observation - elapsed-time observation for the candidate.
 * @param timeConstantMs - positive time constant in milliseconds.
 * @returns an uncalibrated ranking score.
 */
export function exponentialRetentionScore(observation: MemoryRetentionObservation, timeConstantMs: number): number {
  requirePositiveFinite(observation.elapsedMs, 'elapsedMs', true)
  requirePositiveFinite(timeConstantMs, 'timeConstantMs', false)
  return Math.exp(-observation.elapsedMs / timeConstantMs)
}

/**
 * Evaluate ACT-R-style base-level activation from explicit event ages.
 * @param eventAgesMs - positive elapsed ages of explicit activation events.
 * @param decay - positive activation decay parameter.
 * @returns an uncalibrated activation value.
 */
export function actrBaseLevelActivation(eventAgesMs: readonly number[], decay: number): number {
  if (eventAgesMs.length === 0) throw new RangeError('ACT-R activation requires at least one event age')
  requirePositiveFinite(decay, 'decay', false)
  const activation = eventAgesMs.reduce((sum, ageMs) => {
    requirePositiveFinite(ageMs, 'eventAgeMs', false)
    return sum + Math.pow(ageMs / 1_000, -decay)
  }, 0)
  return Math.log(activation)
}

/**
 * Apply an explicit interference penalty without clamping or interpreting it as a probability.
 * @param baseScore - finite score produced by another candidate.
 * @param competitorCount - non-negative count of explicit competing records.
 * @param penaltyPerCompetitor - non-negative penalty per competitor.
 * @returns the adjusted uncalibrated ranking score.
 */
export function applyInterferencePenalty(baseScore: number, competitorCount: number, penaltyPerCompetitor: number): number {
  if (!Number.isFinite(baseScore)) throw new RangeError('baseScore must be finite')
  if (!Number.isSafeInteger(competitorCount) || competitorCount < 0) throw new RangeError('competitorCount must be a non-negative integer')
  requirePositiveFinite(penaltyPerCompetitor, 'penaltyPerCompetitor', true)
  return baseScore - competitorCount * penaltyPerCompetitor
}

/**
 * Combine candidate ranking scores using an explicit selection rule.
 * @param scores - one score for each selected model.
 * @param selection - validated model combination recipe.
 * @returns the combined uncalibrated ranking score.
 */
export function combineRetentionScores(
  scores: readonly number[],
  selection: MemoryRetentionSelection,
): number {
  if (scores.length !== selection.models.length) throw new RangeError('Score count must match selected model count')
  if (scores.length === 0) throw new RangeError('At least one retention score is required')
  if (scores.some(score => !Number.isFinite(score))) throw new RangeError('Retention scores must be finite')
  if (selection.combination === 'single') return scores[0]!
  if (selection.combination === 'mean') return scores.reduce((sum, score) => sum + score, 0) / scores.length
  const weights = selection.weights!
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  return scores.reduce((sum, score, index) => sum + score * weights[index]!, 0) / totalWeight
}

function requirePositiveFinite(value: number, name: string, allowZero: boolean): void {
  const lowerBound = allowZero ? 0 : 0
  if (!Number.isFinite(value) || value < lowerBound || (!allowZero && value === 0)) {
    throw new RangeError(`${name} must be ${allowZero ? 'non-negative' : 'positive'} and finite`)
  }
}
