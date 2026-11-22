/** Renderer-neutral 3D scene projection for the first Conscious Ocean vertical slice. */

import type {
  ActivationTraceEvent,
  ActivationCandidateState,
  ActivationStage,
  ActivationTraceId,
  ActivationTraceStatus,
  CognitiveWorldSnapshot,
  ContextManifest,
  ProvenanceStatus,
} from './types.ts'
import { CognitiveSourceId } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Visual layer supplied by the renderer-independent scene projection. */
export type OceanSceneLayer = 'world' | 'turn'

/** State derived from recorded activation evidence, never from screen distance. */
export type OceanSceneNodeState = 'idle' | 'active' | 'selected' | 'omitted'

/** One renderer-neutral node in the first 3D slice. */
export interface OceanSceneNode {
  readonly sourceId: CognitiveSourceId
  readonly kind: string
  readonly regionId: CognitiveSourceId
  readonly position: readonly [number, number, number]
  readonly layer: OceanSceneLayer
  readonly state: OceanSceneNodeState
  readonly revision?: number
  readonly scope?: string
  readonly evidence?: CognitiveWorldSnapshot['nodes'][number]['evidence']
  readonly title?: string
  readonly summary?: string
}

/** One renderer-neutral relation edge in the first 3D slice. */
export interface OceanSceneEdge {
  readonly relationId: CognitiveSourceId
  readonly fromId: CognitiveSourceId
  readonly toId: CognitiveSourceId
  readonly kind: string
  readonly state: 'dormant' | 'active'
}

/** One semantic neighborhood rendered as a structured star cluster. */
export interface OceanSceneNeighborhood {
  readonly neighborhoodId: CognitiveSourceId
  readonly regionId: CognitiveSourceId
  readonly label: string
  readonly memberRefs: readonly CognitiveSourceId[]
  readonly position: readonly [number, number, number]
}

/** One recorded source projection for the current Activation Trace. */
export interface OceanSceneActivationProjection {
  readonly projectionId: CognitiveSourceId
  readonly traceId: ActivationTraceId
  readonly sourceId: CognitiveSourceId
  readonly eventSeq: number
  readonly stage: ActivationStage
  readonly state: ActivationCandidateState | 'observed'
  readonly position: readonly [number, number, number]
}

/** One recorded Trace event positioned in the request space. */
export interface OceanSceneTraceEvent {
  readonly eventSeq: number
  readonly stage: ActivationStage
  readonly sourceRefs: readonly CognitiveSourceId[]
  readonly position: readonly [number, number, number]
  readonly candidateState?: ActivationCandidateState
  readonly reasonCode?: string
}

/** One ordered Context Manifest fragment positioned around the request core. */
export interface OceanSceneContextFragment {
  readonly fragmentId: string
  readonly order: number
  readonly sourceRefs: readonly CognitiveSourceId[]
  readonly position: readonly [number, number, number]
  readonly status: 'compiled' | 'attached' | 'submitted' | 'unknown'
  readonly estimatedTokens?: number
}

/** Current request core positioned from the recorded scene evidence. */
export interface OceanAggregationCore {
  readonly status: ActivationTraceStatus
  readonly traceId: ActivationTraceId
  readonly position: readonly [number, number, number]
  readonly manifestId?: ContextManifest['manifestId']
  readonly fragmentCount: number
  readonly provenanceStatus: ProvenanceStatus
}

/** Session/Turn input consumed by the renderer-neutral scene builder. */
export interface OceanTurnOverlay {
  readonly sessionId: SessionId
  readonly traceId: ActivationTraceId
  readonly status: ActivationTraceStatus
  readonly events: readonly ActivationTraceEvent[]
  readonly manifest?: ContextManifest
}

/** Complete first-slice scene data; no WebGL, canvas, or renderer dependency. */
export interface OceanSceneProjection {
  readonly worldVersion: number
  readonly nodes: readonly OceanSceneNode[]
  readonly neighborhoods?: readonly OceanSceneNeighborhood[]
  readonly activationProjections?: readonly OceanSceneActivationProjection[]
  readonly traceEventObjects?: readonly OceanSceneTraceEvent[]
  readonly contextFragments?: readonly OceanSceneContextFragment[]
  readonly edges: readonly OceanSceneEdge[]
  readonly traceEvents: readonly ActivationTraceEvent[]
  readonly manifest?: ContextManifest
  readonly aggregationCore: OceanAggregationCore
  readonly provenanceStatus: ProvenanceStatus
}

