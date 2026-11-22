/** Connects the Host deletion operation to native storage and Session owners. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-spill-local'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ConfirmedDeletion } from '@deepseek-ai/dsh-session-persistence/deletion-journal'
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionDeletionCoordinator, SessionDeletionError, type DeletionObservation, type DeletionOwners } from './coordinator.ts'

/** Wait for every required owner before mounting the permanent-deletion Remote. */
export const sessionDeletionOwnersInject = [
  'sessionDeletionJournal', 'sessionDeletionFiles', 'sessionPersistence', 'sessionController',
  'sessionQuery', 'workspaceRegistry', 'sessionProjectionCache', 'schedule', 'subagents',
  'sessionDeletionSpill', 'sessionDeletionWorkspaceChanges',
]

/** Runtime settings validated by the Host configuration schema. */
export interface SessionDeletionHostConfig {
  readonly previewTtlMs: number
  readonly previewCapacity: number
}

/**
 * Restore the coordinator after all storage and cleanup owners are ready.
 * @param ctx - bound Host context.
 * @param config - validated preview limits.
 */
export function mountSessionDeletionOwners(ctx: Context, config: SessionDeletionHostConfig): void {
  if (ctx.sessionQuery.removeDeletedSessions === undefined) {
    throw new SessionDeletionError('unavailable')
  }
  const owners: DeletionOwners = {
    async observe(root, signal) {
      const scope = await observeScope(ctx, root, signal)
      if (scope === undefined) return undefined
      await verifyCatalog(ctx, scope, signal)
      const members = scope.targets.map(target => target.sessionId)
      const [title, activity] = await Promise.all([
        ctx.sessionQuery.readTitle(root, signal),
        activities(ctx, members),
      ])
      signal.throwIfAborted()
      return {
        scope,
        revision: JSON.stringify(scope),
        impact: { title: title?.title ?? root, memberIds: members, activity },
      }
    },
    async reserve(preview, signal) {
      const members = preview.scope.targets.map(target => target.sessionId)
      let release: (() => void) | undefined
      try {
        release = ctx.sessionDeletionFiles.freeze(members)
        if ((await activities(ctx, members)).length > 0) throw new SessionDeletionError('active')
        for (const id of members) {
          if (!await ctx.sessionController.retireForDeletion(id)) throw new SessionDeletionError('active')
        }
        const scope = await observeScope(ctx, preview.scope.rootSessionId, signal)
        if (scope === undefined || preview.revision !== JSON.stringify(scope)) throw new SessionDeletionError('stale-preview')
        const targets: ConfirmedDeletion['targets'][number][] = []
        for (const target of scope.targets) {
          targets.push(await ctx.sessionDeletionFiles.inspect({ id: target.sessionId, createdAt: target.createdAt }))
        }
        return {
          observation: { ...preview, scope } satisfies DeletionObservation,
          physicalScope: { rootSessionId: scope.rootSessionId, targets },
          release,
        }
      } catch (error: unknown) {
        release?.()
        if (error instanceof SessionAlreadyOwnedError) throw new SessionDeletionError('active', { cause: error })
        if (error instanceof SessionPersistenceNotFoundError) throw new SessionDeletionError('stale-preview', { cause: error })
        throw error
      }
    },
    async cleanup(deletionId, operation, step) {
      const ids = operation.sessionIds
      switch (step) {
        case 'quiesce':
          for (const id of ids) {
            if (!await ctx.sessionController.retireForDeletion(id)) {
              return { kind: 'blocked', reason: 'owner-unavailable', retryable: true }
            }
          }
          break
        case 'schedule': await ctx.schedule.removeDeletedSessions(ids); break
        case 'workspace': await ctx.workspaceRegistry.removeDeletedSessions(ids); break
        case 'artifacts':
          await ctx.sessionDeletionSpill.removeDeletedSessions(ids)
          await ctx.sessionDeletionWorkspaceChanges.removeDeletedSessions(ids)
          break
        case 'logs':
          if (await ctx.sessionDeletionFiles.purge(deletionId) === 'retryable') {
            return { kind: 'blocked', reason: 'owner-unavailable', retryable: true }
          }
          break
        case 'projection': await ctx.sessionProjectionCache.removeDeletedSessions(ids); break
        case 'query': {
          const engine = ctx.sessionQuery
          if (engine.removeDeletedSessions === undefined) return { kind: 'blocked', reason: 'owner-unavailable', retryable: true }
          await engine.removeDeletedSessions(ids)
          break
        }
        case 'verify':
          await ctx.sessionDeletionSpill.verifyDeletedSessions(ids)
          await ctx.sessionDeletionWorkspaceChanges.verifyDeletedSessions(ids)
          break
      }
      return { kind: 'verified' }
    },
  }
  const coordinator = new SessionDeletionCoordinator(ctx.sessionDeletionJournal, owners, {
    ...config,
    reportError: (error, operation) => { ctx.logger.error('Session deletion %s needs attention: %s', operation, String(error)) },
  })
  ctx.effect(() => () => coordinator.dispose(), 'drain Session deletion cleanup')
  ctx.effect(() => ctx.provide('sessionDeletionCoordinator', coordinator), 'provide Session deletion coordinator')
  coordinator.recover()
}

async function observeScope(ctx: Context, root: SessionId, signal: AbortSignal): Promise<ConfirmedDeletion | undefined> {
  const snapshots = await ctx.sessionPersistence.list({ signal })
  const byId = new Map(snapshots.map(snapshot => [snapshot.header.id, snapshot]))
  if (!byId.has(root)) return undefined
  const ids = new Set<SessionId>([root])
  for (const parent of ids) {
    for (const { header } of snapshots) {
      if (header.origin === 'subagent' && header.parentSession === parent) {
        if (ids.has(header.id)) throw new SessionDeletionError('unavailable')
        ids.add(header.id)
      }
    }
  }
  const targets = [...ids].sort().map((id) => {
    const snapshot = byId.get(id)
    if (snapshot === undefined) throw new SessionDeletionError('stale-preview')
    return {
      sessionId: id,
      createdAt: snapshot.header.createdAt,
      physicalIdentity: JSON.stringify([snapshot.header.origin, snapshot.header.parentSession, snapshot.revision]),
    }
  })
  return { rootSessionId: root, targets }
}

async function verifyCatalog(ctx: Context, scope: ConfirmedDeletion, signal: AbortSignal): Promise<void> {
  const members = new Set(scope.targets.map(target => target.sessionId))
  const discovered = await ctx.subagents.listDescendants(scope.rootSessionId, signal)
  for (const entry of discovered) {
    if (entry.kind === 'diagnostic' || (entry.mode !== 'external' && !members.has(entry.id))) {
      throw new SessionDeletionError('unavailable')
    }
  }
}

async function activities(ctx: Context, members: readonly SessionId[]): Promise<DeletionObservation['impact']['activity']> {
  const lists = await Promise.all(members.map(sessionId => ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))))
  return lists.flatMap(list => list.flatMap(work => work.items?.map(item => ({
    kind: work.kind,
    ...(item.label === undefined ? {} : { label: item.label }),
  })) ?? [{ kind: work.kind }]))
}
