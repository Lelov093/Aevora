/** Session menu action and one Host-backed permanent-deletion confirmation. */
import type { Context } from '@deepseek-ai/cordis'
import type { DeletionId, DeletionPreview, DeletionReceipt } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from '../rows/WorkspaceBrowser.module.css'

const en = {
  menu: 'Delete permanently',
  unavailable: 'Delete permanently (requires managed storage)',
  title: 'Permanently delete this conversation?',
  detail: 'The conversation and its listed child conversations will be permanently deleted. You cannot undo this.',
  target: 'Conversation ID',
  affected: 'Conversations to delete',
  kept: 'Independent conversations, saved memories, shared attachments, and exported files are kept.',
  active: 'Stop the running work before deleting this conversation.',
  cancel: 'Cancel',
  close: 'Close',
  delete: 'Delete',
  refresh: 'Check status',
  retry: 'Continue cleanup',
  waiting: 'The Host is still deleting this conversation.',
  deleted: 'Conversation deleted.',
  failed: 'Unable to confirm deletion. Check the current state before trying again.',
  partial: 'Deletion is incomplete. The conversation remains unavailable while cleanup is pending.',
  manual: 'The Host could not verify the remaining cleanup. Check the Host log before taking further action.',
  quiesce: 'Stop session work',
  schedule: 'Remove scheduled work',
  workspace: 'Remove workspace references',
  artifacts: 'Remove temporary files',
  logs: 'Remove session logs',
  projection: 'Remove cached conversation data',
  query: 'Remove search index entries',
  verify: 'Verify removal',
  stale: 'The conversation changed. Open a new preview before deleting.',
} as const

const zh: Record<keyof typeof en, string> = {
  menu: '永久删除',
  unavailable: '永久删除（需要托管存储）',
  title: '永久删除此会话？',
  detail: '此会话和下方列出的子会话将被永久删除。此操作无法撤销。',
  target: '会话 ID',
  affected: '将删除的会话',
  kept: '独立会话、已保存的记忆、共享附件及已导出的文件会保留。',
  active: '请先停止运行中的工作，再删除此会话。',
  cancel: '取消',
  close: '关闭',
  delete: '删除',
  refresh: '检查状态',
  retry: '继续清理',
  waiting: 'Host 正在删除此会话。',
  deleted: '会话已删除。',
  failed: '无法确认删除结果，请先检查状态。',
  partial: '清理尚未完成，当前无法使用该会话。',
  manual: 'Host 无法核实剩余清理，请先查看 Host 日志。',
  quiesce: '停止会话工作',
  schedule: '移除计划任务',
  workspace: '移除工作区引用',
  artifacts: '移除临时文件',
  logs: '移除会话日志',
  projection: '移除会话缓存',
  query: '移除搜索索引条目',
  verify: '核实清理结果',
  stale: '会话已变化，请重新打开预览后再删除。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    sessionDeletion: keyof typeof en
  }
}

type State =
  | { kind: 'closed' }
  | { kind: 'preview'; sessionId: SessionId; value: DeletionPreview }
  | { kind: 'loading'; sessionId: SessionId }
  | { kind: 'receipt'; sessionId: SessionId; value: DeletionReceipt }
  | { kind: 'error'; sessionId: SessionId; message: 'active' | 'stale' | 'failed'; deletionId?: DeletionId }

type MenuFace = {
  available: ReturnType<typeof createSnapshotStore<boolean>>
  open: (sessionId: SessionId) => void
}
type DialogFace = {
  state: ReturnType<typeof createSnapshotStore<State>>
  busy: ReturnType<typeof createSnapshotStore<boolean>>
  close: () => void
  confirm: (sessionId: SessionId, preview: Extract<DeletionPreview, { kind: 'ready' }>) => void
  refresh: (sessionId: SessionId, deletionId: DeletionId) => void
  retry: (sessionId: SessionId, receipt: DeletionReceipt) => void
}

type MenuProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & PropsLocale<'sessionDeletion'>
  & InjectFace<{ open: MenuFace['open']; hooks: { deletionAvailable: MenuFace['available'] } }>
type DialogProps = PropsRuntime<'shell.overlay'> & PropsLocale<'sessionDeletion'>
  & InjectFace<
    Omit<DialogFace, 'state' | 'busy'> & { hooks: { deletionState: DialogFace['state']; deletionBusy: DialogFace['busy'] } }
  >

