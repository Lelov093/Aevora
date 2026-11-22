/** Persisted fields for the Aevora Identity character card. */

import { z } from 'zod'

/** Settings namespace owned by the Aevora Identity Host plugin. */
export const ROLE_CARD_NAMESPACE = 'aevora-identity'

/** Session record carrying the active role-card snapshot captured for one Agent. */
export const ROLE_CARD_SNAPSHOT_RECORD = 'plugin:aevora-identity/snapshot' as const

/** Role-card fields stored in the existing Host settings document. */
export const roleCardValuesSchema = z.object({
  displayName: z.string().trim().min(1).max(120).default('Aevora'),
  identity: z.string().max(12000).default(''),
  personality: z.string().max(12000).default(''),
  values: z.string().max(12000).default(''),
  relationship: z.string().max(12000).default(''),
  expression: z.string().max(12000).default(''),
  boundaries: z.string().max(12000).default(''),
}).strict()

/** Host-validated character-card values. */
export type RoleCardValues = z.infer<typeof roleCardValuesSchema>

/** Lifecycle state persisted with the role-card document. */
export const roleCardLifecycleSchema = z.enum(['active', 'draft'])

/** One previously active role-card revision retained for audit and rollback. */
export const roleCardRevisionSchema = z.object({
  version: z.number().int().min(1),
  values: roleCardValuesSchema,
  savedAt: z.number().int().nonnegative(),
  changeNote: z.string().max(500),
}).strict()

/** Versioned deployment-level role-card document. */
export const roleCardDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  activeVersion: z.number().int().min(1),
  lifecycle: roleCardLifecycleSchema,
  active: roleCardValuesSchema,
  history: z.array(roleCardRevisionSchema),
}).strict()

/** Versioned role-card document held by the existing Settings namespace. */
export type RoleCardDocument = z.infer<typeof roleCardDocumentSchema>

/** Immutable role-card values captured when a new Agent Session is created. */
export const roleCardSessionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  roleCardVersion: z.number().int().min(1),
  lifecycle: z.literal('active'),
  values: roleCardValuesSchema,
  capturedAt: z.number().int().nonnegative(),
}).strict()

/** Session-owned role-card snapshot exposed by the host Projection service. */
export type RoleCardSessionSnapshot = z.infer<typeof roleCardSessionSnapshotSchema>

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Active Aevora role-card values captured for a newly created Agent Session. */
    'plugin:aevora-identity/snapshot': RoleCardSessionSnapshot
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Current role-card snapshot for an opened Session. */
    aevoraIdentity: RoleCardSessionSnapshot | null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacyRoleCardValues(value: unknown): unknown {
  if (!isRecord(value)) return value
  return Object.fromEntries(['displayName', 'identity', 'personality', 'values', 'relationship', 'expression', 'boundaries']
    .filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]))
}

/** Convert Settings data into the versioned role-card document with legacy fallback.
 * @param value - current Settings descriptor value.
 * @returns versioned active document, migrating legacy top-level fields in memory.
 */
export function roleCardDocumentFrom(value: unknown): RoleCardDocument {
  if (isRecord(value)) {
    const candidate = {
      schemaVersion: value.schemaVersion,
      activeVersion: value.activeVersion,
      lifecycle: value.lifecycle,
      active: value.active,
      history: value.history,
    }
    const parsed = roleCardDocumentSchema.safeParse(candidate)
    if (parsed.success) return parsed.data

    const activeVersion = typeof value.activeVersion === 'number' && Number.isInteger(value.activeVersion) && value.activeVersion >= 1
      ? value.activeVersion : 1
    const lifecycleResult = roleCardLifecycleSchema.safeParse(value.lifecycle)
    const lifecycle = lifecycleResult.success ? lifecycleResult.data : 'active'
    const history = z.array(roleCardRevisionSchema).safeParse(value.history)
    return {
      schemaVersion: 1,
      activeVersion,
      lifecycle,
      active: roleCardValuesFrom(legacyRoleCardValues(value)),
      history: history.success ? history.data : [],
    }
  }
  return {
    schemaVersion: 1,
    activeVersion: 1,
    lifecycle: 'active',
    active: roleCardValuesFrom(legacyRoleCardValues(value)),
    history: [],
  }
}

/** Convert a redacted settings value into a safe role-card projection.
 * @param value - redacted Settings data or an unknown persisted value.
 * @returns validated role-card values, or the documented defaults.
 */
export function roleCardValuesFrom(value: unknown): RoleCardValues {
  const parsed = roleCardValuesSchema.safeParse(value)
  return parsed.success ? parsed.data : roleCardValuesSchema.parse({})
}

/** Render the active role card as one system-prompt section.
 * @param values - validated role-card values.
 * @returns the model-visible prompt section.
 */
export function renderRoleCard(values: RoleCardValues): string {
  const lines = [`You are ${values.displayName}.`]
  const sections: readonly [string, string][] = [
    ['Identity', values.identity],
    ['Personality', values.personality],
    ['Values', values.values],
    ['Relationship', values.relationship],
    ['Expression', values.expression],
    ['Boundaries', values.boundaries],
  ]
  for (const [label, text] of sections) {
    const trimmed = text.trim()
    if (trimmed.length > 0) lines.push(`${label}:\n${trimmed}`)
  }
  return lines.join('\n\n')
}
