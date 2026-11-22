/** Provider rows and profile editors using the native settings controls. */
import { useState, type ReactNode } from 'react'
import { Button } from '../Button.tsx'
import { Modal } from '../Modal.tsx'
import { Tooltip } from '../Tooltip.tsx'
import { IconPlusOutlineRegular } from '../icons/index.tsx'
import { SettingsForm } from './SettingsForm.tsx'
import { SettingsValueField, SettingsSecretField } from './fields.tsx'
import type { SettingsProviderDirectoryState, SettingsProviderDirectory } from './provider-directory.ts'
import css from './SettingsProviders.module.css'
import type { SettingsProviderLabels } from './locales.ts'

/** A provider identity, optional confirmed credential state, and native actions. */
export interface SettingsProviderCardProps {
  name: string
  tag?: string
  status?: { configured: boolean | undefined; label: string }
  actions: ReactNode
  children?: ReactNode
}

/**
 * Render the same card proportions and material as Models settings.
 * @param props - identity, state, actions and optional editor.
 * @returns a provider card.
 */
export function SettingsProviderCard({ name, tag, status, actions, children }: SettingsProviderCardProps) {
  return <section className={css.card} aria-label={name}>
    <div className={css.head}><div className={css.identity}><span className={css.name}>{name}</span>
      {tag && <span className={css.tag}>{tag}</span>}
      {status && <Tooltip label={status.label}><span role="img" aria-label={status.label} className={css.dot} data-configured={status.configured} /></Tooltip>}
    </div><div className={css.actions}>{actions}</div></div>
    {children && <div className={css.editor}>{children}</div>}
  </section>
}

/** Saved-profile management bound through a feature's injected controller callbacks. */
export interface SettingsProvidersProps {
  /** Unique field prefix when several independent directories share one page; defaults to provider-profile. */
  idPrefix?: string
  state: SettingsProviderDirectoryState
  directory: Pick<SettingsProviderDirectory, 'open' | 'edit' | 'save' | 'cancel' | 'select' | 'remove'>
  labels: SettingsProviderLabels
  families: { id: string; label: string; available: boolean }[]
  /** Blocks switching while the feature's built-in editor saves. */
  disabled?: boolean
  /** Closes a built-in draft when the user explicitly opens another editor. */
  onOpen?: () => void
}

/**
 * Render saved providers and a catalog-backed add form without making service requests.
 * @param props - accepted rows, staged editor, locale copy and controller operations.
 * @returns saved rows, one editor and explicit removal confirmation.
 */
