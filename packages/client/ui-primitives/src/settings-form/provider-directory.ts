/** Named provider profiles edited through native configuration forms and write-only credentials. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  SettingsFormModel, settingsTextField,
  type SettingsFieldSpec, type SettingsFormScope, type SettingsFieldState, type SettingsFormShell,
} from './form-model.ts'

/** Non-secret fields persisted for one provider configuration. */
export interface SettingsProviderProfile {
  name: string
  apiKeyEnv: string
  [field: string]: string | number
}

/** Namespace containing independently named provider profiles. */
export interface SettingsProviderProfiles { profiles?: Record<string, SettingsProviderProfile> }

/** Editable field and its locale-owned presentation. */
export interface SettingsProviderField extends SettingsFieldSpec {
  label: () => string
  hint: () => string
  numeric?: boolean
}

/** Installed adapter family; defaults contain no credentials. */
export interface SettingsProviderFamily {
  id: string
  label: string
  scope: SettingsFormScope<SettingsProviderProfiles>
  defaults: Record<string, string | number>
  fields: SettingsProviderField[]
}

/** One saved profile and confirmed credential presence. */
export interface SettingsProviderRow {
  id: string
  key: string
  family: SettingsProviderFamily
  profile: SettingsProviderProfile
  credential: { configured: boolean; writable: boolean } | undefined
  writable: boolean
  removable: boolean
}

/** The staged editor, including native form state. */
export interface SettingsProviderEditorState extends SettingsFormShell {
  family: SettingsProviderFamily
  name: SettingsFieldState
  fields: { spec: SettingsProviderField; state: SettingsFieldState }[]
  apiKey: SettingsFieldState
  credential: { configured: boolean; writable: boolean } | undefined
}

/** Shared directory state, excluding secret values after an accepted save. */
export interface SettingsProviderDirectoryState {
  rows: SettingsProviderRow[]
  selected: string
  busy: boolean
  editor: SettingsProviderEditorState | undefined
  families: { id: string; label: string; available: boolean }[]
}

/** Host configuration and credential operations supplied by the owning feature. */
export interface SettingsProviderDirectoryOptions {
  families: SettingsProviderFamily[]
  selection: SettingsFormScope<object>
  selected: () => string
  select: (id: string) => Promise<boolean>
  fallback: string
  credentialPrefix: string
  describeKey: (ref: string) => Promise<{ configured: boolean; writable: boolean } | undefined>
  writeKey: (ref: string, text: string) => Promise<boolean>
}

interface Editor {
  key: string
  family: SettingsProviderFamily
  form: SettingsFormModel<SettingsProviderProfile>
  ref: string
  off: () => void
}

/** Reuses revision-fenced forms for add, edit, select and remove operations. */
export class SettingsProviderDirectory {
  /** Saved rows and the current editor. */
  readonly state = createSnapshotStore<SettingsProviderDirectoryState>({ rows: [], selected: '', busy: false, editor: undefined, families: [] })
  /** Transient outcomes observed by a feature's root overlay. */
  readonly feedback = createSnapshotStore<{ sequence: number; kind: 'saved' | 'removed' | 'selected' | 'failed' } | null>(null)
  private editor: Editor | undefined
  private readonly credentials = new Map<string, { configured: boolean; writable: boolean } | undefined>()
  private readonly off: (() => void)[]
  private disposed = false
  private generation = 0
  private sequence = 0
  private busy = false

  constructor(private readonly options: SettingsProviderDirectoryOptions) {
    const publish = () => { this.publish(); void this.refresh() }
    this.off = [options.selection, ...options.families.map(family => family.scope)].map(scope => scope.subscribe(publish))
    publish()
  }

  private rows(): SettingsProviderRow[] {
    return this.options.families.flatMap((family) => {
      const snapshot = family.scope.getSnapshot()
      const base = snapshot.base as { profiles?: Record<string, SettingsProviderProfile> } | undefined
      return Object.entries(snapshot.value?.profiles ?? {}).map(([key, profile]) => ({
        id: `${family.id}:${key}`, key, family, profile, credential: this.credentials.get(profile.apiKeyEnv),
        writable: snapshot.writable, removable: !Object.hasOwn(base?.profiles ?? {}, key),
      }))
    })
  }

  private publish(): void {
    if (this.disposed) return
    const editor = this.editor
    this.state.set({ rows: this.rows(), selected: this.options.selected(), busy: this.busy,
      families: this.options.families.map(family => ({ id: family.id, label: family.label,
        available: family.scope.getSnapshot().status === 'ready' && family.scope.getSnapshot().writable })),
      editor: editor === undefined ? undefined : { ...editor.form.shell(),
        invalid: editor.form.shell().invalid || !editor.form.field('name').text.trim(), family: editor.family,
        name: editor.form.field('name'), fields: editor.family.fields.map(spec => ({ spec, state: editor.form.field(spec.field) })),
        apiKey: editor.form.field('apiKey'), credential: this.credentials.get(editor.ref) } })
  }