function DeleteSessionMenuItem({ sessionId, t, useMenuOpenState, useSessionAccess, useDeletionAvailable, open }: MenuProps) {
  const allowed = useSessionAccess(sessionId, 'sessionDeletion/preview')
  const canArchive = useSessionAccess(sessionId, 'workspace/archiveSession')
  const available = useDeletionAvailable(value => value)
  const [, setMenuOpen] = useMenuOpenState()
  if (available ? !allowed : !canArchive) return null
  return <MenuItemButton disabled={!available} danger={available} onSelect={() => {
    if (!available) return
    setMenuOpen(false)
    open(sessionId)
  }}>{t(available ? 'menu' : 'unavailable')}</MenuItemButton>
}

function DeleteSessionDialog({ t, useDeletionState, useDeletionBusy, close, confirm, refresh, retry }: DialogProps) {
  const state = useDeletionState(value => value)
  const busy = useDeletionBusy(value => value)
  if (state.kind === 'closed') return null
  const ready = state.kind === 'preview' && state.value.kind === 'ready' ? state.value : undefined
  const operation = state.kind === 'receipt' ? state.value : undefined
  const operationId = operation?.state === 'deleted' ? undefined : operation?.deletionId
  const currentId = state.kind === 'error' ? state.deletionId : operationId
  return (
    <Modal open onClose={close} closeLabel={t('close')} title={t('title')} description={t('detail')} footer={
      <>
        <Button variant="outline" disabled={busy} onClick={close}>{t(ready === undefined ? 'close' : 'cancel')}</Button>
        {ready !== undefined && <Button variant="outline" disabled={busy} className={css.deleteAction}
          onClick={() => { confirm(state.sessionId, ready) }}>{t('delete')}</Button>}
        {currentId !== undefined && <Button variant="outline" disabled={busy}
          onClick={() => { refresh(state.sessionId, currentId) }}>{t('refresh')}</Button>}
        {operation?.state === 'action_required' && operation.retryable && <Button variant="outline" disabled={busy}
          onClick={() => { retry(state.sessionId, operation) }}>{t('retry')}</Button>}
      </>
    }>
      <p>{t('target')} <code>{state.sessionId}</code></p>
      {state.kind === 'preview' && <>
        <p>{state.value.title}</p>
        <ul className={css.archiveActivity} aria-label={t('affected')}>
          {state.value.memberIds.map(id => <li key={id}>{id}</li>)}
        </ul>
        <p>{t('kept')}</p>
        {state.value.kind === 'blocked' && <div role="alert" className={css.renameError}>
          {t('active')}
          <ul>{state.value.activity.map((work, index) => <li key={index}>{work.label ?? work.kind}</li>)}</ul>
        </div>}
      </>}
      {(state.kind === 'loading' || busy) && <span role="status" aria-busy="true" />}
      {state.kind === 'error' && <p role="alert" className={css.renameError}>{t(state.message)}</p>}
      {operation !== undefined && <p role={operation.state === 'action_required' ? 'alert' : 'status'}>
        {t(operation.state === 'deleted' ? 'deleted' : operation.state === 'action_required' ? 'partial' : 'waiting')}
      </p>}
      {operation?.state === 'action_required' && <>
        {operation.step !== undefined && <p>{t(operation.step)}</p>}
        <ul className={css.archiveActivity} aria-label={t('affected')}>
          {operation.sessionIds.map(id => <li key={id}>{id}</li>)}
        </ul>
        {operation.retryable === false && <p>{t('manual')}</p>}
      </>}
    </Modal>
  )
}

/**
 * Register available Host deletion in the existing menu and shell overlay.
 * @param ctx - Workspace client context.
 */
