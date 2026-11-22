/** Host configuration schema for the editable Aevora character card. */

import z from '@deepseek-ai/schemastery'
import type { RoleCardValues } from './types.ts'

/** Schemastery configuration shape used by the Settings service. */
export interface RoleCardConfig extends RoleCardValues {
  readonly schemaVersion: number
  readonly activeVersion: number
  readonly lifecycle: 'active' | 'draft'
  readonly active: RoleCardValues
  readonly history: readonly {
    readonly version: number
    readonly values: RoleCardValues
    readonly savedAt: number
    readonly changeNote: string
  }[]
}

const roleCardFields = {
  displayName: z.string().min(1).max(120).default('Aevora'),
  identity: z.string().max(12000).default(''),
  personality: z.string().max(12000).default(''),
  values: z.string().max(12000).default(''),
  relationship: z.string().max(12000).default(''),
  expression: z.string().max(12000).default(''),
  boundaries: z.string().max(12000).default(''),
}

/** Versioned role-card Settings document. Legacy top-level fields remain readable for migration. */
export const RoleCardConfig = z.object({
  ...roleCardFields,
  schemaVersion: z.number().step(1).min(1).default(1),
  activeVersion: z.number().step(1).min(1).default(1),
  lifecycle: z.union(['active', 'draft'] as const).default('active'),
  active: z.object(roleCardFields).default({}),
  history: z.array(z.object({
    version: z.number().step(1).min(1),
    values: z.object(roleCardFields),
    savedAt: z.number().min(0),
    changeNote: z.string().max(500),
  })).default([]),
}).set('schemaVersion', z.number().step(1).min(1).default(1).volatile())
  .set('activeVersion', z.number().step(1).min(1).default(1).volatile())
  .set('lifecycle', z.union(['active', 'draft'] as const).default('active').volatile())
  .set('active', z.object(roleCardFields).default({}).volatile())
  .set('history', z.array(z.object({
    version: z.number().step(1).min(1),
    values: z.object(roleCardFields),
    savedAt: z.number().min(0),
    changeNote: z.string().max(500),
  })).default([]).volatile())
  .set('displayName', roleCardFields.displayName.volatile())
  .set('identity', roleCardFields.identity.volatile())
  .set('personality', roleCardFields.personality.volatile())
  .set('values', roleCardFields.values.volatile())
  .set('relationship', roleCardFields.relationship.volatile())
  .set('expression', roleCardFields.expression.volatile())
  .set('boundaries', roleCardFields.boundaries.volatile())
