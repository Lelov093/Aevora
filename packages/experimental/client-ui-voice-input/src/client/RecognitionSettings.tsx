/** Optional recognition area within the stable voice settings page. */
import { Button, SettingsProviders, settingsProviderLabels, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type { RecognitionSettingsFace } from './recognition-settings.ts'
import css from './VoiceInput.module.css'

type Props = PropsRuntime<'settings.voice.recognition'> & PropsLocale<typeof NS> & InjectFace<RecognitionSettingsFace>

/** @param props - native directory data and callbacks. @returns recognition provider cards. */
export function RecognitionSettings(props: Props) {
  const profiles = props.useRecognitionProfiles(value => value), t = props.t
  return <div className={css.recognitionSettings} data-recognition-settings>
    <p>{t('asr.independent')}</p>
    {profiles.selected !== 'sensevoice-local' && <Button size="sm" disabled={profiles.busy} onClick={() => { void props.recognitionDirectory.select('sensevoice-local') }}>{t('asr.useNative')}</Button>}
    <SettingsProviders idPrefix="recognition" state={profiles} directory={props.recognitionDirectory} families={profiles.families}
      labels={{ ...settingsProviderLabels(t), 'providers.add': t('asr.add') }} />
  </div>
}

type ToastProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & InjectFace<RecognitionSettingsFace>

/** @param props - root-owned provider feedback. @returns a toast surviving settings closure. */
export function RecognitionToast(props: ToastProps) {
  const outcome = props.useRecognitionFeedback(value => value)
  if (outcome === null) return null
  const key = outcome.kind === 'saved' ? 'providers.saved' : outcome.kind === 'removed' ? 'providers.removed'
    : outcome.kind === 'selected' ? 'providers.chosen' : 'providers.failed'
  return <Toast key={outcome.sequence} text={props.t(key)} onDone={() => { props.recognitionDirectory.dismiss(outcome.sequence) }} />
}
