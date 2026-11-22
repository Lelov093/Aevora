/** Settings-form controller for the versioned Aevora character card. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  SettingsFieldState, SettingsFormScope, SettingsFormScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RoleCardValues } from '../types.ts'
import {
  ROLE_CARD_NAMESPACE, renderRoleCard, roleCardDocumentFrom, roleCardValuesFrom, roleCardValuesSchema,
} from '../types.ts'
import type { RoleCardDocument } from '../types.ts'

/** Character-card field names in their display order. */
export const ROLE_CARD_FIELDS = ['displayName', 'identity', 'personality', 'values', 'relationship', 'expression', 'boundaries'] as const

type RoleCardField = typeof ROLE_CARD_FIELDS[number]
type RoleCardSettings = Record<string, unknown>

/** Page state projected from the Host settings scope. */
export interface RoleCardState {
  readonly available: boolean
  readonly writable: boolean
  readonly dirty: boolean
  readonly invalid: boolean
  readonly saving: boolean
  readonly failed: boolean
  readonly version: number
  readonly lifecycle: 'active' | 'draft'
  readonly historyLength: number
  readonly history: RoleCardDocument['history']
  readonly preview: string
  readonly fields: Readonly<Record<RoleCardField, SettingsFieldState>>
}

/** Injected face consumed by the character-card Settings component. */
export interface RoleCardInjected {
  readonly hooks: { readonly roleCard: SnapshotStore<RoleCardState> }
  readonly edit: (field: string, text: string) => void
  readonly resetField: (field: string) => void
  readonly save: () => void
  readonly discard: () => void
  readonly rollback: (version: number) => void
}

function ownValue(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.hasOwn(value, field) ? Reflect.get(value, field) : undefined
}

function fieldsFromDraft(draft: RoleCardValues | undefined, snapshot: SettingsFormScopeSnapshot<RoleCardSettings>): RoleCardValues {
  return draft ?? roleCardDocumentFrom(snapshot.value).active
}

function fieldState(
  field: RoleCardField,
  draft: RoleCardValues | undefined,
  snapshot: SettingsFormScopeSnapshot<RoleCardSettings>,
): SettingsFieldState {
  const values = fieldsFromDraft(draft, snapshot)
  const text = values[field]
  if (draft === undefined) {
    const user = snapshot.user
    const overridden = ownValue(user, field) !== undefined || ownValue(user, 'active') !== undefined
    return { text, overridden, invalid: false }
  }
  const parsed = roleCardValuesSchema.safeParse({ ...values, [field]: text })
  return { text, overridden: true, invalid: !parsed.success }
}

function formState(
  draft: RoleCardValues | undefined,
  saving: boolean,
  failed: boolean,
  snapshot: SettingsFormScopeSnapshot<RoleCardSettings>,
): RoleCardState {
  const document = roleCardDocumentFrom(snapshot.value)
  const fields = Object.fromEntries(ROLE_CARD_FIELDS.map(field => [field, fieldState(field, draft, snapshot)])) as RoleCardState['fields']
  const preview = renderRoleCard(fieldsFromDraft(draft, snapshot))
  return {
    available: snapshot.status === 'ready',
    writable: snapshot.writable,
    dirty: draft !== undefined,
    invalid: Object.values(fields).some(field => field.invalid),
    saving,
    failed,
    version: document.activeVersion,
    lifecycle: draft === undefined ? document.lifecycle : 'draft',
    historyLength: document.history.length,
    history: document.history,
    preview,
    fields,
  }
}

/** Create the reactive card controller over the shared Host settings mirror.
 * @param ctx - Client context that owns the shared Settings form mirror.
 * @returns the injected role-card face and its lifecycle disposer.
 */
export function createRoleCardController(ctx: ClientContext): RoleCardInjected & { dispose: () => void } {
  const scope: SettingsFormScope<RoleCardSettings> = ctx.configForms.get<RoleCardSettings>(ROLE_CARD_NAMESPACE)
  let draft: RoleCardValues | undefined
  let baselineRevision: number | undefined
  let saving = false
  let failed = false
  const store = createSnapshotStore(formState(draft, saving, failed, scope.getSnapshot()))
  const publish = (): void => { store.set(formState(draft, saving, failed, scope.getSnapshot())) }

  const persist = async (values: RoleCardValues, changeNote: string): Promise<void> => {
    const snapshot = scope.getSnapshot()
    if (saving || !snapshot.writable) return
    const current = roleCardDocumentFrom(snapshot.value)
    const nextVersion = current.activeVersion + 1
    const history = [...current.history, {
      version: current.activeVersion,
      values: current.active,
      savedAt: Date.now(),
      changeNote,
    }]
    saving = true
    failed = false
    publish()
    try {
      const accepted = await scope.mutate([
        ...ROLE_CARD_FIELDS.map(field => ({ op: 'set' as const, path: [field], value: values[field] })),
        { op: 'set', path: ['schemaVersion'], value: 1 },
        { op: 'set', path: ['activeVersion'], value: nextVersion },
        { op: 'set', path: ['lifecycle'], value: 'active' },
        { op: 'set', path: ['active'], value: values },
        { op: 'set', path: ['history'], value: history },
      ], baselineRevision ?? snapshot.revision)
      if (accepted) {
        draft = undefined
        baselineRevision = undefined
      } else failed = true
    } catch (_error) {
      failed = true
    } finally {
      saving = false
      publish()
    }
  }
  const unsubscribe = scope.subscribe(publish)

  const edit = (field: string, text: string): void => {
    if (!(ROLE_CARD_FIELDS as readonly string[]).includes(field)) throw new Error(`Aevora role-card field is unknown: ${field}`)
    const key = field as RoleCardField
    const snapshot = scope.getSnapshot()
    draft ??= fieldsFromDraft(undefined, snapshot)
    baselineRevision ??= snapshot.revision
    draft = { ...draft, [key]: text }
    failed = false
    publish()
  }

  const resetField = (field: string): void => {
    if (!(ROLE_CARD_FIELDS as readonly string[]).includes(field)) throw new Error(`Aevora role-card field is unknown: ${field}`)
    const key = field as RoleCardField
    const snapshot = scope.getSnapshot()
    draft ??= fieldsFromDraft(undefined, snapshot)
    baselineRevision ??= snapshot.revision
    const base = roleCardValuesFrom(snapshot.base)
    draft = { ...draft, [key]: base[key] }
    failed = false
    publish()
  }

  const save = (): void => {
    void (async () => {
      const snapshot = scope.getSnapshot()
      if (draft === undefined || saving || !snapshot.writable) return
      const parsed = roleCardValuesSchema.safeParse(draft)
      if (!parsed.success) { publish(); return }
      await persist(parsed.data, 'Updated from Aevora role-card Settings')
    })()
  }

  const discard = (): void => {
    draft = undefined
    baselineRevision = undefined
    failed = false
    publish()
  }

  const rollback = (version: number): void => {
    const snapshot = scope.getSnapshot()
    const document = roleCardDocumentFrom(snapshot.value)
    const revision = document.history.find(item => item.version === version)
    if (revision === undefined || saving || !snapshot.writable) return
    draft = undefined
    baselineRevision = snapshot.revision
    void persist(revision.values, `Rolled back to Aevora role-card version ${version}`)
  }

  return {
    hooks: { roleCard: store }, edit, resetField, save, discard, rollback,
    dispose: unsubscribe,
  }
}