export function registerSessionDeletion(ctx: Context): void {
  const available = createSnapshotStore(false)
  let openPreview: MenuFace['open'] | undefined
  ctx.effect(() => ctx.locale.register('sessionDeletion', { en, zh }), 'Session deletion copy')
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'permanent-delete', order: 500, locale: 'sessionDeletion',
    inject: () => ({ open: (sessionId: SessionId) => { openPreview?.(sessionId) }, hooks: { deletionAvailable: available } }),
  }, DeleteSessionMenuItem))
  ctx.inject(['remote.sessionDeletion'], (scope) => {
    const state = createSnapshotStore<State>({ kind: 'closed' })
    const busy = createSnapshotStore(false)
    let activePreview: AbortController | undefined
    let disposed = false
    const remote = scope.remote.sessionDeletion
    const close = () => {
      if (busy.getSnapshot()) return
      activePreview?.abort()
      state.set({ kind: 'closed' })
    }
    const open = (sessionId: SessionId) => {
      if (busy.getSnapshot()) return
      activePreview?.abort()
      const controller = new AbortController()
      activePreview = controller
      state.set({ kind: 'loading', sessionId })
      void remote.preview(sessionId, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        state.set(result.ok ? { kind: 'preview', sessionId, value: result.value }
          : { kind: 'error', sessionId, message: 'failed' })
      }).catch((error: unknown) => {
        scope.logger.warn('Session deletion preview failed', error)
        if (!controller.signal.aborted) state.set({ kind: 'error', sessionId, message: 'failed' })
      })
    }
    const showReceipt = (sessionId: SessionId, value: DeletionReceipt) => {
      if (disposed) return
      state.set({ kind: 'receipt', sessionId, value })
      if (value.state === 'deleted') {
        scope.emit('client/session-deleted', value.sessionIds)
        void scope.sessions.refresh().catch((error: unknown) => {
          scope.logger.warn('Session list refresh after deletion failed', error)
        })
      }
    }
    const run = (sessionId: SessionId, deletionId: DeletionId, action: () => Promise<void>) => {
      if (busy.getSnapshot()) return
      busy.set(true)
      void action().catch((error: unknown) => {
        scope.logger.warn('Session deletion response unavailable', error)
        if (!disposed) state.set({ kind: 'error', sessionId, message: 'failed', deletionId })
      }).finally(() => { busy.set(false) })
    }
    const refresh = (sessionId: SessionId, deletionId: DeletionId) => {
      run(sessionId, deletionId, async () => {
        const result = await remote.status(deletionId)
        if (result.ok && result.value !== null) showReceipt(sessionId, result.value)
        else if (!disposed) state.set({ kind: 'error', sessionId, message: 'failed', deletionId })
      })
    }
    const confirm = (sessionId: SessionId, preview: Extract<DeletionPreview, { kind: 'ready' }>) => {
      run(sessionId, preview.deletionId, async () => {
        const result = await remote.commit(sessionId, preview.deletionId)
        if (!disposed && !result.ok && result.error.code === 'session-deletion/stale-preview') {
          state.set({ kind: 'error', sessionId, message: 'stale' })
          return
        }
        if (!disposed && !result.ok && result.error.code === 'session-deletion/active') {
          state.set({ kind: 'error', sessionId, message: 'active' })
          return
        }
        if (result.ok) {
          const latest = await remote.status(preview.deletionId)
          showReceipt(sessionId, latest.ok && latest.value !== null ? latest.value : result.value)
        } else if (!disposed) state.set({ kind: 'error', sessionId, message: 'failed', deletionId: preview.deletionId })
      })
    }
    const retry = (sessionId: SessionId, receipt: DeletionReceipt) => {
      run(sessionId, receipt.deletionId, async () => {
        const result = await remote.retry(receipt.deletionId, receipt.operationRevision)
        if (result.ok) showReceipt(sessionId, result.value)
        else if (!disposed) state.set({ kind: 'error', sessionId, message: 'failed', deletionId: receipt.deletionId })
      })
    }
    const reconcile = async () => {
      let after: DeletionId | undefined
      const cleared: SessionId[] = []
      let unfinished: DeletionReceipt | undefined
      while (true) {
        const result = await remote.list(after)
        if (disposed) return
        available.set(result.ok)
        if (!result.ok) return
        if (result.value.length === 0) break
        for (const receipt of result.value) {
          if (receipt.state === 'deleted') cleared.push(...receipt.sessionIds)
          else unfinished ??= receipt
          after = receipt.deletionId
        }
      }
      if (cleared.length > 0) scope.emit('client/session-deleted', cleared)
      if (unfinished !== undefined && state.getSnapshot().kind === 'closed') {
        const sessionId = unfinished.sessionIds[0]
        if (sessionId !== undefined) showReceipt(sessionId, unfinished)
      }
    }
    const check = () => {
      void reconcile().catch((error: unknown) => {
        scope.logger.warn('Session deletion availability check failed', error)
        if (!disposed) available.set(false)
      })
    }
    scope.on('connection/reset', check)
    scope.effect(() => {
      openPreview = open
      return () => {
        disposed = true
        activePreview?.abort()
        if (openPreview === open) {
          openPreview = undefined
          available.set(false)
        }
      }
    }, 'Session deletion client lifetime')
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay', id: 'session-deletion-confirm', locale: 'sessionDeletion',
      inject: () => ({ close, refresh, confirm, retry, hooks: { deletionState: state, deletionBusy: busy } }),
    }, DeleteSessionDialog))
    check()
  })
}
