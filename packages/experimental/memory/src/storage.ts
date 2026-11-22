/** Durable domain declaration for confirmed Aevora Memory records. */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { memoryItemSchema, type MemoryId, type MemoryItem } from './types.ts'

/** Current durable format version for the confirmed Memory domain. */
export const MEMORY_DOMAIN_VERSION = 1

/** Schema-owned Memory domain; the JSON backend uses one document per record. */
export const memoryDomainSpec = defineDomain({
  name: 'aevora_memory',
  version: MEMORY_DOMAIN_VERSION,
  layout: 'per-record',
  tables: {
    memories: domainTable<MemoryId, MemoryItem>(memoryItemSchema),
  },
})
