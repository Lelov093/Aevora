/** Scene budgets selected from visible object counts. */

interface RenderDensity {
  sourceCount?: number
  regionCount?: number
  neighborhoodCount?: number
  projectionCount?: number
  fragmentCount?: number
  pixelRatio?: number
}

/**
 * @param options - Counts and requested pixel ratio.
 * @returns The Temp-pre detail tier and per-object budgets.
 */
export function resolveRenderProfile(options: RenderDensity = {}) {
  const sourceCount = Math.max(0, Number(options.sourceCount) || 0)
  const regionCount = Math.max(0, Number(options.regionCount) || 0)
  const neighborhoodCount = Math.max(0, Number(options.neighborhoodCount) || 0)
  const projectionCount = Math.max(0, Number(options.projectionCount) || 0)
  const fragmentCount = Math.max(0, Number(options.fragmentCount) || 0)
  const pixelRatio = Math.max(1, Number(options.pixelRatio) || 1)
  const visualLoad = sourceCount + neighborhoodCount + projectionCount * 2 + fragmentCount * 3
  const tier = sourceCount >= 96 || neighborhoodCount >= 40 || visualLoad >= 190
    ? "sparse"
    : sourceCount >= 40 || neighborhoodCount >= 16 || regionCount >= 8 || visualLoad >= 80
      ? "compact"
      : "full"
  const profiles = {
    full: {
      sourceParticleCount: 28,
      sourceSynapseCount: 7,
      sourceOrbitCount: 2,
      sourceHalo: true,
      sourceCore: true,
      sourceShellDetail: 1,
      sourceRingSegments: 36,
      regionParticleCount: 260,
      coreParticleCount: 220,
      backgroundParticleCount: 700,
      maxPixelRatio: Math.min(pixelRatio, 2),
    },
    compact: {
      sourceParticleCount: 14,
      sourceSynapseCount: 4,
      sourceOrbitCount: 2,
      sourceHalo: true,
      sourceCore: true,
      sourceShellDetail: 0,
      sourceRingSegments: 24,
      regionParticleCount: 180,
      coreParticleCount: 150,
      backgroundParticleCount: 480,
      maxPixelRatio: Math.min(pixelRatio, 1.6),
    },
    sparse: {
      sourceParticleCount: 6,
      sourceSynapseCount: 0,
      sourceOrbitCount: 0,
      sourceHalo: false,
      sourceCore: false,
      sourceShellDetail: 0,
      sourceRingSegments: 8,
      regionParticleCount: 80,
      coreParticleCount: 64,
      backgroundParticleCount: 240,
      maxPixelRatio: Math.min(pixelRatio, 1.25),
    },
  }
  return Object.freeze({
    tier,
    sourceCount,
    regionCount,
    neighborhoodCount,
    projectionCount,
    fragmentCount,
    visualLoad,
    ...profiles[tier],
  })
}
