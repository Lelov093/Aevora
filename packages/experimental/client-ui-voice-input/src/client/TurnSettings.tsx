/** Voice preferences are separate from starting a voice conversation. */
import { Checkbox, SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { createTurnSettings } from './turn-settings.ts'
import type { NS } from './locales.ts'

type Props = PropsRuntime<'settings.voice.recognition'> & PropsLocale<typeof NS> & InjectFace<ReturnType<typeof createTurnSettings>['face']>

/** @param props - native form observations and callbacks. @returns continuous voice settings. */
export function TurnSettings(props: Props) {
  const form = props.useTurnForm(value => value), t = props.t
  return <section data-turn-model-settings>
    <h3>{t('turns.title')}</h3>
    <SettingsForm state={form} labels={{ unavailable: t('turns.unavailable'), readOnly: t('turns.readOnly'), saveFailed: t('turns.saveFailed'), save: t('turns.save'), saving: t('turns.saving') }}
      onSave={props.save} onDiscard={props.discard}>
      <div>
        <Checkbox checked={form.parallel.text === 'true'} disabled={!form.writable || form.saving}
          label={t('turns.parallel')} onChange={(checked) => { props.edit('parallel', String(checked)) }} />
        <p>{t('turns.parallelHint')}</p>
      </div>
      <p>{t('turns.hint')}</p>
      {(['pythonPath', 'modelPath', 'vadModelPath'] as const).map(field => <SettingsValueField key={field} id={`voice-turn-${field}`}
        label={t(`turns.${field}`)} {...form[field]} disabled={!form.writable || form.saving}
        overriddenLabel={t('turns.overridden')} resetLabel={t('turns.reset')} invalidLabel={t('turns.invalid')}
        onEdit={(text) => { props.edit(field, text) }} onReset={() => { props.resetField(field) }} />)}
      <SettingsValueField id="voice-turn-silenceSeconds" numeric label={t('turns.silenceSeconds')}
        hint={t('turns.silenceHint')} {...form.silenceSeconds} disabled={!form.writable || form.saving}
        overriddenLabel={t('turns.overridden')} resetLabel={t('turns.reset')} invalidLabel={t('turns.silenceInvalid')}
        onEdit={(text) => { props.edit('silenceSeconds', text) }} onReset={() => { props.resetField('silenceSeconds') }} />
    </SettingsForm>
  </section>
}
