/** Global Memory management page backed by the Host Memory provider. */

import { useMemo, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconChevronLeftOutlineMedium, IconEditOutlineRegular, IconPinFillMedium, IconPinOutlineMedium,
  IconSearchOutlineMedium, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { MemoryEvidenceId, type ConfirmedMemoryInput, type MemoryItem, type MemoryKind } from '../types.ts'
import { filterMemoryItems, type MemoryProvider } from '../provider.ts'
import { NS, type MemoryKey } from './locales.ts'
import css from './MemoryPage.module.css'

/** Client-side provider and mutation callbacks bound by the plugin mount. */
export interface MemoryPageInjected {
  hooks: { memory: HostObservable<readonly MemoryItem[]> }
  createConfirmed: MemoryProvider['createConfirmed']
  update: MemoryProvider['update']
  forget: MemoryProvider['forget']
  recall: MemoryProvider['recall']
  setPinned: MemoryProvider['setPinned']
  delete: MemoryProvider['delete']
}

/** Full props assembled by the root main-panel renderer. */
export type MemoryPageProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & InjectFace<MemoryPageInjected>

type FilterKind = MemoryKind | 'all'

function kindLabel(kind: MemoryKind, t: (key: MemoryKey) => string): string {
  return t(kind)
}

function scopeLabel(item: MemoryItem, t: (key: MemoryKey) => string): string {
  return item.scope.kind === 'user' ? t('userScope') : `${t('workspaceScope')} · ${item.scope.id}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Render the confirmed Memory list and selected-record details. */
export function MemoryPage(props: MemoryPageProps) {
  const { t, useMemory, createConfirmed, update, forget, recall, setPinned, delete: deleteMemory } = props
  const snapshot = useMemory(value => value)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<FilterKind>('all')
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [adding, setAdding] = useState(false)
  const [newKind, setNewKind] = useState<MemoryKind>('preference')
  const [newContent, setNewContent] = useState('')
  const filtered = useMemo(() => filterMemoryItems(snapshot, {
    includeForgotten: true,
    text,
    ...(kind === 'all' ? {} : { kind }),
  }), [kind, snapshot, text])
  const selected = snapshot.find(item => String(item.memoryId) === selectedId) ?? filtered[0]
  const hasDetail = selected !== undefined

  const run = (action: () => Promise<unknown>): void => {
    setPending(true)
    setError(undefined)
    action().then(
      () => { setPending(false) },
      (reason: unknown) => { setPending(false); setError(errorMessage(reason)) },
    )
  }

  const select = (item: MemoryItem): void => {
    setSelectedId(String(item.memoryId))
    setEditing(false)
    setDraft(item.content)
    setError(undefined)
  }

  const startEdit = (): void => {
    if (selected === undefined) return
    setDraft(selected.content)
    setEditing(true)
    setError(undefined)
  }

  const save = (): void => {
    if (selected === undefined || draft.trim().length === 0) return
    run(async () => {
      await update(selected.memoryId, selected.revision, { content: draft })
      setEditing(false)
    })
  }

  const pin = (): void => {
    if (selected === undefined) return
    run(() => setPinned(selected.memoryId, selected.revision, !selected.pinned))
  }

  const toggleRecall = (): void => {
    if (selected === undefined) return
    run(() => selected.recallState === 'forgotten'
      ? recall(selected.memoryId, selected.revision)
      : forget(selected.memoryId, selected.revision))
  }

  const remove = (): void => {
    if (selected === undefined || selected.recallState !== 'forgotten') return
    run(() => deleteMemory(selected.memoryId, selected.revision))
  }

  const add = (): void => {
    const content = newContent.trim()
    if (content.length === 0) return
    const now = Date.now()
    const input: ConfirmedMemoryInput = {
      kind: newKind,
      content,
      scope: { kind: 'user' },
      sourceEvidence: [{
        evidenceId: MemoryEvidenceId(`ui-memory-${now}`), sourceKind: 'user-confirmation',
        sourceRef: 'ui:memory-page', capturedAt: now, confirmationMethod: 'explicit-user',
      }], confirmedAt: now,
    }
    run(async () => {
      const created = await createConfirmed(input)
      setNewContent('')
      setAdding(false)
      setSelectedId(String(created.memoryId))
    })
  }

  return (
    <div className={css.page} data-detail={hasDetail ? '' : undefined}>
      <div className={css.scroll}>
        <div className={css.content}>
          <header className={css.heading}><h1>{t('pageTitle')}</h1><Button size="sm" variant="primary" onClick={() => { setAdding(true); setError(undefined) }}>{t('add')}</Button></header>
          {adding ? <div className={css.addPanel} role="dialog" aria-label={t('add')}>
            <label className={css.addField}><span>{t('kind')}</span><select value={newKind} onChange={(event) => { setNewKind(event.currentTarget.value as MemoryKind) }}>
              <option value="fact">{t('fact')}</option><option value="preference">{t('preference')}</option><option value="constraint">{t('constraint')}</option>
            </select></label>
            <label className={css.addField}><span>{t('content')}</span><textarea value={newContent} placeholder={t('emptyDescription')} onChange={(event) => { setNewContent(event.currentTarget.value) }} /></label>
            <div className={css.addActions}><Button size="sm" variant="primary" disabled={pending || newContent.trim().length === 0} onClick={add}>{t('save')}</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => { setAdding(false) }}>{t('cancel')}</Button></div>
          </div> : null}
          <p className={css.notice}>{t('hostNotice')}</p>
          <div className={css.toolbar}>
            <div className={css.filters} role="tablist" aria-label={t('kind')}>
              {(['all', 'fact', 'preference', 'constraint'] as const).map(value => (
                <button key={value} type="button" className={css.filter} data-active={kind === value ? '' : undefined}
                  aria-selected={kind === value} role="tab" onClick={() => { setKind(value) }}>
                  {value === 'all' ? t('all') : kindLabel(value, t)}
                </button>
              ))}
            </div>
            <label className={css.search}>
              <IconSearchOutlineMedium className={css.searchIcon} size={15} aria-hidden="true" />
              <input type="search" value={text} placeholder={t('search')} aria-label={t('search')}
                onChange={(event) => { setText(event.currentTarget.value) }} />
            </label>
          </div>
          <div className={css.body}>
            <section className={css.listPane} aria-label={t('pageTitle')}>
              {filtered.length === 0 ? (
                <div className={css.empty}><h2>{t('emptyTitle')}</h2><p>{t('emptyDescription')}</p></div>
              ) : (
                <ul className={css.rows}>
                  {filtered.map(item => (
                    <li key={String(item.memoryId)}>
                      <button type="button" className={css.row} data-selected={selected?.memoryId === item.memoryId ? '' : undefined}
                        data-kind={item.kind} onClick={() => { select(item) }}>
                        <span className={css.rowMark} aria-hidden="true" />
                        <span className={css.rowMain}>
                          <span className={css.rowContent}>{item.content}</span>
                          <span className={css.rowMeta}>
                            <span>{kindLabel(item.kind, t)}</span><span>{scopeLabel(item, t)}</span>
                            {item.recallState === 'forgotten' ? <span>{t('forgotten')}</span> : null}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className={css.detail} aria-label={t('selected')}>
              {selected === undefined ? <div className={css.detailEmpty}><p>{t('emptyDescription')}</p></div> : (
                <>
                  {editing ? <textarea className={css.editor} value={draft} aria-label={t('content')}
                    onChange={(event) => { setDraft(event.currentTarget.value) }} /> : <h2>{selected.content}</h2>}
                  <dl className={css.facts}>
                    <div className={css.fact}><dt>{t('kind')}</dt><dd>{kindLabel(selected.kind, t)}</dd></div>
                    <div className={css.fact}><dt>{t('scope')}</dt><dd>{scopeLabel(selected, t)}</dd></div>
                    <div className={css.fact}><dt>{t('confirmed')}</dt><dd>{selected.confirmedAt === undefined ? '—' : new Date(selected.confirmedAt).toLocaleString()}</dd></div>
                    <div className={css.fact}><dt>{t('source')}</dt><dd>{selected.sourceEvidence[0]?.sourceRef ?? '—'}</dd></div>
                    {selected.previousRevision === undefined ? null : <div className={css.fact}><dt>{t('correction')}</dt><dd>{selected.previousRevision}</dd></div>}
                    <div className={css.fact}><dt>{t('revision')}</dt><dd>{selected.revision}</dd></div>
                    <div className={css.fact}><dt>{t('updated')}</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd></div>
                  </dl>
                  {selected.applicability === undefined ? null : <><span className={css.contentLabel}>{t('applicability')}</span><div className={css.contentText}>{selected.applicability}</div></>}
                  {error === undefined ? null : <p className={css.error} role="alert">{error}</p>}
                  <div className={css.actions}>
                    {editing ? <>
                      <Button size="sm" variant="primary" disabled={pending || draft.trim().length === 0} onClick={save}>{t('save')}</Button>
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => { setEditing(false); setDraft(selected.content) }}>{t('cancel')}</Button>
                    </> : <Button size="sm" variant="outline" disabled={pending} icon={<IconEditOutlineRegular size={14} />} onClick={startEdit}>{t('edit')}</Button>}
                    <Button size="sm" variant="outline" disabled={pending} icon={selected.pinned ? <IconPinFillMedium size={14} /> : <IconPinOutlineMedium size={14} />} onClick={pin}>
                      {selected.pinned ? t('unpin') : t('pin')}
                    </Button>
                    <Button size="sm" variant="outline" disabled={pending} onClick={toggleRecall}>{selected.recallState === 'forgotten' ? t('recall') : t('forget')}</Button>
                    {selected.recallState === 'forgotten' ? <Button size="sm" variant="outline" disabled={pending} icon={<IconTrashOutlineRegular size={14} />} onClick={remove}>{t('delete')}</Button> : null}
                  </div>
                </>
              )}
            </section>
          </div>
        </div>
      </div>
      {hasDetail ? <button type="button" aria-label={t('cancel')} className={css.mobileBack} onClick={() => { setSelectedId(undefined) }}><IconChevronLeftOutlineMedium size={16} /></button> : null}
    </div>
  )
}
