/** Browser-safe Session deletion previews and durable operation receipts. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DeletionCleanupStep, DeletionFailure, DeletionId } from '@deepseek-ai/dsh-session-persistence/deletion-identity'
export type { DeletionCleanupStep, DeletionFailure, DeletionId } from '@deepseek-ai/dsh-session-persistence/deletion-identity'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'session-deletion/forbidden': {}
    'session-deletion/not-found': {}
    'session-deletion/stale-preview': {}
    'session-deletion/active': {}
    'session-deletion/unavailable': {}
    'session-deletion/receipt-unknown': {}
    'session-deletion/stale-receipt': {}
  }
}

/** User-facing scope summary and current activity. */
export interface DeletionImpact {
  readonly title: string
  readonly memberIds: readonly SessionId[]
  readonly activity: readonly { readonly kind: string; readonly label?: string }[]
}

/** Accepted or blocked preview for one Peer. */
export type DeletionPreview = DeletionImpact & (
  | { readonly kind: 'blocked' }
  | { readonly kind: 'ready'; readonly deletionId: DeletionId; readonly expiresAt: number }
)

/** Current state of an accepted deletion operation. */
export interface DeletionReceipt {
  readonly deletionId: DeletionId
  /** Target Session followed by the other confirmed members. */
  readonly sessionIds: readonly SessionId[]
  readonly operationRevision: number
  readonly state: 'pending' | 'purging' | 'action_required' | 'deleted'
  readonly step?: DeletionCleanupStep
  readonly reason?: DeletionFailure
  readonly retryable?: boolean
}
