/** Editable Aevora character-card Settings page. */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AevoraIdentityKey } from './locales.ts'
import { formLabels } from './locales.ts'
import type { RoleCardInjected } from './controller.ts'
import { ROLE_CARD_FIELDS } from './controller.ts'
import css from './RoleCardPage.module.css'

/** Props assembled by the Settings slot. */
export type RoleCardPageProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.aevoraIdentity'> & InjectFace<RoleCardInjected>

const fieldKeys: Readonly<Record<typeof ROLE_CARD_FIELDS[number], AevoraIdentityKey>> = {
  displayName: 'displayName', identity: 'identity', personality: 'personality', values: 'values',
  relationship: 'relationship', expression: 'expression', boundaries: 'boundaries',
}

type AevoraIdentityHintKey =
  | 'displayNameHint' | 'identityHint' | 'personalityHint' | 'valuesHint'
  | 'relationshipHint' | 'expressionHint' | 'boundariesHint'

const fieldHintKeys: Readonly<Record<typeof ROLE_CARD_FIELDS[number], AevoraIdentityHintKey>> = {
  displayName: 'displayNameHint', identity: 'identityHint', personality: 'personalityHint', values: 'valuesHint',
  relationship: 'relationshipHint', expression: 'expressionHint', boundaries: 'boundariesHint',
}

/** Render the editable character card over the shared Settings form seam.
 * @param props - slot-owned locale, lifecycle, form state, and actions.
 * @returns the character-card Settings page.
 */
export function RoleCardPage(props: RoleCardPageProps): ReactNode {
  const { t } = props
  const state = props.useRoleCard(value => value)
  const disabled = !state.writable || state.saving
  return <div className={css.page}>
    <header className={css.heading}>
      <h1>{t('title')}</h1>
      <p>{t('description')}</p>
      <p className={css.meta}>
        <span>{state.lifecycle === 'active' ? t('active') : t('draft')}</span>
        <span>{t('version')} {state.version}</span>
        {state.historyLength > 0 ? <span>{t('history')} {state.historyLength}</span> : null}
      </p>
      <p className={css.scope}>{t('deletionScope')}</p>
    </header>
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      {ROLE_CARD_FIELDS.map((field) => {
        const key = fieldKeys[field]
        const value = state.fields[field]
        const multiline = field !== 'displayName'
        return <div key={field} className={css.field}>
          <label className={css.label} htmlFor={`aevora-role-card-${field}`}>{t(key)}</label>
          {multiline
            ? <textarea id={`aevora-role-card-${field}`} className={css.textarea} value={value.text} disabled={disabled}
              aria-invalid={value.invalid || undefined} onChange={(event) => { props.edit(field, event.target.value) }} />
            : <input id={`aevora-role-card-${field}`} className={css.input} value={value.text} disabled={disabled}
              aria-invalid={value.invalid || undefined} onChange={(event) => { props.edit(field, event.target.value) }} />}
          <p className={css.hint}>{t(fieldHintKeys[field])}</p>
          {value.overridden ? <span className={css.overridden}>{t('overridden')}<button type="button" className={css.reset}
            disabled={disabled} onClick={() => { props.resetField(field) }}>{t('reset')}</button></span> : null}
        </div>
      })}
    </SettingsForm>
    <section className={css.preview} aria-label={t('preview')}>
      <h2>{t('preview')}</h2>
      <p>{t('previewHint')}</p>
      <pre>{state.preview}</pre>
    </section>
    {state.history.length > 0 ? <section className={css.history} aria-label={t('history')}>
      <h2>{t('history')}</h2>
      {state.history.map(revision => <div className={css.historyRow} key={revision.version}>
        <span>{t('version')} {revision.version}</span>
        <button type="button" className={css.rollback} disabled={disabled} onClick={() => { props.rollback(revision.version) }}>
          {t('rollback')}
        </button>
      </div>)}
    </section> : null}
  </div>
}