export function SettingsProviders({ state, directory, labels: t, families, disabled, onOpen, idPrefix = 'provider-profile' }: SettingsProvidersProps) {
  const [adding, setAdding] = useState(false)
  const [chosenFamily, setChosenFamily] = useState('')
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null)
  const editor = state.editor
  const blocked = disabled === true || state.busy || editor?.saving === true
  const statusLabel = (configured: boolean | undefined) => t[configured === undefined ? 'providers.unknown'
    : configured ? 'providers.configured' : 'providers.missing']
  return <div className={css.list}>
    {state.rows.map(row => <SettingsProviderCard key={row.id} name={row.profile.name} tag={row.family.label}
      status={{ configured: row.credential?.configured, label: statusLabel(row.credential?.configured) }}
      actions={<>
        {state.selected === row.id ? <span className={css.tag}>{t['providers.selected']}</span>
          : <Button size="sm" disabled={blocked} onClick={() => { void directory.select(row.id) }}>{t['providers.select']}</Button>}
        <Button size="sm" variant="outline" disabled={blocked || !row.writable} onClick={() => { setAdding(false); onOpen?.(); directory.open(row.family.id, row.key) }}>{t['providers.edit']}</Button>
        {row.removable && <Button size="sm" className={css.danger} disabled={blocked || !row.writable}
          onClick={() => { setRemoving({ id: row.id, name: row.profile.name }) }}>{t['providers.remove']}</Button>}
      </>} />)}
    {editor && <div className={css.editor} data-provider-editor>
      <div className={css.head}><strong className={css.name}>{editor.family.label}</strong>
        <Button size="sm" disabled={editor.saving} onClick={() => { directory.cancel(); setAdding(false) }}>{t['providers.cancel']}</Button></div>
      <SettingsForm state={editor} labels={{ unavailable: t['providers.unavailable'], readOnly: t['providers.readOnly'],
        saveFailed: t['providers.saveFailed'], save: t['providers.save'], saving: t['providers.saving'] }}
      onSave={() => { void directory.save() }} onDiscard={() => { directory.cancel() }}>
        <SettingsValueField id={`${idPrefix}-name`} label={t['providers.name']} hint={t['providers.nameHint']}
          {...editor.name} disabled={!editor.writable || editor.saving} overriddenLabel={t['providers.overridden']}
          resetLabel={t['providers.reset']} invalidLabel={t['providers.invalid']}
          onEdit={(text) =>{  directory.edit('name', text) }} onReset={() => { directory.edit('name', '') }} />
        <SettingsSecretField id={`${idPrefix}-key`} label={t['providers.key']} hint={t['providers.keyHint']}
          text={editor.apiKey.text} configured={editor.credential?.configured ?? false}
          stateLabel={statusLabel(editor.credential?.configured)} disabled={editor.saving || editor.credential?.writable !== true}
          onEdit={(text) =>{  directory.edit('apiKey', text) }} />
        {editor.fields.map(({ spec: field, state: value }) => <SettingsValueField key={field.field} id={`${idPrefix}-${field.field}`}
          label={field.label()} hint={field.hint()} {...value} numeric={field.numeric === true}
          disabled={!editor.writable || editor.saving} overriddenLabel={t['providers.overridden']}
          resetLabel={t['providers.reset']} invalidLabel={t['providers.invalid']}
          onEdit={(text) =>{  directory.edit(field.field, text) }}
          onReset={() => { directory.edit(field.field, String(editor.family.defaults[field.field] ?? '')) }} />)}
      </SettingsForm>
    </div>}
    {!editor && (adding ? <div className={css.editor}>
      <label className={css.name} htmlFor={`${idPrefix}-family`}>{t['providers.adapter']}</label>
      <select id={`${idPrefix}-family`} className={css.select} value={chosenFamily} disabled={blocked}
        onChange={(event) => { setChosenFamily(event.target.value) }}>
        <option value="" disabled>{t['providers.choose']}</option>
        {families.filter(family => family.available).map(family => <option key={family.id} value={family.id}>{family.label}</option>)}
      </select>
      <Button variant="outline" disabled={blocked || !families.some(family => family.id === chosenFamily && family.available)}
        onClick={() => { setAdding(false); onOpen?.(); directory.open(chosenFamily) }}>{t['providers.configure']}</Button>
      <Button onClick={() => { setAdding(false) }}>{t['providers.cancel']}</Button>
    </div> : <Button variant="outline" className={css.add} disabled={blocked || !families.some(family => family.available)}
      icon={<IconPlusOutlineRegular />} onClick={() => { setAdding(true) }}>{t['providers.add']}</Button>)}
    <Modal open={removing !== null} title={t['providers.removeTitle']} description={`${removing?.name ?? ''} · ${t['providers.removeHint']}`}
      closeLabel={t['providers.cancel']} onClose={() => { if (!blocked) setRemoving(null) }}
      footer={<><Button disabled={blocked} onClick={() => { setRemoving(null) }}>{t['providers.cancel']}</Button>
        <Button disabled={blocked} className={css.danger} onClick={() => {
          if (removing !== null) { void directory.remove(removing.id); setRemoving(null) }
        }}>{t['providers.remove']}</Button></>} />
  </div>
}
