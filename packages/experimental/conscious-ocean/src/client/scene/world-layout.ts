/** Read the display anchor of a spatial object. */

import type { OceanVector3 } from '../renderer.ts'

/**
 * @param item - Display node, region or neighborhood.
 * @returns Position in display coordinates.
 */
export function positionOf(item: { position?: OceanVector3; anchor?: OceanVector3; center?: OceanVector3 }): OceanVector3 {
  return item.position ?? item.anchor ?? item.center ?? [0, 0, 0]
}