  /** Refresh credential presence without reading keys or contacting providers. */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    const refs = [...new Set([...this.rows().map(row => row.profile.apiKeyEnv), ...this.editor === undefined ? [] : [this.editor.ref]])]
    const values = await Promise.all(refs.map(async (ref) => {
      try { return [ref, await this.options.describeKey(ref)] as const }
      catch (_unavailableCredential) { return [ref, undefined] as const }
    }))
    if (this.disposed || generation !== this.generation) return
    for (const [ref, value] of values) this.credentials.set(ref, value)
    this.publish()
  }

  /**
   * Open one saved configuration or a new adapter-specific draft.
   * @param familyId - installed adapter family.
   * @param key - saved profile key; omitted creates an independent profile.
   */
  open(familyId: string, key?: string): void {
    if (this.busy || this.editor?.form.shell().saving) return
    this.cancel()
    const family = this.options.families.find(item => item.id === familyId)
    if (family === undefined) throw new Error(`Unavailable provider family: ${familyId}`)
    const profileKey = key ?? randomUUID().replaceAll('-', '')
    const existing = family.scope.getSnapshot().value?.profiles?.[profileKey]
    const ref = existing?.apiKeyEnv ?? `${this.options.credentialPrefix}_${profileKey.toUpperCase()}_API_KEY`
    const initial: SettingsProviderProfile = { ...family.defaults, name: '', apiKeyEnv: ref, ...existing }
    const scope: SettingsFormScope<SettingsProviderProfile> = {
      getSnapshot: () => {
        const root = family.scope.getSnapshot(), value = root.value?.profiles?.[profileKey] ?? initial
        return { ...root, value, base: initial, user: root.value?.profiles?.[profileKey] ?? {} }
      },
      subscribe: listener => family.scope.subscribe(listener),
      mutate: async (ops, revision) => {
        const value: SettingsProviderProfile = { ...initial, ...family.scope.getSnapshot().value?.profiles?.[profileKey] }
        for (const op of ops) {
          const field = op.path[0]
          if (field === undefined) throw new Error('Provider field is required')
          if (op.op === 'unset') Reflect.deleteProperty(value, field)
          else if (typeof op.value === 'string' || typeof op.value === 'number') value[field] = op.value
          else throw new Error('Provider fields must be text or numbers')
        }
        return family.scope.mutate([{ op: 'set', path: ['profiles', profileKey], value }], revision)
      },
    }
    const name = { ...settingsTextField('name'), parse: (text: string) => text.trim() ? { kind: 'set' as const, value: text.trim() } : undefined }
    const form = new SettingsFormModel(scope, [name, ...family.fields], [{ field: 'apiKey', write: text => this.options.writeKey(ref, text) }])
    this.editor = { key: profileKey, family, form, ref, off: form.bind(() => form.shell()).subscribe(() => { this.publish() }) }
    this.publish()
    void this.refresh()
  }

  /**
   * Stage one native form field.
   * @param field - declared field name, or the write-only API key.
   * @param text - user-entered draft.
   */
  edit(field: string, text: string): void { this.editor?.form.actions().edit(field, text) }

  /** Save the current profile; rejected writes retain its editable draft. */
  async save(): Promise<void> {
    const editor = this.editor
    if (editor === undefined) return
    if (!editor.form.field('name').text.trim()) return
    await editor.form.save()
    if (this.editor !== editor || editor.form.shell().failed || editor.form.shell().dirty) return
    this.cancel()
    this.report('saved')
    await this.refresh()
  }

  /** Close the draft without saving; an in-flight save keeps its owner. */
  cancel(): void {
    if (this.editor?.form.shell().saving) return
    this.editor?.off(); this.editor?.form.dispose(); this.editor = undefined
    this.publish()
  }

  /**
   * Select a saved provider without probing its external service.
   * @param id - stable execution id, or the feature's built-in route.
   */
  async select(id: string): Promise<void> {
    if (this.busy) return
    this.busy = true; this.publish()
    try { this.report(await this.options.select(id) ? 'selected' : 'failed') }
    catch (_selectionFailed) { this.report('failed') }
    finally { this.busy = false; this.publish() }
  }

  /**
   * Remove one user profile after the UI's explicit confirmation; retain its credential.
   * @param id - saved execution id.
   */
  async remove(id: string): Promise<void> {
    if (this.busy) return
    const row = this.rows().find(item => item.id === id)
    if (row === undefined || !row.removable || !row.writable) return
    this.busy = true; this.publish()
    const revision = row.family.scope.getSnapshot().revision
    try {
      if (this.options.selected() === id && !await this.options.select(this.options.fallback)) { this.report('failed'); return }
      const accepted = await row.family.scope.mutate([{ op: 'unset', path: ['profiles', row.key] }], revision)
      if (accepted && this.editor?.family.id === row.family.id && this.editor.key === row.key) this.cancel()
      this.report(accepted ? 'removed' : 'failed')
    } catch (_removalFailed) { this.report('failed') }
    finally { this.busy = false; this.publish() }
  }

  private report(kind: 'saved' | 'removed' | 'selected' | 'failed'): void {
    if (!this.disposed) this.feedback.set({ sequence: ++this.sequence, kind })
  }

  /**
   * Dismiss a root-owned outcome without hiding a later one.
   * @param sequence - outcome being dismissed.
   */
  dismiss(sequence: number): void { if (this.feedback.getSnapshot()?.sequence === sequence) this.feedback.set(null) }

  /** Release observations and prevent late credential replies from publishing. */
  dispose(): void {
    this.disposed = true; ++this.generation
    for (const off of this.off) off()
    this.editor?.off(); this.editor?.form.dispose(); this.editor = undefined
  }
}
