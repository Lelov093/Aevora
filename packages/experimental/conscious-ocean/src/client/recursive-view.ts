/** Recursive Temp-pre layout for one read-only display projection. */

import type { DisplayActivation, DisplayCore, DisplayFragment, DisplayNeighborhood, DisplayPacket, DisplayProjection, DisplayRegion, DisplaySource } from './display-projection.ts'
import type { OceanVector3 } from './renderer.ts'

type DescriptorData =
  | { kind: 'aggregation-core'; item: DisplayCore }
  | { kind: 'region'; item: DisplayRegion }
  | { kind: 'neighborhood'; item: DisplayNeighborhood }
  | { kind: 'source'; item: DisplaySource }
  | { kind: 'projection'; item: DisplayActivation }
  | { kind: 'fragment'; item: DisplayFragment }
  | { kind: 'packet'; item: DisplayPacket }

/** Indexed object and its local navigation links. */
export type OceanDescriptor = DescriptorData & { id: string; parentId: string | undefined; childIds: string[]; relatedIds: string[] }

/**
 * @param projection - Full scene for the active Session.
 * @returns Canonical IDs and parent, child and related object records for traversal.
 */
export function buildRecursiveIndex(projection: DisplayProjection) {
  const descriptors = new Map<string, OceanDescriptor>()
  const rootId = projection.aggregationCore.id
  const add = (data: DescriptorData, parentId?: string) => {
    const id = data.item.id
    const parent = parentId === undefined ? undefined : descriptors.get(parentId) ?? descriptors.get(rootId)
    descriptors.set(id, { ...data, id, parentId: parent?.id, childIds: [], relatedIds: [] })
    parent?.childIds.push(id)
  }
  add({ kind: 'aggregation-core', item: projection.aggregationCore })
  for (const item of projection.regions) add({ kind: 'region', item }, rootId)
  for (const item of projection.neighborhoods) add({ kind: 'neighborhood', item }, item.regionId)
  for (const item of projection.sources) {
    const parentId = item.neighborhoodId && descriptors.has(item.neighborhoodId) ? item.neighborhoodId : item.regionId
    add({ kind: 'source', item }, parentId)
  }
  for (const item of projection.activationProjections) add({ kind: 'projection', item }, item.sourceId)
  for (const item of projection.contextFragments) add({ kind: 'fragment', item }, rootId)
  for (const item of projection.packets) add({ kind: 'packet', item }, item.parentId)
  for (const item of projection.activationProjections) descriptors.get(item.sourceId)?.relatedIds.push(item.id)
  for (const item of projection.contextFragments) {
    for (const id of item.sourceRefs) descriptors.get(id)?.relatedIds.push(item.id)
  }
  return { descriptors, rootId }
}

function positionFor(index: number, count: number, radius: number): OceanVector3 {
  const angle = index / count * Math.PI * 2 - Math.PI / 2
  return [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.72, index % 2 === 0 ? -0.08 : 0.08]
}

/**
 * @param projection - Full Session projection.
 * @param index - Traversal index for that projection.
 * @param id - Selected view root.
 * @returns Temp-pre layout with the root, parent anchor, children and related objects.
 */
export function buildDrilldownProjection(projection: DisplayProjection, index: ReturnType<typeof buildRecursiveIndex>, id: string): DisplayProjection {
  const root = index.descriptors.get(id)
  if (!root || root.id === index.rootId) return projection
  const parentAnchor: OceanVector3 = [-1.45, 0, -0.08]
  const positions = new Map<string, OceanVector3>([[root.id, [0, 0, 0]]])
  if (root.parentId) positions.set(root.parentId, parentAnchor)
  root.childIds.forEach((child, order, all) => positions.set(child, positionFor(order, all.length, 0.9)))
  root.relatedIds.forEach((related, order, all) => positions.set(related, positionFor(order, all.length, 0.58)))
  const place = <T extends { id: string }>(items: readonly T[], field: 'position' | 'anchor' | 'center'): T[] => items.flatMap(item => {
    const position = positions.get(item.id)
    return position ? [{ ...item, [field]: position }] : []
  })
  return {
    ...projection, recursiveView: true, regions: place(projection.regions, 'anchor'), neighborhoods: place(projection.neighborhoods, 'center'),
    sources: place(projection.sources, 'position'), activationProjections: place(projection.activationProjections, 'position'),
    contextFragments: place(projection.contextFragments, 'position'), packets: place(projection.packets, 'position'),
    relations: projection.relations.filter(edge => positions.has(edge.fromId) && positions.has(edge.toId)),
    aggregationCore: { ...projection.aggregationCore, position: parentAnchor },
  }
}
