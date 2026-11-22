/** Browser-owner Remote entry points for the Host Session deletion coordinator. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService, type PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  SessionDeletionError,
  type SessionDeletionCoordinator,
} from './coordinator.ts'
import type { DeletionId, DeletionPreview, DeletionReceipt } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Verified storage owners publish the coordinator after restoring admission fences. */
    sessionDeletionCoordinator: SessionDeletionCoordinator
    /** Host Session deletion Remote namespace. */
    sessionDeletionRemote: SessionDeletionRemote
  }
}

const idSchema = z.uuid()
const sessionSchema = z.string().min(1).max(256)
const revisionSchema = z.number().int().positive()
const pageSize = 25

/** Owner-only Remote, mounted only with a verified deletion coordinator. */
export class SessionDeletionRemote extends TypertRemoteService {
  static inject = ['connection', 'sessionDeletionCoordinator']

  /** @param ctx - service context with authenticated Connection and verified deletion owners. */
  constructor(ctx: Context) {
    super(ctx, 'sessionDeletionRemote', { namespace: 'sessionDeletion' })
  }

  /**
   * Inspect the scope without activating the Session.
   * @param sessionId - target Session.
   * @param signal - caller cancellation.
   * @returns the deletion impact and confirmation ID when eligible.
   */
  @Remote('preview')
  async preview(sessionId: SessionId, signal: AbortSignal): Promise<DeletionPreview> {
    const peerId = this.requireInteractiveOwner()
    validate(sessionSchema, sessionId)
    return invoke(() => this.ctx.sessionDeletionCoordinator.preview(peerId, sessionId, signal), signal)
  }

  /**
   * Confirm the original deletion scope.
   * @param sessionId - target Session from the preview.
   * @param deletionId - Host-issued confirmation ID.
   * @param signal - caller cancellation before durable acceptance.
   * @returns the durable acceptance receipt.
   */
  @Remote('commit')
  async commit(sessionId: SessionId, deletionId: DeletionId, signal: AbortSignal): Promise<DeletionReceipt> {
    const peerId = this.requireInteractiveOwner()
    validate(sessionSchema, sessionId)
    validate(idSchema, deletionId)
    return invoke(() => this.ctx.sessionDeletionCoordinator.commit(peerId, sessionId, deletionId, signal), signal)
  }

  /**
   * Resolve a receipt, including after a lost commit reply.
   * @param deletionId - accepted deletion ID.
   * @returns the known receipt or null if no acceptance is recorded.
   */
  @Remote('status')
  async status(deletionId: DeletionId): Promise<DeletionReceipt | null> {
    this.requireInteractiveOwner()
    validate(idSchema, deletionId)
    return invoke(() => this.ctx.sessionDeletionCoordinator.status(deletionId) ?? null)
  }

  /**
   * List accepted operation receipts to reconcile after reconnect.
   * @param after - final ID from the preceding page, if any.
   * @returns one page of receipts in acceptance order.
   */
  @Remote('list')
  async list(after?: DeletionId): Promise<DeletionReceipt[]> {
    this.requireInteractiveOwner()
    if (after !== undefined) validate(idSchema, after)
    return invoke(() => this.ctx.sessionDeletionCoordinator.list(after, pageSize))
  }

  /**
   * Retry the unfinished steps within an existing accepted scope.
   * @param deletionId - accepted deletion ID.
   * @param expectedOperationRevision - revision displayed to the caller.
   * @returns the current deletion receipt.
   */
  @Remote('retry')
  async retry(deletionId: DeletionId, expectedOperationRevision: number): Promise<DeletionReceipt> {
    this.requireInteractiveOwner()
    validate(idSchema, deletionId)
    validate(revisionSchema, expectedOperationRevision)
    return invoke(() => this.ctx.sessionDeletionCoordinator.retry(deletionId, expectedOperationRevision))
  }

  private requireInteractiveOwner(): PeerId {
    const peer = this.ctx.invocation?.peer
    const browser = this.ctx.connection.browserPeer
    if (peer === undefined || peer.signal.aborted || peer.id !== browser.id) {
      throw new RemoteError('session-deletion/forbidden', 'Session deletion requires an authenticated interactive owner', {})
    }
    return peer.id
  }
}

function validate(schema: z.ZodType, value: unknown): void {
  if (!schema.safeParse(value).success) throw new RemoteError('gateway/bad-request', 'Invalid Session deletion request', {})
}

async function invoke<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    if (error instanceof SessionDeletionError) throw new RemoteError(`session-deletion/${error.code}`, error.message, {})
    if (signal?.aborted) throw new RemoteError('gateway/cancelled', 'Session deletion request cancelled', {})
    throw error
  }
}
