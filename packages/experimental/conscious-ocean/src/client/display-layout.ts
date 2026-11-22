/** Deterministic display spacing for the Temp-pre region fields. */

import type { OceanVector3 } from './renderer.ts'

const core: OceanVector3 = [0, 0, 0]
const radius = 2.55
const separation = 2.05
const coreClearance = 1.95

/**
 * Expand semantic region anchors and separate nearby fields in the XY plane.
 * @param anchors - Semantic anchors in stable region order.
 * @returns Display anchors in the same order.
 */
export function deriveDisplayLayout(anchors: readonly OceanVector3[]): OceanVector3[] {
  const center = anchors.reduce<[number, number, number]>((sum, [x, y, z]) => {
    sum[0] += x / anchors.length
    sum[1] += y / anchors.length
    sum[2] += z / anchors.length
    return sum
  }, [0, 0, 0])
  const maxRadius = anchors.reduce((max, [x, y]) => Math.max(max, Math.hypot(x - center[0], y - center[1])), 0)
  const points = anchors.map(([x, y, z], index): [number, number, number] => {
    if (maxRadius > 0) return [(x - center[0]) * radius / maxRadius, (y - center[1]) * radius / maxRadius, z - center[2]]
    const angle = index / anchors.length * Math.PI * 2 - Math.PI / 2
    return [Math.cos(angle) * radius * 0.78, Math.sin(angle) * radius * 0.78, 0]
  })
  for (let iteration = 0; iteration < 12; iteration++) {
    for (const [index, point] of points.entries()) {
      const dx = point[0] - core[0]
      const dy = point[1] - core[1]
      const distance = Math.hypot(dx, dy)
      if (distance >= coreClearance) continue
      const angle = distance === 0 ? (index + 1) * 1.618 : Math.atan2(dy, dx)
      point[0] = Math.cos(angle) * coreClearance
      point[1] = Math.sin(angle) * coreClearance
    }
    for (const [index, left] of points.entries()) {
      for (let rightIndex = index + 1; rightIndex < points.length; rightIndex++) {
        const right = points[rightIndex]!
        const dx = right[0] - left[0]
        const dy = right[1] - left[1]
        const distance = Math.hypot(dx, dy)
        if (distance >= separation) continue
        const angle = distance === 0 ? (index + rightIndex + 1) * 1.618 : Math.atan2(dy, dx)
        const offsetX = Math.cos(angle) * (separation - distance) / 2
        const offsetY = Math.sin(angle) * (separation - distance) / 2
        left[0] -= offsetX
        left[1] -= offsetY
        right[0] += offsetX
        right[1] += offsetY
      }
    }
  }
  return points
}