function regionPosition(world: CognitiveWorldSnapshot, regionId: CognitiveSourceId): readonly [number, number, number] {
  const anchor = world.regions.find(region => region.regionId === regionId)?.layoutAnchor
  return anchor ?? [0, 0, 0]
}

function neighborhoodPosition(
  world: CognitiveWorldSnapshot,
  neighborhoodId: CognitiveSourceId,
  regionId: CognitiveSourceId,
): readonly [number, number, number] {
  const anchor = regionPosition(world, regionId)
  const neighborhoodIndex = Math.max(world.neighborhoods.findIndex(item => item.neighborhoodId === neighborhoodId), 0)
  const neighborhoodCount = Math.max(world.neighborhoods.filter(item => item.regionId === regionId).length, 1)
  const angle = (neighborhoodIndex / neighborhoodCount) * Math.PI * 2 - Math.PI / 2
  const radius = neighborhoodCount === 1 ? 0 : 0.42
  return [
    anchor[0] + Math.cos(angle) * radius,
    anchor[1] + Math.sin(angle) * radius,
    anchor[2] + (neighborhoodIndex % 2 === 0 ? -0.04 : 0.04),
  ]
}

function nodePosition(
  world: CognitiveWorldSnapshot,
  sourceId: CognitiveSourceId,
  regionId: CognitiveSourceId,
  fallbackIndex: number,
): readonly [number, number, number] {
  const neighborhood = world.neighborhoods.find(item => item.memberRefs.includes(sourceId))
  const anchor = neighborhood === undefined
    ? regionPosition(world, regionId)
    : neighborhoodPosition(world, neighborhood.neighborhoodId, regionId)
  const memberIndex = neighborhood === undefined
    ? fallbackIndex
    : Math.max(neighborhood.memberRefs.indexOf(sourceId), 0)
  const memberCount = Math.max(neighborhood?.memberRefs.length ?? world.nodes.length, 1)
  const angle = (memberIndex / memberCount) * Math.PI * 2
  const radius = 0.24 + (memberIndex % 3) * 0.08
  return [
    anchor[0] + Math.cos(angle) * radius,
    anchor[1] + Math.sin(angle) * radius,
    anchor[2] + ((memberIndex % 2) === 0 ? -0.08 : 0.08),
  ]
}

function eventSourceIds(overlay: OceanTurnOverlay): ReadonlySet<CognitiveSourceId> {
  const ids = new Set<CognitiveSourceId>()
  for (const event of overlay.events) for (const sourceId of event.sourceRefs) ids.add(sourceId)
  return ids
}

function omittedSourceIds(overlay: OceanTurnOverlay): ReadonlySet<CognitiveSourceId> {
  const ids = new Set<CognitiveSourceId>()
  for (const event of overlay.events) {
    if (event.candidateState !== 'omitted') continue
    for (const sourceId of event.sourceRefs) ids.add(sourceId)
  }
  return ids
}

function selectedSourceIds(manifest: ContextManifest | undefined): ReadonlySet<CognitiveSourceId> {
  return new Set(manifest?.fragments.flatMap(fragment => fragment.sourceRefs) ?? [])
}

function midpoint(positions: readonly (readonly [number, number, number])[]): readonly [number, number, number] {
  if (positions.length === 0) return [0, 0, 0]
  return [
    positions.reduce((sum, position) => sum + position[0], 0) / positions.length,
    positions.reduce((sum, position) => sum + position[1], 0) / positions.length,
    positions.reduce((sum, position) => sum + position[2], 0) / positions.length,
  ]
}

function projectedPosition(
  sourcePosition: readonly [number, number, number],
  eventIndex: number,
  eventCount: number,
): readonly [number, number, number] {
  const progress = Math.min(0.86, (eventIndex + 1) / Math.max(eventCount + 1, 2))
  const lane = (eventIndex % 3 - 1) * 0.14
  return [
    sourcePosition[0] * (1 - progress) + lane * progress,
    sourcePosition[1] * (1 - progress) - lane * 0.55 * progress,
    sourcePosition[2] * (1 - progress) + (eventIndex % 2 === 0 ? -0.1 : 0.1),
  ]
}

