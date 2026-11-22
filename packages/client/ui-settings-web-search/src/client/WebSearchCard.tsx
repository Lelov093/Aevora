/**
 * Search provider cards, native DeepSeek settings and named-provider editors.
 */

import { useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SearchProvidersFace } from './providers.ts'
import { SettingsProviderCard, SettingsProviders, settingsProviderLabels, Button, Toast, SettingsForm, SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import styles from './WebSearchCard.module.css'
import type { WebSearchCardFace } from './web-search-card-controller.ts'

/** Props the renderer binds for the web-search page. */
export type DeepSeekSearchEditorProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.webSearch'>
  & InjectFace<WebSearchCardFace>

/** Provider list and native editor props. */
export type WebSearchCardProps = DeepSeekSearchEditorProps & InjectFace<SearchProvidersFace>

/**
 * Render saved search providers and their native configuration forms.
 * @param props - locale copy, the form snapshot, and its actions.
 * @returns the settings page.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  if (props.view === 'summary') return t('description')
  const [editingNative, setEditingNative] = useState(false)
  const providers = props.useSearchProviders(value => value)
  const state = props.useWebSearchCard(snapshot => snapshot)
  return (
    <div className={styles.section} data-web-search-settings>
      <h2>{t('aevora.search.title')}</h2>
      <p>{t('providerIntro')}</p>
      {state.available && <SettingsProviderCard name={t('aevora.search.deepseek')} tag={t('providers.builtin')}
        status={{ configured: state.apiKeyConfigured, label: t(state.apiKeyConfigured ? 'providers.configured' : 'providers.missing') }}
        actions={<>{['deepseek-official', 'deepseek-search-api'].includes(providers.selected)
          ? <span>{t('providers.selected')}</span> : <Button size="sm" disabled={providers.busy}
            onClick={() => { void props.directory.select('deepseek-official') }}>{t('providers.select')}</Button>}
        <Button variant="outline" size="sm" disabled={state.saving || providers.busy || providers.editor?.saving}
          onClick={() => { props.directory.cancel(); setEditingNative(value => !value) }}>
          {t(editingNative ? 'providers.cancel' : 'providers.edit')}</Button></>} >
        {editingNative &&
    <DeepSeekSearchEditor {...props} />}
      </SettingsProviderCard>}
      <SettingsProviders disabled={state.saving} onOpen={() => { setEditingNative(false) }} state={providers} directory={props.directory}
        labels={settingsProviderLabels(t)} families={providers.families} />
    </div>
  )
}

/** Root provider outcome props. */
type SearchProvidersToastProps = PropsRuntime<'shell.overlay'> & PropsLocale<'settings.webSearch'> & InjectFace<SearchProvidersFace>

/** Render provider operation outcomes independently of the settings panel.
 * @param props - current outcome and dictionary.
 * @returns the root toast.
 */
export function SearchProvidersToast(props: SearchProvidersToastProps) {
  const outcome = props.useSearchProviderFeedback(value => value)
  if (outcome === null) return null
  const key = outcome.kind === 'saved' ? 'providers.saved' : outcome.kind === 'removed' ? 'providers.removed'
    : outcome.kind === 'selected' ? 'providers.chosen' : 'providers.failed'
  return <Toast key={outcome.sequence} text={props.t(key)} onDone={() => { props.directory.dismiss(outcome.sequence) }} />
}

/** Native DeepSeek form reused inside its provider card.
 * @param props - native form state and operations.
 * @returns the staged editor.
 */
export function DeepSeekSearchEditor(props: DeepSeekSearchEditorProps) {
  const { t } = props
  const state = props.useWebSearchCard(value => value)
  const disabled = !state.writable || state.saving
  const searchApi = state.useSearchApi
  const limitField = searchApi ? 'count' : 'maxUses'
  return (<SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
    {state.apiSwitchAvailable && (
      <div className={styles.feature}>
        <label className={styles.toggleRow}>
          <span>{t('useSearchApi')}</span>
          <Switch checked={searchApi} label={t('useSearchApi')} disabled={disabled || state.apiSwitchBlocked}
            onChange={(checked) => { props.setSearchApi(checked) }} />
        </label>
        <p className={styles.hint}>
          {t('useSearchApiHint')}
          <a className={styles.link} href={t('searchGuideUrl')} target="_blank" rel="noopener noreferrer">{t('searchGuide')}</a>
        </p>
      </div>
    )}
    <SettingsSecretField
      id="plugin-config-web-search-key"
      label={t('apiKey')}
      hint={t('apiKeyHint')}
      // The credentials domain accepts a key even when the settings document
      // itself is read-only; they are separate stores with separate refusals.
      // Its own writability is what disables this control — a key sourced
      // from the process environment cannot be written from here.
      disabled={!state.apiKeyWritable}
      text={state.apiKey.text}
      configured={state.apiKeyConfigured}
      stateLabel={state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset')}
      onEdit={(text) => { props.edit('apiKey', text) }}
    />
    <SettingsValueField
      id="plugin-config-web-search-endpoint"
      label={t(searchApi ? 'searchApiBaseUrl' : 'baseUrl')}
      hint={t(searchApi ? 'searchApiBaseUrlHint' : 'baseUrlHint')}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      invalidLabel={t('invalidNumber')}
      disabled={disabled}
      {...state.baseURL}
      onEdit={(text) => { props.edit('baseURL', text) }}
      onReset={() => { props.resetField('baseURL') }}
    />
    <SettingsValueField
      id={searchApi ? 'plugin-config-web-search-count' : 'plugin-config-web-search-max-uses'}
      label={t(limitField)}
      hint={t(searchApi ? 'countHint' : 'maxUsesHint')}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      invalidLabel={t(searchApi ? 'invalidCount' : 'invalidNumber')}
      numeric
      disabled={disabled}
      {...state[limitField]}
      onEdit={(text) => { props.edit(limitField, text) }}
      onReset={() => { props.resetField(limitField) }}
    />
  </SettingsForm>)
}
