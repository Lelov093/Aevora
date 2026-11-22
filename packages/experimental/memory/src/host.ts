/** Host-owned Memory service and durable domain adapter. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { memoryDomainSpec } from './storage.ts'
import {
  MemoryEvidenceId,
  MemoryId,
  type CandidateMemoryInput,
  type ConfirmedMemoryInput,
  type MemoryConfirmation,
  type MemoryId as MemoryIdType,
  type MemoryItem,
  type MemoryQuery,
  type MemoryUpdate,
} from './types.ts'
import { createMemoryProvider, type MemoryProvider, type MemoryRecordStore } from './provider.ts'

const DEMO_MEMORY_INPUTS: readonly ConfirmedMemoryInput[] = [
  {
    memoryId: MemoryId('aevora-demo-language'), kind: 'fact', content: '用户主要使用中文交流', scope: { kind: 'user' },
    sourceEvidence: [{ evidenceId: MemoryEvidenceId('aevora-demo-language-evidence'), sourceKind: 'user-confirmation', sourceRef: 'aevora-demo', capturedAt: 1, confirmationMethod: 'explicit-user' }], confirmedAt: 1,
  },
  {
    memoryId: MemoryId('aevora-demo-style'), kind: 'preference', content: '用户偏好简洁、直接且可审查的回答', scope: { kind: 'user' },
    sourceEvidence: [{ evidenceId: MemoryEvidenceId('aevora-demo-style-evidence'), sourceKind: 'user-confirmation', sourceRef: 'aevora-demo', capturedAt: 2, confirmationMethod: 'explicit-user' }], confirmedAt: 2,
  },
  {
    memoryId: MemoryId('aevora-demo-constraint'), kind: 'constraint', content: '未经明确授权，不自动向外部服务发送消息', scope: { kind: 'user' },
    sourceEvidence: [{ evidenceId: MemoryEvidenceId('aevora-demo-constraint-evidence'), sourceKind: 'user-confirmation', sourceRef: 'aevora-demo', capturedAt: 3, confirmationMethod: 'explicit-user' }], confirmedAt: 3,
  },
]

/**
 * Create the domain-backed store adapter used by the Host service.
 * @param table - durable Memory table owned by the opened domain.
 * @returns the provider store adapter.
 */
export function createDomainMemoryStore(table: KvTable<MemoryIdType, MemoryItem>): MemoryRecordStore {
  return {
    entries: () => table.entries(),
    get: id => table.get(id),
    put: (id, value) => table.put(id, value),
    delete: id => table.delete(id),
  }
}

/** Host service that owns the durable Memory domain and exposes its provider face. */
export class MemoryService extends TypertRemoteService implements MemoryProvider {
  static inject = ['storageDomain']
  private provider?: MemoryProvider

  constructor(ctx: Context) { super(ctx, 'memory') }

  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(memoryDomainSpec)
    try {
      const table = domain.table('memories')
      for (const [key, item] of table.entries()) {
        if (key !== item.memoryId) {
          throw new Error(`memory: stored key '${key}' differs from record id '${item.memoryId}'`)
        }
      }
      this.provider = createMemoryProvider(createDomainMemoryStore(table))
      if (process.env.AEVORA_DEMO === '1' && this.provider.getSnapshot().length === 0) {
        for (const input of DEMO_MEMORY_INPUTS) await this.provider.createConfirmed(input)
      }
      this.ctx.effect(() => async () => { await domain.close() }, 'memory.domainClose')
    } catch (error) {
      await domain.close()
      throw error
    }
  }

  getSnapshot(): readonly MemoryItem[] { return this.requireProvider().getSnapshot() }
  subscribe(listener: () => void): () => void { return this.requireProvider().subscribe(listener) }
  @Remote
  list(query?: MemoryQuery): readonly MemoryItem[] { return this.requireProvider().list(query) }
  @Remote
  get(id: MemoryIdType): MemoryItem | undefined { return this.requireProvider().get(id) }
  @Remote
  createConfirmed(input: ConfirmedMemoryInput): Promise<MemoryItem> { return this.requireProvider().createConfirmed(input) }
  @Remote
  createCandidate(input: CandidateMemoryInput): Promise<MemoryItem> { return this.requireProvider().createCandidate(input) }
  @Remote
  confirm(id: MemoryIdType, expectedRevision: number, confirmation: MemoryConfirmation): Promise<MemoryItem> {
    return this.requireProvider().confirm(id, expectedRevision, confirmation)
  }
  @Remote
  reject(id: MemoryIdType, expectedRevision: number, reason: string): Promise<MemoryItem> {
    return this.requireProvider().reject(id, expectedRevision, reason)
  }
  @Remote
  update(id: MemoryIdType, expectedRevision: number, change: MemoryUpdate): Promise<MemoryItem> {
    return this.requireProvider().update(id, expectedRevision, change)
  }
  @Remote
  forget(id: MemoryIdType, expectedRevision: number): Promise<MemoryItem> { return this.requireProvider().forget(id, expectedRevision) }
  @Remote
  recall(id: MemoryIdType, expectedRevision: number): Promise<MemoryItem> { return this.requireProvider().recall(id, expectedRevision) }
  @Remote
  setPinned(id: MemoryIdType, expectedRevision: number, pinned: boolean): Promise<MemoryItem> {
    return this.requireProvider().setPinned(id, expectedRevision, pinned)
  }
  @Remote
  delete(id: MemoryIdType, expectedRevision: number): Promise<boolean> { return this.requireProvider().delete(id, expectedRevision) }

  private requireProvider(): MemoryProvider {
    if (this.provider === undefined) throw new Error('memory service is not initialized')
    return this.provider
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned confirmed Memory provider. */
    memory: MemoryService
  }
}