function fragmentStatus(fragment: ContextManifest['fragments'][number]): OceanSceneContextFragment['status'] {
  if (fragment.submitted === 'yes') return 'submitted'
  if (fragment.attached === 'yes') return 'attached'
  if (fragment.compiled) return 'compiled'
  return 'unknown'
}

function aggregationCorePosition(
  traceId: ActivationTraceId,
  nodes: readonly OceanSceneNode[],
  activationProjections: readonly OceanSceneActivationProjection[],
  traceEventObjects: readonly OceanSceneTraceEvent[],
  contextFragments: readonly OceanSceneContextFragment[],
): readonly [number, number, number] {
  const projectionPositions = activationProjections
    .filter(projection => projection.state !== 'omitted')
    .map(projection => projection.position)
  if (projectionPositions.length > 0) return sparseCoreOffset(midpoint(projectionPositions), traceId, nodes, projectionPositions.length > 0)
  const eventPositions = traceEventObjects
    .filter(event => event.sourceRefs.length > 0)
    .map(event => event.position)
  if (eventPositions.length > 0) return sparseCoreOffset(midpoint(eventPositions), traceId, nodes, true)
  const activeNodePositions = nodes
    .filter(node => node.state === 'active' || node.state === 'selected')
    .map(node => node.position)
  if (activeNodePositions.length > 0) return sparseCoreOffset(midpoint(activeNodePositions), traceId, nodes, true)
  if (contextFragments.length > 0) {
    return sparseCoreOffset(midpoint(contextFragments.map(fragment => fragment.position)), traceId, nodes, true)
  }
  return sparseCoreOffset(midpoint(nodes.map(node => node.position)), traceId, nodes, nodes.length > 0)
}

function sparseCoreOffset(
  position: readonly [number, number, number],
  traceId: ActivationTraceId,
  nodes: readonly OceanSceneNode[],
  hasEvidence: boolean,
): readonly [number, number, number] {
  if (!hasEvidence) return position
  const spread = Math.abs(position[0]) + Math.abs(position[1]) + Math.abs(position[2])
  if (spread > 0.08) return position
  const seed = Array.from(String(traceId)).reduce((sum, character) => sum + character.charCodeAt(0), 0)
  const angle = (seed % 360) * Math.PI / 180
  const lift = 0.1 + Math.min(nodes.length, 4) * 0.02
  return [position[0] + Math.cos(angle) * 0.32, position[1] + Math.sin(angle) * 0.24, position[2] + lift]
}

/**
 * Build the first 3D scene projection from a shared world and recorded Turn evidence.
 *
 * The function deliberately ignores distance, color, and renderer state when it
 * decides whether a node or edge is active. Only recorded Trace and Manifest
 * references can change a node state.
 *
 * @param world - shared cross-Session cognitive map.
 * @param overlay - current Session/Turn activation evidence.
 * @returns stable scene data ready for a future renderer adapter.
 */
