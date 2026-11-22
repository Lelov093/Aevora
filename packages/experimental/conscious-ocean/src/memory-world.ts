/** Renderer-neutral world projection derived from the Host-owned Memory snapshot. */

import type { MemoryItem, MemoryRelationKind } from '@deepseek-ai/dsh-experimental-memory'
import { CognitiveSourceId } from './types.ts'
import type { CognitiveRelation, CognitiveWorldSnapshot, SourceEvidence } from './types.ts'

const MEMORY_REGION_ID = CognitiveSourceId('region:memory')

interface MemoryNeighborhood {
  readonly id: ReturnType<typeof CognitiveSourceId>
  readonly label: string
  readonly members: CognitiveSourceId[]
}

function memorySourceId(memoryId: MemoryItem['memoryId']): ReturnType<typeof CognitiveSourceId> {
  return CognitiveSourceId(`memory:${String(memoryId)}`)
}

function evidenceOf(item: MemoryItem): readonly SourceEvidence[] {
  return item.sourceEvidence.map(evidence => ({
    sourceKind: evidence.sourceKind,
    ...(evidence.sessionId === undefined ? {} : { sessionId: evidence.sessionId }),
    ...(evidence.eventSeq === undefined ? {} : { eventSeq: evidence.eventSeq }),
    ...(evidence.observedAt === undefined ? {} : { observedAt: evidence.observedAt }),
  }))
}

function relationKindOf(kind: MemoryRelationKind): CognitiveRelation['kind'] {
  return kind === 'same_entity' || kind === 'part_of' ? 'related_to' : kind
}

function neighborhoodIdOf(item: MemoryItem): ReturnType<typeof CognitiveSourceId> {
  return CognitiveSourceId(item.scope.kind === 'user'
    ? 'neighborhood:memory:user'
    : `neighborhood:memory:workspace:${item.scope.id}`)
}

function nodeStateOf(item: MemoryItem): string {
  if (item.admissionState === 'rejected') return 'rejected'
  if (item.recallState === 'forgotten') return 'forgotten'
  return item.validityState
}

/**
 * Build a read-only cognitive world from one Memory snapshot.
 *
 * The world preserves Memory identity, revision, scope, evidence and relation
 * references. It does not mutate Memory or infer activation state.
 *
 * @param items - Host-owned Memory records.
 * @param worldVersion - monotonically increasing snapshot version.
 * @returns renderer-neutral Memory world projection.
 */
export function buildMemoryCognitiveWorld(
  items: readonly MemoryItem[],
  worldVersion: number,
): CognitiveWorldSnapshot {
  const neighborhoods = new Map<string, MemoryNeighborhood>()
  const nodes = items.map((item) => {
    const neighborhoodId = neighborhoodIdOf(item)
    const neighborhoodKey = String(neighborhoodId)
    const label = item.scope.kind === 'user' ? 'User Memory' : `Workspace Memory · ${item.scope.id}`
    const neighborhood = neighborhoods.get(neighborhoodKey) ?? { id: neighborhoodId, label, members: [] }
    neighborhood.members.push(memorySourceId(item.memoryId))
    neighborhoods.set(neighborhoodKey, neighborhood)
    return {
      sourceId: memorySourceId(item.memoryId),
      kind: `memory:${item.kind}`,
      regionId: MEMORY_REGION_ID,
      neighborhoodId,
      revision: item.revision,
      state: nodeStateOf(item),
      provenanceStatus: item.sourceEvidence.length > 0 ? 'observed' as const : 'unavailable' as const,
      summary: item.content,
      scope: item.scope.kind === 'user' ? 'user' : `workspace:${item.scope.id}`,
      evidence: evidenceOf(item),
      validityState: item.validityState,
      storageTier: item.storageTier,
      recallState: item.recallState,
      deletionState: item.deletionState,
      admissionState: item.admissionState,
      epistemicState: item.epistemicState,
    }
  })
  const relations = items.flatMap(item => (item.relations ?? []).map(relation => ({
    relationId: CognitiveSourceId(`relation:${String(item.memoryId)}:${String(relation.relationId)}`),
    fromId: memorySourceId(item.memoryId),
    toId: memorySourceId(relation.targetMemoryId),
    kind: relationKindOf(relation.kind),
    evidence: relation.sourceEvidence.map(evidence => ({
      sourceKind: evidence.sourceKind,
      ...(evidence.sessionId === undefined ? {} : { sessionId: evidence.sessionId }),
      ...(evidence.eventSeq === undefined ? {} : { eventSeq: evidence.eventSeq }),
      ...(evidence.observedAt === undefined ? {} : { observedAt: evidence.observedAt }),
    })),
    provenanceStatus: 'observed' as const,
    visibility: 'visible' as const,
  })))
  return {
    schemaVersion: 1,
    worldVersion,
    regions: [{
      regionId: MEMORY_REGION_ID,
      kind: 'memory',
      label: 'Memory',
      visibility: 'visible',
      layoutAnchor: [0, 0, 0],
      layoutVersion: 1,
    }],
    neighborhoods: [...neighborhoods.values()].map(value => ({
      neighborhoodId: value.id,
      regionId: MEMORY_REGION_ID,
      label: value.label,
      memberRefs: value.members,
    })),
    nodes,
    relations,
  }
}
