/** Convert Session and world read models into immutable, renderer-only coordinates. */

import type { OceanSceneActivationProjection, OceanSceneNodeState, OceanSceneProjection } from '../scene-projection.ts'
import type { ActivationStage, ActivationTraceEvent, ActivationTraceStatus, CognitiveNode, CognitiveWorldSnapshot, ContextFragment, ProvenanceStatus, SourceEvidence } from '../types.ts'
import type { OceanVector3 } from './renderer.ts'
import { qualifyLabels, readableTitle, sourceLabel, type DisplayName, type LabelText } from './display-labels.ts'
import { deriveDisplayLayout } from './display-layout.ts'
import { en, packetLabels, stageLabels } from './locales.ts'
import { regionTokens, type RegionColor } from './scene/visual-tokens.ts'

interface DisplayObject extends DisplayName {
  evidence: ProvenanceStatus
}

/** One region field and its expanded presentation anchor. */
export interface DisplayRegion extends DisplayObject {
  anchor: OceanVector3
  colorToken: RegionColor | undefined
}

/** One recorded neighborhood with its renderer-only center. */
export interface DisplayNeighborhood extends DisplayObject {
  center: OceanVector3
  regionId: string
}

/** One persistent source and the detail available through the world read face. */
export interface DisplaySource extends DisplayObject {
  position: OceanVector3
  regionId: string
  neighborhoodId: string | undefined
  state: OceanSceneNodeState
  detail: CognitiveNode | undefined
  summary: string | undefined
}

/** Recorded request projection keyed to its original Trace sequence. */
export interface DisplayActivation extends DisplayObject {
  position: OceanVector3
  sourceId: string
  stage: ActivationStage
  state: OceanSceneActivationProjection['state']
  eventSeq: number
}

/** Context fragment with independent compilation and submission evidence. */
export interface DisplayFragment extends DisplayObject {
  position: OceanVector3
  sourceRefs: readonly string[]
  order: number
  status: 'compiled' | 'attached' | 'submitted' | 'unknown'
  detail: ContextFragment | undefined
  estimatedTokens: number | undefined
  eventSeq: number | undefined
}

/** Presentation level of a collapsible evidence packet. */
export type PacketLevel = 'source' | 'neighborhood' | 'region' | 'global' | 'context'

/** Presentation-only packet whose parent and sources are stable object IDs. */
export interface DisplayPacket extends DisplayObject {
  position: OceanVector3
  level: PacketLevel
  parentId: string
  sourceRefs: readonly string[]
  detail?: SourceEvidence
}

/** Visual core of the recorded request. */
export interface DisplayCore extends DisplayObject {
  position: OceanVector3
  status: ActivationTraceStatus
}

/** Renderer input for a Session or one of its local recursive views. */
export interface DisplayProjection {
  traceId: string
  layout: { seed: number }
  recursiveView: boolean
  regions: readonly DisplayRegion[]
  neighborhoods: readonly DisplayNeighborhood[]
  sources: readonly DisplaySource[]
  activationProjections: readonly DisplayActivation[]
  contextFragments: readonly DisplayFragment[]
  packets: readonly DisplayPacket[]
  relations: readonly { id: string; fromId: string; toId: string; state: string; evidence: ProvenanceStatus }[]
  traceEvents: readonly ActivationTraceEvent[]
  aggregationCore: DisplayCore
}

const origin: OceanVector3 = [0, 0, 0]

function regionColor(kind: string): RegionColor | undefined {
  return Object.keys(regionTokens).find(key => key === kind) as RegionColor | undefined
}

function neighborhoodLabel(id: string, label: string, t: LabelText) {
  if (id === 'neighborhood:memory:user' && label === 'User Memory') return t('userMemory')
  const workspacePrefix = 'neighborhood:memory:workspace:'
  if (id.startsWith(workspacePrefix) && label === `Workspace Memory · ${id.slice(workspacePrefix.length)}`) return t('workspaceMemory')
  return readableTitle(label, id) ?? t('neighborhood')
}

/**
 * @param scene - Current Session scene.
 * @param world - Shared world read model. Renderer-only callers can supply the scene alone.
 * @param t - Localized object names. Renderer-only callers default to English.
 * @returns The same evidence and identities with readable labels and Temp-pre display coordinates.
 */
