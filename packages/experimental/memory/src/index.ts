/** Experimental confirmed Memory domain owner and provider. */

import { MemoryService } from './host.ts'

export type * from './types.ts'
export type * from './advanced.ts'
export type * from './provider.ts'
export {
  MemoryEvidenceId, MemoryFeedbackEventId, MemoryId, MemoryRelationId, memoryRecallabilityAt, memoryValidityAt,
} from './types.ts'
export {
  actrBaseLevelActivation, applyInterferencePenalty, combineRetentionScores, exponentialRetentionScore,
  memoryAccessibilityOutputSchema, memoryRetentionCombinationSchema, memoryRetentionModelIdSchema,
  memoryRetentionSelectionSchema, powerLawRetentionScore,
} from './advanced.ts'
export { memoryDomainSpec, MEMORY_DOMAIN_VERSION } from './storage.ts'
export {
  MemoryCandidateRejectedError, MemoryDeletionNotAllowedError, MemoryError, MemoryNotFoundError, MemoryRevisionConflictError,
  createKeylessMemoryProvider, createMemoryProvider, filterMemoryItems,
} from './provider.ts'
export { MemoryService, createDomainMemoryStore } from './host.ts'

export default MemoryService
