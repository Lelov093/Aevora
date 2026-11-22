/** Voice mode preferences over the native form; saving performs no inference or download. */
import type { Context } from '@deepseek-ai/cordis'
import { SettingsFormModel, settingsNumberField, settingsTextField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Native-editable preferences for the next voice mode. */
export interface TurnSettingsValues {
  parallel: boolean
  pythonPath: string
  modelPath: string
  vadModelPath: string
  /** Pause detection and completion recheck interval, in seconds. */
  silenceSeconds: number
}

type TurnSettingsForm = ReturnType<SettingsFormModel<TurnSettingsValues>['shell']>
  & Record<keyof TurnSettingsValues, ReturnType<SettingsFormModel<TurnSettingsValues>['field']>>

/** Native path form and its joined subscription cleanup. */
export interface TurnSettingsController {
  /** Release native form subscriptions. */
  readonly dispose: () => void
  readonly face: ReturnType<SettingsFormModel<TurnSettingsValues>['actions']> & { hooks: { turnForm: HostObservable<TurnSettingsForm> } }
}

/** Create a voice preferences form without inspecting or preparing resources.
 * @param ctx - settings contribution lifetime.
 * @returns owned native form and its injected face.
 */
export function createTurnSettings(ctx: Context): TurnSettingsController {
  const scope = ctx.configForms.get<TurnSettingsValues>('voice-turns'), silence = settingsNumberField('silenceSeconds')
  const paths = ['pythonPath', 'modelPath', 'vadModelPath'].map(field => ({ ...settingsTextField(field), parse: (text: string) => {
    const value = text.trim()
    if (!value) return { kind: 'clear' as const }
    if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value)) return undefined
    if (field === 'modelPath' && !/[\\/]smart-turn-v3\.1-cpu\.onnx$/.test(value)) return undefined
    return { kind: 'set' as const, value }
  } }))
  const parallel = {
    field: 'parallel',
    format: (value: unknown) => typeof value === 'boolean' ? String(value) : '',
    parse: (text: string) => text === 'true' || text === 'false' ? { kind: 'set' as const, value: text === 'true' } : undefined,
  }
  const form = new SettingsFormModel(scope, [parallel, ...paths, { ...silence, parse: (text) => {
    const write = silence.parse(text)
    if (write?.kind !== 'set') return write
    return typeof write.value === 'number' && write.value >= 0.1 && write.value <= 5 ? write : undefined
  } }])
  return { dispose: () => { form.dispose() }, face: { ...form.actions(), hooks: {
    turnForm: form.bind(() => ({ ...form.shell(), parallel: form.field('parallel'), pythonPath: form.field('pythonPath'), modelPath: form.field('modelPath'),
      vadModelPath: form.field('vadModelPath'), silenceSeconds: form.field('silenceSeconds') })),
  } } }
}
