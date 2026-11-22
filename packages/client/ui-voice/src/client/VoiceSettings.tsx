/** Native voice API settings page. */
import { useState } from 'react'
import { SettingsProviderCard, SettingsProviders, settingsProviderLabels, Button, Toast, SettingsForm, SettingsSecretField, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceSettingsFace } from './settings.ts'
import type { VoiceProvidersFace } from './providers.ts'
import css from './voice.module.css'

/** Renderer-derived settings props. */
export type VoiceSettingsProps = PropsRuntime<'settings.section'> & PropsLocale<'voice'> & InjectFace<VoiceSettingsFace> & InjectFace<VoiceProvidersFace> & PropsRenderSlots<'settings.voice.recognition'>

/** @param props - native form, secret presence and localized copy. @returns voice settings. */
export function VoiceSettings(props: VoiceSettingsProps) {
  const { t } = props
  const [legacyOpen, setLegacyOpen] = useState(false)
  const providers = props.useVoiceProviders(value => value)
  const form = props.useVoiceForm(value => value)
  const credential = props.useVoiceCredential(value => value)
  return <div className={css.section} data-voice-settings>
    <h2>{t('title')}</h2><p>{t('description')}</p>
    <h3>{t('recognition')}</h3>
    <SettingsProviderCard name={t('nativeName')} tag={t('providers.builtin')}
      actions={<Button variant="outline" size="sm" onClick={props.openRecognition}>{t('providers.edit')}</Button>} />
    <p>{t('asrHint')}</p>
    {props.renderSlot('settings.voice.recognition', {})}
    <h3>{t('synthesis')}</h3>
    {(form.endpoint.text.trim() !== '' || credential.configured) && <SettingsProviderCard name={t('legacyName')}
      status={{ configured: credential.known ? credential.configured : undefined,
        label: t(!credential.known ? 'providers.unknown' : credential.configured ? 'providers.configured' : 'providers.missing') }}
      actions={<>{providers.selected === 'qwen-online' ? <span>{t('providers.selected')}</span>
        : <Button size="sm" disabled={providers.busy} onClick={() => { void props.directory.select('qwen-online') }}>{t('providers.select')}</Button>}
      <Button size="sm" variant="outline" disabled={form.saving || providers.busy || providers.editor?.saving}
        onClick={() => { props.directory.cancel(); setLegacyOpen(value => !value) }}>
        {t(legacyOpen ? 'providers.cancel' : 'providers.edit')}</Button></>} /> }
    {legacyOpen &&
    <SettingsForm state={form} labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }} onSave={props.save} onDiscard={props.discard}>
      <SettingsSecretField id="voice-api-key" label={t('apiKey')} hint={t('apiKeyHint')}
        text={form.apiKey.text} configured={credential.configured} disabled={!credential.writable || form.saving}
        stateLabel={t(!credential.known ? 'keyUnknown' : credential.configured ? 'keySet' : 'keyUnset')}
        onEdit={(text) =>{  props.edit('apiKey', text) }} />
      {(['endpoint', 'model', 'voice', 'rate'] as const).map(field => <SettingsValueField key={field}
        id={`voice-${field}`} label={t(field)} hint={t(`${field}Hint`)} {...form[field]}
        numeric={field === 'rate'} disabled={!form.writable || form.saving} overriddenLabel={t('overridden')}
        resetLabel={t('reset')} invalidLabel={t('invalid')} onEdit={(text) =>{  props.edit(field, text) }} onReset={() =>{  props.resetField(field) }} />)}
    </SettingsForm>}
    <SettingsProviders disabled={form.saving} onOpen={() => { setLegacyOpen(false) }} state={providers} directory={props.directory}
      labels={settingsProviderLabels(t)} families={providers.families} />
  </div>
}

/** Root-owned provider outcome props. */
type VoiceProvidersToastProps = PropsRuntime<'shell.overlay'> & PropsLocale<'voice'> & InjectFace<VoiceProvidersFace>

/** Render provider operation outcomes after the settings page closes.
 * @param props - directory feedback and current locale.
 * @returns the root toast.
 */
export function VoiceProvidersToast(props: VoiceProvidersToastProps) {
  const outcome = props.useVoiceProviderFeedback(value => value)
  if (outcome === null) return null
  const key = outcome.kind === 'saved' ? 'providers.saved' : outcome.kind === 'removed' ? 'providers.removed'
    : outcome.kind === 'selected' ? 'providers.chosen' : 'providers.failed'
  return <Toast key={outcome.sequence} text={props.t(key)} onDone={() => { props.directory.dismiss(outcome.sequence) }} />
}