export function buildDisplayProjection(scene: OceanSceneProjection, world?: CognitiveWorldSnapshot, t: LabelText = key => en[key]): DisplayProjection {
  const semanticRegions = world?.regions ?? Array.from(new Map(scene.nodes.map(node => [
    node.regionId, { regionId: node.regionId, label: String(node.regionId), kind: 'unknown', layoutAnchor: origin, visibility: 'visible' },
  ])).values())
  const anchors = semanticRegions.map(region => region.layoutAnchor ?? origin)
  const displayAnchors = deriveDisplayLayout(anchors)
  const regions = qualifyLabels(semanticRegions.flatMap((region, index): DisplayRegion[] => {
    if (region.visibility !== 'visible') return []
    const title = region.kind === 'memory' && region.label === 'Memory' ? undefined : readableTitle(region.label, region.regionId)
    return [{
      id: region.regionId, label: title ?? t(region.regionId === 'region:memory' ? 'memoryCluster' : 'region'), colorToken: regionColor(region.kind),
      anchor: displayAnchors[index] ?? origin, evidence: scene.provenanceStatus,
    }]
  }))
  const anchorsById = new Map(semanticRegions.map((region, index) => [String(region.regionId), anchors[index] ?? origin]))
  const displayById = new Map(regions.map(region => [region.id, region]))
  const worldNodes = new Map(world?.nodes.map(node => [String(node.sourceId), node]))
  const counts = new Map<string, number>()
  for (const node of scene.nodes) counts.set(node.regionId, (counts.get(node.regionId) ?? 0) + 1)
  const project = (position: OceanVector3, regionId: string): OceanVector3 => {
    const raw = anchorsById.get(regionId)
    const display = displayById.get(regionId)?.anchor
    if (!raw || !display) return position
    const scale = 1 + Math.min(1.7, Math.max(0, Math.sqrt(counts.get(regionId) ?? 0) - 1) * 0.45)
    return [display[0] + (position[0] - raw[0]) * scale, display[1] + (position[1] - raw[1]) * scale, display[2] + (position[2] - raw[2]) * scale]
  }
  const neighborhoods = qualifyLabels((scene.neighborhoods ?? []).flatMap((item): DisplayNeighborhood[] => displayById.has(item.regionId) ? [{
    id: item.neighborhoodId, regionId: item.regionId, label: neighborhoodLabel(item.neighborhoodId, item.label, t),
    center: project(item.position, item.regionId), evidence: scene.provenanceStatus,
  }] : []), item => displayById.get(item.regionId)?.label)
  const neighborhoodById = new Map(neighborhoods.map(item => [item.id, item]))
  const membership = new Map((scene.neighborhoods ?? []).flatMap(item => item.memberRefs.map(id => [id, item.neighborhoodId] as const)))
  const sources = qualifyLabels(scene.nodes.flatMap((node): DisplaySource[] => {
    if (!displayById.has(node.regionId)) return []
    const detail = worldNodes.get(node.sourceId)
    const summary = node.summary ?? detail?.summary
    const title = readableTitle(node.title, node.sourceId) ?? readableTitle(detail?.title, node.sourceId)
    return [{
      id: node.sourceId, label: sourceLabel(t, detail?.kind ?? node.kind, title, summary), detail, summary,
      regionId: node.regionId, neighborhoodId: detail?.neighborhoodId ?? membership.get(node.sourceId),
      position: project(node.position, node.regionId), state: node.state,
      evidence: detail?.provenanceStatus ?? scene.provenanceStatus,
    }]
  }), item => neighborhoodById.get(item.neighborhoodId ?? '')?.label ?? displayById.get(item.regionId)?.label)
  const sourceById = new Map(sources.map(item => [item.id, item]))
  const traceId = String(scene.aggregationCore.traceId)
  const traceEvents = scene.traceEvents.filter(event => event.traceId === scene.aggregationCore.traceId).toSorted((left, right) => left.eventSeq - right.eventSeq)
  const eventSeqs = new Set(traceEvents.map(event => event.eventSeq))
  const activationProjections = qualifyLabels((scene.activationProjections ?? []).flatMap((item): DisplayActivation[] => {
    const source = sourceById.get(item.sourceId)
    return source && item.traceId === scene.aggregationCore.traceId && eventSeqs.has(item.eventSeq) ? [{
      id: item.projectionId, label: `${t(stageLabels[item.stage])} · ${source.label}`, labelQualifier: source.labelQualifier,
      sourceId: item.sourceId, stage: item.stage,
      position: project(item.position, source.regionId), state: item.state, eventSeq: item.eventSeq, evidence: scene.provenanceStatus,
    }] : []
  }))
  const manifestFragments = new Map(scene.manifest?.fragments.map(item => [item.fragmentId, item]))
  const contextFragments = qualifyLabels((scene.contextFragments ?? []).map((fragment): DisplayFragment => {
    const detail = manifestFragments.get(fragment.fragmentId)
    const event = traceEvents.find(item => item.stage === 'activation.compiled' && fragment.sourceRefs.some(id => item.sourceRefs.includes(id)))
    const fragmentName = `${t('fragment')} ${fragment.order}`
    const source = fragment.sourceRefs.length === 1 ? sourceById.get(fragment.sourceRefs[0]!) : undefined
    return {
      id: fragment.fragmentId, label: source ? `${fragmentName} · ${source.label}` : fragmentName, labelQualifier: source?.labelQualifier,
      order: fragment.order, position: fragment.position,
      sourceRefs: fragment.sourceRefs, status: fragment.status, detail, estimatedTokens: fragment.estimatedTokens,
      evidence: detail?.contentEvidence ?? scene.provenanceStatus, eventSeq: event?.eventSeq,
    }
  }))
  const aggregationCore: DisplayCore = {
    id: `core:${traceId}`, label: t('aggregationCore'), position: scene.aggregationCore.position,
    status: scene.aggregationCore.status, evidence: scene.aggregationCore.provenanceStatus,
  }
  const packets: DisplayPacket[] = []
  const addPacket = (level: PacketLevel, id: string, parentId: string, position: OceanVector3, sourceRefs: readonly string[], evidence: ProvenanceStatus = 'derived', detail?: SourceEvidence) => {
    const packetId = `packet:${level}:${id}`
    packets.push({ id: packetId, label: t(packetLabels[level]), level, parentId, position, sourceRefs, evidence, ...(detail ? { detail } : {}) })
  }
  for (const neighborhood of neighborhoods) {
    addPacket('neighborhood', neighborhood.id, neighborhood.regionId, neighborhood.center, sources.filter(source => source.neighborhoodId === neighborhood.id).map(source => source.id))
  }
  for (const region of regions) {
    addPacket('region', region.id, aggregationCore.id, region.anchor, sources.filter(source => source.regionId === region.id).map(source => source.id))
  }
  addPacket('global', aggregationCore.id, aggregationCore.id, aggregationCore.position, sources.map(source => source.id), aggregationCore.evidence)
  for (const fragment of contextFragments) {
    addPacket('context', fragment.id, aggregationCore.id, fragment.position, fragment.sourceRefs, fragment.evidence)
  }
  for (const source of sources) {
    const evidence = source.detail?.evidence ?? []
    const items = evidence.length > 0 ? evidence : [undefined]
    items.forEach((detail, index) => {
      const angle = index * 1.7 + source.id.length * 0.13
      const radius = 0.16 + (index % 3) * 0.06
      addPacket('source', `${source.id}:evidence:${index + 1}`, source.id, [
        source.position[0] + Math.cos(angle) * radius,
        source.position[1] + Math.sin(angle) * radius,
        source.position[2] + (index % 2 === 0 ? 0.06 : -0.06),
      ], [source.id], detail ? source.evidence : 'unavailable', detail)
    })
  }
  const relationsById = new Map(world?.relations.map(edge => [edge.relationId, edge]))
  const relations = scene.edges.flatMap(edge => {
    const relation = relationsById.get(edge.relationId)
    return sourceById.has(edge.fromId) && sourceById.has(edge.toId) && (!relation || relation.visibility === 'visible') ? [{
      id: edge.relationId, fromId: edge.fromId, toId: edge.toId, state: edge.state,
      evidence: relation?.provenanceStatus ?? scene.provenanceStatus,
    }] : []
  })
  const names = new Map([aggregationCore, ...regions, ...neighborhoods, ...sources, ...contextFragments].map(item => [item.id, item.label]))
  return {
    traceId, layout: { seed: scene.worldVersion || 1 }, recursiveView: false,
    regions, neighborhoods, sources, activationProjections, contextFragments,
    packets: qualifyLabels(packets, item => names.get(item.parentId)), relations, traceEvents, aggregationCore,
  }
}
