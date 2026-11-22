/** Aevora Identity Host service, versioned role-card document, and Session snapshot. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { roleCardProjection } from './projection.ts'
import {
  ROLE_CARD_NAMESPACE, ROLE_CARD_SNAPSHOT_RECORD, renderRoleCard, roleCardDocumentFrom,
  roleCardSessionSnapshotSchema, type RoleCardDocument, type RoleCardSessionSnapshot,
} from './types.ts'
import { RoleCardConfig } from './role-card.ts'

/** Cordis plugin name. */
export const name = 'aevora-identity'

/** Host services required for Settings, prompt assembly, Session snapshots, and Agent lifecycle. */
export const inject = ['settings', 'systemPrompt', 'sessionProjections', 'agents']

/** Host configuration schema exposed through the Settings namespace. */
export const Config = RoleCardConfig

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Aevora Identity service owning the active role card and Session snapshot Projection. */
    aevoraIdentity: AevoraIdentityService
  }
}

/** Owns the Aevora role-card Settings document and its Session snapshot Projection. */
export class AevoraIdentityService extends Service {
  static inject = inject
  static Config = RoleCardConfig

  private projection!: ProjectionHandle<import('./projection.ts').RoleCardProjectionState>

  /**
   * @param ctx - Host context that owns the existing DSH services.
   * @param config - resolved role-card Settings configuration.
   */
  constructor(ctx: Context, _config: RoleCardConfig) {
    super(ctx, 'aevoraIdentity')
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(roleCardProjection)
    this.ctx.effect(() => this.ctx.settings.configure({ auto: false }, this.ctx.fiber), 'aevora-identity: settings presentation')
    this.ctx.effect(() => this.ctx.systemPrompt.section({
      name: 'aevora:identity',
      order: this.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') - 1,
      text: (context: AssembleContext) => renderRoleCard(this.valuesForPrompt(context)),
    }), 'aevora-identity: system prompt')
    this.ctx.on('agent/created', ({ agent, source }) => {
      if (source !== 'startup' && source !== 'clear') return
      appendPluginRecord(agent.session, ROLE_CARD_SNAPSHOT_RECORD, this.captureSnapshot())
    })
  }

  /** Read the active versioned document from the existing Settings service.
   * @returns the active role-card document, with legacy fields migrated in memory.
   */
  activeDocument(): RoleCardDocument {
    const descriptor = this.ctx.settings.describe().find(item => String(item.ns) === ROLE_CARD_NAMESPACE)
    return roleCardDocumentFrom(descriptor?.value)
  }

  /** Read the immutable role-card snapshot captured for one Session.
   * @param session - Session whose Projection is read.
   * @returns captured snapshot, or undefined before a creation snapshot exists.
   */
  snapshotOf(session: Session): RoleCardSessionSnapshot | undefined {
    return this.projection.stateOf(session).snapshot ?? undefined
  }

  /** Capture the current active role-card version for a newly created Session.
   * @returns validated immutable Session snapshot payload.
   */
  captureSnapshot(): RoleCardSessionSnapshot {
    const document = this.activeDocument()
    return roleCardSessionSnapshotSchema.parse({
      schemaVersion: 1,
      roleCardVersion: document.activeVersion,
      lifecycle: 'active',
      values: document.active,
      capturedAt: Date.now(),
    })
  }

  private valuesForPrompt(context: AssembleContext) {
    const agent = this.agentForScope(context.scope)
    const snapshot = agent === undefined ? undefined : this.snapshotOf(agent.session)
    return snapshot?.values ?? this.activeDocument().active
  }

  private agentForScope(scope: object | undefined): Agent | undefined {
    if (scope === undefined) return undefined
    return this.ctx.agents.list().find(agent => agent === scope)
  }
}

export type { RoleCardValues } from './types.ts'
export {
  ROLE_CARD_NAMESPACE, ROLE_CARD_SNAPSHOT_RECORD, renderRoleCard, roleCardDocumentFrom,
  roleCardValuesFrom, roleCardValuesSchema, roleCardSessionSnapshotSchema,
} from './types.ts'
export type { RoleCardDocument, RoleCardSessionSnapshot } from './types.ts'
export { RoleCardConfig } from './role-card.ts'

export default AevoraIdentityService