export function buildOceanSceneProjection(
  world: CognitiveWorldSnapshot,
  overlay: OceanTurnOverlay,
): OceanSceneProjection {
  const activeIds = eventSourceIds(overlay)
  const omittedIds = omittedSourceIds(overlay)
  const selectedIds = selectedSourceIds(overlay.manifest)
  const nodes = world.nodes.map((node, index) => ({
    sourceId: node.sourceId,
    kind: node.kind,
    regionId: node.regionId,
    position: nodePosition(world, node.sourceId, node.regionId, index),
    layer: 'world' as const,
    state: selectedIds.has(node.sourceId)
      ? 'selected' as const
      : omittedIds.has(node.sourceId)
        ? 'omitted' as const
        : activeIds.has(node.sourceId)
          ? 'active' as const
          : 'idle' as const,
    revision: node.revision,
    ...(node.scope === undefined ? {} : { scope: node.scope }),
    ...(node.evidence === undefined ? {} : { evidence: node.evidence }),
    ...(node.title === undefined ? {} : { title: node.title }),
    ...(node.summary === undefined ? {} : { summary: node.summary }),
  }))
  const edges = world.relations.map(relation => ({
    relationId: relation.relationId,
    fromId: relation.fromId,
    toId: relation.toId,
    kind: relation.kind,
    state: activeIds.has(relation.fromId) && activeIds.has(relation.toId) ? 'active' as const : 'dormant' as const,
  }))
  const nodePositions = new Map(nodes.map(node => [String(node.sourceId), node.position] as const))
  const neighborhoods = world.neighborhoods.map((neighborhood) => {
    const positions = neighborhood.memberRefs.flatMap((memberRef) => {
      const position = nodePositions.get(String(memberRef))
      return position === undefined ? [] : [position]
    })
    const position = positions.length === 0
      ? regionPosition(world, neighborhood.regionId)
      : [
        positions.reduce((sum, value) => sum + value[0], 0) / positions.length,
        positions.reduce((sum, value) => sum + value[1], 0) / positions.length,
        positions.reduce((sum, value) => sum + value[2], 0) / positions.length,
      ] as const
    return {
      neighborhoodId: neighborhood.neighborhoodId,
      regionId: neighborhood.regionId,
      label: neighborhood.label,
      memberRefs: neighborhood.memberRefs,
      position,
    }
  })
  const sourcePositions = new Map(nodes.map(node => [String(node.sourceId), node.position] as const))
  const activationProjections = overlay.events.flatMap((event, eventIndex) => event.sourceRefs.flatMap((sourceId) => {
    const sourcePosition = sourcePositions.get(String(sourceId))
    if (sourcePosition === undefined) return []
    return [{
      projectionId: CognitiveSourceId(`projection:${String(overlay.traceId)}:${String(event.eventSeq)}:${String(sourceId)}`),
      traceId: overlay.traceId,
      sourceId,
      eventSeq: event.eventSeq,
      stage: event.stage,
      state: event.candidateState ?? 'observed' as const,
      position: projectedPosition(sourcePosition, eventIndex, overlay.events.length),
    }]
  }))
  const traceEventObjects = overlay.events.map((event, eventIndex) => ({
    eventSeq: event.eventSeq,
    stage: event.stage,
    sourceRefs: event.sourceRefs,
    position: midpoint(event.sourceRefs.flatMap((sourceId) => {
      const position = sourcePositions.get(String(sourceId))
      return position === undefined ? [] : [projectedPosition(position, eventIndex, overlay.events.length)]
    })),
    ...(event.candidateState === undefined ? {} : { candidateState: event.candidateState }),
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
  }))
  const contextFragments = (overlay.manifest?.fragments ?? []).map((fragment) => {
    const angle = ((fragment.order - 1) / Math.max(overlay.manifest?.fragments.length ?? 1, 1)) * Math.PI * 2
    const radius = 0.38 + ((fragment.order - 1) % 2) * 0.09
    return {
      fragmentId: fragment.fragmentId,
      order: fragment.order,
      sourceRefs: fragment.sourceRefs,
      position: [Math.cos(angle) * radius, Math.sin(angle) * radius, 0.12 + (fragment.order % 2) * 0.04] as const,
      status: fragmentStatus(fragment),
      ...(fragment.estimatedTokens === undefined ? {} : { estimatedTokens: fragment.estimatedTokens }),
    }
  })
  const corePosition = aggregationCorePosition(overlay.traceId, nodes, activationProjections, traceEventObjects, contextFragments)
  return {
    worldVersion: world.worldVersion,
    nodes,
    neighborhoods,
    activationProjections,
    traceEventObjects,
    contextFragments,
    edges,
    traceEvents: overlay.events,
    ...(overlay.manifest === undefined ? {} : { manifest: overlay.manifest }),
    aggregationCore: {
      status: overlay.status,
      traceId: overlay.traceId,
      position: corePosition,
      ...(overlay.manifest === undefined ? {} : { manifestId: overlay.manifest.manifestId }),
      fragmentCount: overlay.manifest?.fragments.length ?? 0,
      provenanceStatus: overlay.events.length > 0 ? 'derived' : 'unavailable',
    },
    provenanceStatus: overlay.events.length > 0 ? 'derived' : 'unavailable',
  }
}
