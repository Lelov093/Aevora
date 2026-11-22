/** Shared Session deletion identifiers and recovery step vocabulary. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity issued by the Host for one deletion confirmation. */
export type DeletionId = Branded<'DeletionId'>

/** Owner cleanup and final verification steps in a durable deletion operation. */
export type DeletionCleanupStep = 'quiesce' | 'schedule' | 'workspace' | 'artifacts' | 'logs' | 'projection' | 'query' | 'verify'

/** Safe failure details shown on an accepted operation. */
export type DeletionFailure = 'owner-unavailable' | 'identity-mismatch' | 'write-failed' | 'outcome-unknown'
