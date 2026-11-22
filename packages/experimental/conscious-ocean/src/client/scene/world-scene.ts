/** Temp-pre scene, camera and hit proxies owned by one viewport. */

import * as THREE from "three"
import type { DisplayName } from '../display-labels.ts'
import type { DisplayNeighborhood, DisplayProjection, DisplayRegion, DisplaySource } from '../display-projection.ts'
import type { OceanCameraState, OceanRendererFailure, OceanRendererViewport, OceanSceneMode, OceanVisualSettings, OceanVector3 } from '../renderer.ts'
import type { RegionColor } from './visual-tokens.ts'
import { resolveRenderProfile } from "./render-profile.ts"
import { positionOf } from "./world-layout.ts"

interface WorldLabel {
  element: HTMLButtonElement
  object: THREE.Object3D
  overview: boolean
  width: number
}

const COLORS = {
  cyan: 0x38efff,
  mint: 0xa8ffe1,
  pearl: 0xfcfec4,
  warm: 0xffd9b5,
  coral: 0xfcaec1,
  violet: 0xeed0f2,
  sky: 0x96dff5,
  white: 0xe8fbff,
  dim: 0x50758b,
}

const regionColor: Readonly<Record<string, number>> = {
  memory: COLORS.cyan,
  persona: COLORS.violet,
  goal: COLORS.warm,
  plan: COLORS.pearl,
  skill: COLORS.mint,
  tool: COLORS.sky,
  session: COLORS.white,
  environment: COLORS.warm,
}

function seededRandom(seed: number) {
  let value = seed >>> 0
  return function random() {
    value += 0x6d2b79f5
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function vector(item: Parameters<typeof positionOf>[0]) {
  const value = positionOf(item)
  return new THREE.Vector3(value[0], value[1], value[2])
}

function colorForSource(source: DisplaySource) {
  const regionId = String(source.regionId).replace("region:", "")
  return regionColor[regionId] || COLORS.white
}

function createGlowTexture() {
  const canvas = document.createElement("canvas")
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext("2d")
  if (!context) return null
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, "rgba(255,255,255,1)")
  gradient.addColorStop(0.18, "rgba(255,255,255,0.92)")
  gradient.addColorStop(0.46, "rgba(255,255,255,0.28)")
  gradient.addColorStop(1, "rgba(255,255,255,0)")
  context.fillStyle = gradient
  context.fillRect(0, 0, 128, 128)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function createGlowSprite(texture: THREE.CanvasTexture | null, color: number, size: number, opacity: number) {
  const material = new THREE.SpriteMaterial({
    map: texture,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  material.userData.baseOpacity = opacity
  const sprite = new THREE.Sprite(material)
  sprite.visible = texture !== null
  sprite.scale.set(size, size, 1)
  return sprite
}

function createNeuronNode(source: DisplaySource, color: number, seed: number, glowTexture: THREE.CanvasTexture | null, renderProfile: ReturnType<typeof resolveRenderProfile>) {
  const random = seededRandom(seed)
  const group = new THREE.Group()
  group.position.copy(vector(source))
  group.userData.objectId = source.id
  const shell = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.14, renderProfile.sourceShellDetail),
    new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: source.state === "omitted" ? 0.18 : 0.42, depthWrite: false }),
  )
  const halo = renderProfile.sourceHalo
    ? createGlowSprite(glowTexture, color, source.state === "omitted" ? 0.26 : 0.42, source.state === "omitted" ? 0.22 : 0.55)
    : new THREE.Group()
  const core = renderProfile.sourceCore
    ? new THREE.Mesh(
      new THREE.TetrahedronGeometry(0.064, 0),
      new THREE.MeshBasicMaterial({ color: source.state === "omitted" ? COLORS.coral : COLORS.pearl, transparent: true, opacity: source.state === "omitted" ? 0.48 : 0.98 }),
    )
    : new THREE.Group()
  const orbitRings = []
  for (let index = 0; index < renderProfile.sourceOrbitCount; index += 1) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.16 + index * 0.045, 0.004, 8, renderProfile.sourceRingSegments),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34 - index * 0.09, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    ring.rotation.x = Math.PI / 2 + index * 0.58
    ring.rotation.z = random() * Math.PI
    group.add(ring)
    orbitRings.push(ring)
  }
  const synapses = new THREE.Group()
  for (let index = 0; index < renderProfile.sourceSynapseCount; index += 1) {
    const angle = random() * Math.PI * 2
    const radius = 0.18 + random() * 0.15
    const end = new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.72, (random() - 0.5) * 0.18)
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), end])
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }))
    line.userData.basis = "visual-decoration"
    synapses.add(line)
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.62, blending: THREE.AdditiveBlending }))
    tip.position.copy(end)
    synapses.add(tip)
  }
  const particleCount = renderProfile.sourceParticleCount
  const positions = new Float32Array(particleCount * 3)
  const particleColors = new Float32Array(particleCount * 3)
  const baseColor = new THREE.Color(color)
  for (let index = 0; index < particleCount; index += 1) {
    const angle = random() * Math.PI * 2
    const radius = 0.18 + random() * 0.18
    positions[index * 3] = Math.cos(angle) * radius
    positions[index * 3 + 1] = Math.sin(angle) * radius * 0.76
    positions[index * 3 + 2] = (random() - 0.5) * 0.36
    const brightness = 0.42 + random() * 0.58
    particleColors[index * 3] = baseColor.r * brightness
    particleColors[index * 3 + 1] = baseColor.g * brightness
    particleColors[index * 3 + 2] = baseColor.b * brightness
  }
  const particleGeometry = new THREE.BufferGeometry()
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  particleGeometry.setAttribute("color", new THREE.BufferAttribute(particleColors, 3))
  const particles = new THREE.Points(particleGeometry, new THREE.PointsMaterial({ size: 0.018, vertexColors: true, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending, depthWrite: false }))
  group.userData.neuron = { core, halo, shell, orbitRings, phase: random() * Math.PI * 2 }
  group.add(particles, synapses, shell, halo, core)
  return group
}

function createSparseSourceInstances(sources: readonly DisplaySource[]) {
  const geometry = new THREE.TetrahedronGeometry(0.076, 0)
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.88,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const mesh = new THREE.InstancedMesh(geometry, material, sources.length)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  const dummy = new THREE.Object3D()
  const ids: string[] = []
  const baseScales: number[] = []
  const phases: number[] = []
  sources.forEach((source, index) => {
    const position = vector(source)
    const color = new THREE.Color(source.state === "omitted" ? COLORS.coral : colorForSource(source))
    const scale = source.state === "omitted" ? 0.82 : 1
    dummy.position.copy(position)
    dummy.scale.setScalar(scale)
    dummy.updateMatrix()
    mesh.setMatrixAt(index, dummy.matrix)
    mesh.setColorAt(index, color)
    ids.push(source.id)
    baseScales.push(scale)
    phases.push((index * 0.47 + source.id.length * 0.11) % (Math.PI * 2))
  })
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.computeBoundingSphere()
  mesh.userData.basis = "source-node-instanced"
  mesh.userData.instancedSourceIds = ids
  return { mesh, ids, baseScales, phases, dummy }
}

function createCoreHelix(center: THREE.Vector3, color: number, phase: number) {
  const points: THREE.Vector3[] = []
  for (let index = 0; index <= 42; index += 1) {
    const progress = index / 42
    const angle = progress * Math.PI * 4 + phase
    const radius = 0.34 + Math.sin(progress * Math.PI) * 0.08
    points.push(new THREE.Vector3(
      center.x + Math.cos(angle) * radius,
      center.y + (progress - 0.5) * 0.72,
      center.z + Math.sin(angle) * radius,
    ))
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }))
  line.userData.basis = "visual-decoration"
  return line
}

function createCoreLattice(center: THREE.Vector3, color: number, scale = 1) {
  const group = new THREE.Group()
  group.position.copy(center)
  const outer = new THREE.DodecahedronGeometry(0.34 * scale, 1)
  const outerMesh = new THREE.Mesh(outer, new THREE.MeshBasicMaterial({
    color,
    wireframe: true,
    transparent: true,
    opacity: 0.2,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  outerMesh.userData.basis = "visual-structure"
  const inner = new THREE.OctahedronGeometry(0.2 * scale, 1)
  const innerMesh = new THREE.Mesh(inner, new THREE.MeshBasicMaterial({
    color: COLORS.pearl,
    wireframe: true,
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  innerMesh.userData.basis = "visual-structure"
  group.add(outerMesh, innerMesh)
  return group
}

function createFiberLine(points: THREE.Vector3[], color: number, opacity: number, basis: string) {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.18)
  const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(32))
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  line.userData.basis = basis
  return line
}

function createNeighborhoodCore(neighborhood: DisplayNeighborhood, color: number, glowTexture: THREE.CanvasTexture | null) {
  const group = new THREE.Group()
  group.position.copy(vector(neighborhood))
  group.userData.objectId = neighborhood.id
  group.userData.neighborhoodCore = true
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.105, 1),
    new THREE.MeshBasicMaterial({ color: COLORS.pearl, wireframe: true, transparent: true, opacity: 0.54, depthWrite: false }),
  )
  const lens = new THREE.Mesh(
    new THREE.TorusGeometry(0.16, 0.006, 8, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending, depthWrite: false }),
  )
  lens.rotation.x = 0.7
  const halo = createGlowSprite(glowTexture, color, 0.34, 0.2)
  group.add(core, lens, halo)
  group.userData.neighborhood = { core, lens, halo, phase: String(neighborhood.id).length * 0.17 }
  return group
}

function createRegionCore(region: DisplayRegion, color: number, glowTexture: THREE.CanvasTexture | null) {
  const group = new THREE.Group()
  group.position.copy(vector(region))
  group.userData.objectId = region.id
  group.userData.regionCore = true
  const core = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.26, 1),
    new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false }),
  )
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.35, 0.005, 8, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.24, blending: THREE.AdditiveBlending, depthWrite: false }),
  )
  ring.rotation.x = 0.75
  const halo = createGlowSprite(glowTexture, color, 0.54, 0.14)
  group.add(core, ring, halo)
  group.userData.region = { core, ring, halo, phase: String(region.id).length * 0.11 }
  return group
}

function flowPosition(flow: { curve: THREE.CatmullRomCurve3 }, progress: number) {
  const value = Math.max(0, Math.min(1, progress))
  return flow.curve.getPointAt(value)
}

function createParticleField(region: { anchor: OceanVector3; colorToken?: RegionColor | undefined }, seed: number, count = 260) {
  const random = seededRandom(seed)
  const center = vector(region)
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const color = new THREE.Color(regionColor[region.colorToken ?? ''] || COLORS.cyan)
  for (let index = 0; index < count; index += 1) {
    const angle = random() * Math.PI * 2
    const radius = Math.pow(random(), 0.62) * 0.72
    const depth = (random() - 0.5) * 0.8
    positions[index * 3] = Math.cos(angle) * radius
    positions[index * 3 + 1] = Math.sin(angle) * radius * 0.72
    positions[index * 3 + 2] = depth
    const brightness = 0.42 + random() * 0.58
    colors[index * 3] = color.r * brightness
    colors[index * 3 + 1] = color.g * brightness
    colors[index * 3 + 2] = color.b * brightness
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3))
  const material = new THREE.PointsMaterial({
    size: 0.035,
    vertexColors: true,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const field = new THREE.Group()
  field.position.copy(center)
  field.add(new THREE.Points(geometry, material))
  return field
}

function createRelationLine(from: THREE.Vector3, to: THREE.Vector3, color: number, opacity: number, dashed: boolean) {
  const mid = from.clone().lerp(to, 0.5)
  mid.y += 0.12
  const geometry = new THREE.BufferGeometry().setFromPoints([from, mid, to])
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.08, gapSize: 0.06, depthWrite: false })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  const line = new THREE.Line(geometry, material)
  if (dashed) line.computeLineDistances()
  line.userData.basis = "recorded-relation"
  return line
}

function createFlowCurve(points: THREE.Vector3[]) {
  return new THREE.CatmullRomCurve3(points.map((point) => point.clone()), false, "centripetal", 0.18)
}

function createFlowRoute(flow: { curve: THREE.CatmullRomCurve3 }, color: number, opacity: number, dashed: boolean, basis: string) {
  const geometry = new THREE.BufferGeometry().setFromPoints(flow.curve.getPoints(48))
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.07, gapSize: 0.055, depthWrite: false })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  const line = new THREE.Line(geometry, material)
  if (dashed) line.computeLineDistances()
  line.userData.basis = basis
  line.userData.flowRoute = true
  return line
}

function createLabel({ id, label: text, labelQualifier }: DisplayName, className: string) {
  const label = document.createElement("button")
  label.type = "button"
  label.className = `world-label ${className}`
  label.hidden = true
  label.dataset.objectId = id
  label.title = text
  label.setAttribute("aria-label", text)
  if (labelQualifier) {
    const suffix = ` · ${labelQualifier}`
    const name = document.createElement('span')
    name.className = 'world-label-name'
    name.textContent = text.slice(0, -suffix.length)
    const qualifier = document.createElement('span')
    qualifier.className = 'world-label-qualifier'
    qualifier.textContent = suffix
    label.classList.add('world-label-qualified')
    label.append(name, qualifier)
  } else {
    label.textContent = text
  }
  return label
}

interface WorldSceneOptions {
  mount: HTMLElement
  labelLayer: HTMLElement
  projection: DisplayProjection
  viewport: OceanRendererViewport
  reducedMotion: boolean
  visualSettings: OceanVisualSettings
  callbacks: {
    onSelect?: (id: string | undefined) => void
    onHover?: (id: string | undefined) => void
    onEnterRequest?: (id: string) => void
    onCameraChange?: (camera: OceanCameraState) => void
    onFailure: (failure: OceanRendererFailure) => void
  }
}

/**
 * @param options - Display projection and viewport resources.
 * @returns A disposable viewport, or undefined when WebGL cannot initialize.
 */
export function createWorldScene(options: WorldSceneOptions) {
  const mount = options.mount
  const labelLayer = options.labelLayer
  let projection = options.projection
  const { callbacks } = options
  let visualSettings = options.visualSettings
  let renderProfile = resolveRenderProfile({
    sourceCount: projection.sources.length,
    regionCount: projection.regions.length,
    neighborhoodCount: projection.neighborhoods?.length || 0,
    projectionCount: projection.activationProjections?.length || 0,
    fragmentCount: projection.contextFragments?.length || 0,
    pixelRatio: options.viewport.devicePixelRatio,
  })
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x020611)
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100)
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" })
  } catch (error) {
    callbacks.onFailure({ code: 'webgl2-unavailable', detail: error instanceof Error ? error.message : String(error) })
    return undefined
  }
  renderer.setPixelRatio(renderProfile.maxPixelRatio)
  renderer.setSize(1, 1, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  mount.appendChild(renderer.domElement)

  const world = new THREE.Group()
  const regionGroup = new THREE.Group()
  const neighborhoodGroup = new THREE.Group()
  const relationGroup = new THREE.Group()
  const activationGroup = new THREE.Group()
  const sourceGroup = new THREE.Group()
  const fragmentGroup = new THREE.Group()
  const coreGroup = new THREE.Group()
  const pickGroup = new THREE.Group()
  const backgroundGroup = new THREE.Group()
  pickGroup.visible = false
  world.add(backgroundGroup, regionGroup, neighborhoodGroup, relationGroup, activationGroup, sourceGroup, fragmentGroup, coreGroup, pickGroup)
  scene.add(world)

  const sourceObjects = new Map<string, THREE.Object3D>()
  const objectPositions = new Map<string, THREE.Vector3>()
  const labelObjects = new Map<string, WorldLabel>()
  const labelMetrics = document.createElement('canvas').getContext('2d')
  const labelFont = getComputedStyle(labelLayer).fontFamily || 'sans-serif'
  const focusTargets = new Map<string, THREE.Vector3>()
  const regionFields: THREE.Group[] = []
  const regionCores: THREE.Group[] = []
  const neighborhoodCores: THREE.Group[] = []
  const activationMeshes: THREE.Group[] = []
  const fragmentMeshes: THREE.Group[] = []
  const coreFragmentMeshes: THREE.Group[] = []
  const neuronNodes: THREE.Group[] = []
  let instancedSources: (ReturnType<typeof createSparseSourceInstances> & { pickMesh: THREE.InstancedMesh }) | undefined
  const coreHelices: THREE.Line[] = []
  const corePosition = new THREE.Vector3()
  let coreGlow: THREE.Sprite
  let coreHalo: THREE.Sprite
  let coreShell: THREE.Mesh
  let coreSphere: THREE.Mesh
  let coreFragmentLayer: THREE.Group
  let coreRings: THREE.Mesh[] = []
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const projectionGeometry = new THREE.TetrahedronGeometry(0.06, 0)
  const fragmentGeometry = new THREE.OctahedronGeometry(0.07, 0)
  const glowTexture = createGlowTexture()
  const sharedGeometries = new Set<THREE.BufferGeometry>([projectionGeometry, fragmentGeometry])
  const pickGeometry = new THREE.SphereGeometry(1, 12, 8)
  const pickMaterial = new THREE.MeshBasicMaterial({ visible: false })
  sharedGeometries.add(pickGeometry)
  const sharedMaterials = new Set<THREE.Material>([pickMaterial])

  function disposeGroup(group: THREE.Group) {
    group.children.forEach((child) => {
      child.traverse((object) => {
        if (object instanceof THREE.InstancedMesh) object.dispose()
        if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Sprite)) return
        if (!(object instanceof THREE.Sprite) && !sharedGeometries.has(object.geometry)) object.geometry.dispose()
        const materials: THREE.Material[] = Array.isArray(object.material) ? object.material : [object.material]
        materials.forEach((material) => {
          if (!sharedMaterials.has(material)) material.dispose()
        })
      })
    })
    group.clear()
  }

  function clearProjectionObjects() {
    disposeGroup(regionGroup)
    disposeGroup(neighborhoodGroup)
    disposeGroup(relationGroup)
    disposeGroup(activationGroup)
    disposeGroup(sourceGroup)
    disposeGroup(fragmentGroup)
    disposeGroup(coreGroup)
    disposeGroup(pickGroup)
    disposeGroup(backgroundGroup)
    sourceObjects.clear()
    objectPositions.clear()
    labelObjects.clear()
    focusTargets.clear()
    regionFields.length = 0
    regionCores.length = 0
    neighborhoodCores.length = 0
    activationMeshes.length = 0
    fragmentMeshes.length = 0
    coreFragmentMeshes.length = 0
    neuronNodes.length = 0
    instancedSources = undefined
    coreHelices.length = 0
    coreRings = []
    labelLayer.replaceChildren()
  }

  function buildBackground(seed: number) {
    disposeGroup(backgroundGroup)
    const random = seededRandom(seed)
    const backgroundCount = renderProfile.backgroundParticleCount
    const backgroundPositions = new Float32Array(backgroundCount * 3)
    const backgroundColors = new Float32Array(backgroundCount * 3)
    const backgroundColor = new THREE.Color(COLORS.white)
    for (let index = 0; index < backgroundCount; index += 1) {
      backgroundPositions[index * 3] = (random() - 0.5) * 14
      backgroundPositions[index * 3 + 1] = (random() - 0.5) * 8
      backgroundPositions[index * 3 + 2] = (random() - 0.5) * 5
      const brightness = 0.12 + random() * 0.38
      backgroundColors[index * 3] = backgroundColor.r * brightness
      backgroundColors[index * 3 + 1] = backgroundColor.g * brightness
      backgroundColors[index * 3 + 2] = backgroundColor.b * brightness
    }
    const backgroundGeometry = new THREE.BufferGeometry()
    backgroundGeometry.setAttribute("position", new THREE.BufferAttribute(backgroundPositions, 3))
    backgroundGeometry.setAttribute("color", new THREE.BufferAttribute(backgroundColors, 3))
    backgroundGroup.add(new THREE.Points(
      backgroundGeometry,
      new THREE.PointsMaterial({ size: 0.028, vertexColors: true, transparent: true, opacity: 0.58, depthWrite: false, blending: THREE.AdditiveBlending }),
    ))
  }

  function buildProjection(nextProjection: DisplayProjection) {
    clearProjectionObjects()
    projection = nextProjection
    renderProfile = resolveRenderProfile({
      sourceCount: projection.sources.length,
      regionCount: projection.regions.length,
      neighborhoodCount: projection.neighborhoods?.length || 0,
      projectionCount: projection.activationProjections?.length || 0,
      fragmentCount: projection.contextFragments?.length || 0,
      pixelRatio: options.viewport.devicePixelRatio,
    })
    renderer.setPixelRatio(renderProfile.maxPixelRatio)
    corePosition.copy(vector(projection.aggregationCore))
    const regionById = new Map(projection.regions.map((region) => [region.id, region]))
    const sourceById = new Map(projection.sources.map((source) => [source.id, source]))

    coreGroup.userData.objectId = projection.aggregationCore.id
    const addPickProxy = (objectId: string, position: THREE.Vector3, radius: number) => {
      const proxy = new THREE.Mesh(pickGeometry, pickMaterial)
      proxy.position.copy(position)
      proxy.scale.setScalar(radius)
      proxy.userData.objectId = objectId
      proxy.userData.pickable = true
      proxy.userData.pickEnabled = true
      proxy.userData.radius = radius
      pickGroup.add(proxy)
      return proxy
    }
    const addLabel = (item: DisplayName, object: THREE.Object3D, className: string, overview = false) => {
      const element = createLabel(item, className)
      if (labelMetrics) labelMetrics.font = `${overview ? 11 : 10}px ${labelFont}`
      const textWidth = labelMetrics?.measureText(item.label).width ?? item.label.length * 11
      labelLayer.appendChild(element)
      labelObjects.set(item.id, { element, object, overview, width: Math.max(34, Math.min(240, textWidth + 16)) })
    }

    addPickProxy(projection.aggregationCore.id, corePosition, 0.46)
    coreGlow = createGlowSprite(glowTexture, COLORS.cyan, 1.2, 0.58)
    coreGlow.position.copy(corePosition)
    coreGroup.add(coreGlow)
    coreHalo = createGlowSprite(glowTexture, COLORS.violet, 2.2, 0.13)
    coreHalo.position.copy(corePosition)
    coreGroup.add(coreHalo)
    coreShell = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.46, 1),
      new THREE.MeshBasicMaterial({ color: COLORS.sky, wireframe: true, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    coreShell.position.copy(corePosition)
    coreGroup.add(coreShell)
    coreGroup.add(createCoreLattice(corePosition, COLORS.cyan, 1.12))
    coreSphere = new THREE.Mesh(
      new THREE.TetrahedronGeometry(0.08, 0),
      new THREE.MeshBasicMaterial({ color: COLORS.pearl, transparent: true, opacity: 0.95 }),
    )
    coreSphere.position.copy(corePosition)
    coreSphere.userData.objectId = projection.aggregationCore.id
    coreGroup.add(coreSphere)
    addLabel(projection.aggregationCore, coreSphere, 'core-label', true)
    sourceObjects.set(projection.aggregationCore.id, coreGroup)
    objectPositions.set(projection.aggregationCore.id, corePosition.clone())
    focusTargets.set(projection.aggregationCore.id, corePosition.clone())
    const coreParticles = createParticleField(
      { anchor: corePosition.toArray(), colorToken: "memory" },
      projection.layout.seed + 99,
      renderProfile.coreParticleCount,
    )
    coreParticles.scale.setScalar(1.3)
    coreGroup.add(coreParticles)
    coreFragmentLayer = new THREE.Group()
    coreFragmentLayer.userData.basis = "context-fragment-core-layer"
    coreGroup.add(coreFragmentLayer)
    coreHelices.push(createCoreHelix(corePosition, COLORS.cyan, 0))
    coreHelices.push(createCoreHelix(corePosition, COLORS.violet, Math.PI))
    coreHelices.forEach((helix) => coreGroup.add(helix))

    coreRings = []
    for (let index = 0; index < 4; index += 1) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.25 + index * 0.09, 0.255 + index * 0.09, 64),
        new THREE.MeshBasicMaterial({
          color: index % 2 === 0 ? COLORS.cyan : COLORS.violet,
          transparent: true,
          opacity: 0.24 - index * 0.035,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      ring.position.copy(corePosition)
      ring.rotation.x = Math.PI / 2 + index * 0.24
      ring.rotation.z = index * 0.3
      ring.userData.basis = "visual-structure"
      coreGroup.add(ring)
      coreRings.push(ring)
    }

    projection.regions.forEach((region, index) => {
      const field = createParticleField(region, projection.layout.seed + index * 17, renderProfile.regionParticleCount)
      regionGroup.add(field)
      regionFields.push(field)
      const color = regionColor[region.colorToken ?? ''] || COLORS.cyan
      const regionPosition = vector(region)
      const regionAura = createGlowSprite(glowTexture, color, 1.08, 0.11)
      regionAura.position.copy(regionPosition)
      regionGroup.add(regionAura)
      const regionCoreObject = createRegionCore(region, color, glowTexture)
      regionGroup.add(regionCoreObject)
      regionCores.push(regionCoreObject)
      addPickProxy(region.id, regionPosition, 0.4)
      sourceObjects.set(region.id, regionCoreObject)
      objectPositions.set(region.id, regionPosition.clone())
      focusTargets.set(region.id, regionPosition.clone())
      addLabel(region, regionCoreObject, 'region-label', true)
    })

    const regionPositions = projection.regions.map((region) => objectPositions.get(region.id)).filter(position => position !== undefined)
    regionPositions.forEach((position, index) => {
      const next = regionPositions[(index + 1) % regionPositions.length]
      if (!next || regionPositions.length < 2) return
      const midpoint = position.clone().lerp(next, 0.5)
      midpoint.z += (index % 2 === 0 ? 0.12 : -0.12)
      const fiber = createFiberLine([position.clone(), midpoint, next.clone()], COLORS.sky, 0.075, "visual-structure")
      regionGroup.add(fiber)
    })

    projection.neighborhoods.forEach((neighborhood) => {
      const region = regionById.get(neighborhood.regionId)
      const color = regionColor[region?.colorToken ?? ''] || COLORS.cyan
      const neighborhoodCoreObject = createNeighborhoodCore(neighborhood, color, glowTexture)
      neighborhoodGroup.add(neighborhoodCoreObject)
      neighborhoodCores.push(neighborhoodCoreObject)
      const neighborhoodPosition = vector(neighborhood)
      addPickProxy(neighborhood.id, neighborhoodPosition, 0.2)
      sourceObjects.set(neighborhood.id, neighborhoodCoreObject)
      objectPositions.set(neighborhood.id, neighborhoodPosition.clone())
      focusTargets.set(neighborhood.id, neighborhoodPosition.clone())
      addLabel(neighborhood, neighborhoodCoreObject, 'neighborhood-label')
      const regionPosition = objectPositions.get(neighborhood.regionId)
      if (regionPosition) {
        const route = createFiberLine([neighborhoodPosition.clone(), regionPosition.clone()], color, 0.15, "hierarchy-structure")
        neighborhoodGroup.add(route)
      }
    })

    const useInstancedSources = renderProfile.tier === "sparse" && projection.sources.length >= 96
    if (useInstancedSources) {
      const instances = createSparseSourceInstances(projection.sources)
      sourceGroup.add(instances.mesh)
      const pickMesh = new THREE.InstancedMesh(pickGeometry, pickMaterial, projection.sources.length)
      const pickDummy = new THREE.Object3D()
      projection.sources.forEach((source, index) => {
        pickDummy.position.copy(vector(source))
        pickDummy.scale.setScalar(source.state === "omitted" ? 0.076 : 0.093)
        pickDummy.updateMatrix()
        pickMesh.setMatrixAt(index, pickDummy.matrix)
      })
      pickMesh.instanceMatrix.needsUpdate = true
      pickMesh.computeBoundingSphere()
      pickMesh.userData.pickable = true
      pickMesh.userData.pickEnabled = true
      pickMesh.userData.instancedSourceIds = projection.sources.map((source) => source.id)
      pickGroup.add(pickMesh)
      instancedSources = { ...instances, pickMesh }
    }
    projection.sources.forEach((source) => {
      const color = colorForSource(source)
      const neuron = useInstancedSources
        ? new THREE.Group()
        : createNeuronNode(source, color, projection.layout.seed + source.id.length * 19, glowTexture, renderProfile)
      neuron.position.copy(vector(source))
      neuron.userData.objectId = source.id
      if (!useInstancedSources) {
        sourceGroup.add(neuron)
        neuronNodes.push(neuron)
      }
      if (!useInstancedSources) addPickProxy(source.id, vector(source), source.state === "omitted" ? 0.16 : 0.22)
      sourceObjects.set(source.id, neuron)
      objectPositions.set(source.id, neuron.position.clone())
      focusTargets.set(source.id, neuron.position.clone())
      addLabel(source, neuron, 'source-label')
      const neighborhoodPosition = source.neighborhoodId === undefined ? undefined : objectPositions.get(source.neighborhoodId)
      if (neighborhoodPosition) {
        const route = createFiberLine([neuron.position.clone(), neighborhoodPosition.clone()], color, 0.12, "hierarchy-structure")
        neighborhoodGroup.add(route)
      }
    })

    projection.relations.forEach((relation) => {
      const from = objectPositions.get(relation.fromId)
      const to = objectPositions.get(relation.toId)
      if (!from || !to) return
      const color = relation.state === "omitted" ? COLORS.coral : COLORS.dim
      const line = createRelationLine(from, to, color, relation.state === "omitted" ? 0.36 : 0.18, relation.state === "omitted")
      line.userData.relationId = relation.id
      line.userData.evidence = relation.evidence
      line.userData.state = relation.state
      relationGroup.add(line)
    })

    const flowPointsFor = (sourceId: string, target: THREE.Vector3) => {
      const sourceItem = sourceById.get(sourceId)
      const points = [objectPositions.get(sourceId)]
      if (sourceItem?.neighborhoodId) points.push(objectPositions.get(sourceItem.neighborhoodId))
      if (sourceItem?.regionId) points.push(objectPositions.get(sourceItem.regionId))
      points.push(target, corePosition)
      return points.filter(position => position !== undefined)
    }

    projection.activationProjections.forEach((projectionItem) => {
      const source = objectPositions.get(projectionItem.sourceId)
      const target = new THREE.Vector3(projectionItem.position[0], projectionItem.position[1], projectionItem.position[2])
      if (!source) return
      const projectionColor = projectionItem.state === "omitted" ? COLORS.coral : COLORS.cyan
      const node = new THREE.Group()
      node.position.copy(target)
      node.userData.objectId = projectionItem.id
      node.userData.basePosition = target.clone()
      node.userData.idlePhase = projectionItem.id.length * 0.17
      node.userData.eventSeq = projectionItem.eventSeq
      node.userData.flow = {
        curve: createFlowCurve(flowPointsFor(projectionItem.sourceId, target)),
        phase: (node.userData.eventSeq * 0.37 + projectionItem.id.length * 0.021) % 1,
        basis: "activation-projection-plus-hierarchy-path",
      }
      node.userData.pickProxy = addPickProxy(projectionItem.id, target, 0.066)
      const material = new THREE.MeshBasicMaterial({ color: projectionColor, transparent: true, opacity: projectionItem.state === "omitted" ? 0.45 : 0.82, blending: THREE.AdditiveBlending })
      const mesh = new THREE.Mesh(projectionGeometry, material)
      mesh.userData.objectId = projectionItem.id
      const tail = createFiberLine([new THREE.Vector3(0, 0, 0), new THREE.Vector3(-0.13, 0, 0)], projectionColor, 0.32, "activation-packet-tail")
      node.add(createGlowSprite(glowTexture, projectionColor, projectionItem.state === "omitted" ? 0.12 : 0.18, projectionItem.state === "omitted" ? 0.14 : 0.26), mesh, tail)
      activationGroup.add(node)
      activationMeshes.push(node)
      sourceObjects.set(projectionItem.id, node)
      addLabel(projectionItem, node, 'projection-label')
      objectPositions.set(projectionItem.id, target.clone())
      focusTargets.set(projectionItem.id, target.clone())
      const route = createFlowRoute(node.userData.flow, projectionColor, projectionItem.state === "omitted" ? 0.26 : 0.42, true, "activation-projection-plus-hierarchy-path")
      route.userData.visibilityId = projectionItem.id
      route.userData.projectionId = projectionItem.id
      route.userData.sourceId = projectionItem.sourceId
      route.userData.evidence = projectionItem.evidence
      route.userData.eventSeq = projectionItem.eventSeq
      activationGroup.add(route)
    })

    if (projection.recursiveView && Array.isArray(projection.packets)) {
      projection.packets.forEach((packet) => {
        const target = new THREE.Vector3(packet.position[0], packet.position[1], packet.position[2])
        const node = new THREE.Group()
        node.position.copy(target)
        node.userData.objectId = packet.id
        node.userData.basePosition = target.clone()
        node.userData.idlePhase = packet.id.length * 0.13
        node.userData.structural = true
        node.userData.packet = packet
        const color = packet.evidence === "unavailable" ? COLORS.coral : (packet.level === 'source' ? COLORS.pearl : packet.level === 'context' ? COLORS.mint : COLORS.cyan)
        const mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(packet.level === "source" ? 0.055 : 0.075, 0),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.78, blending: THREE.AdditiveBlending, depthWrite: false }),
        )
        mesh.userData.objectId = packet.id
        node.add(createGlowSprite(glowTexture, color, packet.level === "source" ? 0.12 : 0.16, 0.2), mesh)
        activationGroup.add(node)
        activationMeshes.push(node)
        sourceObjects.set(packet.id, node)
        objectPositions.set(packet.id, target.clone())
        focusTargets.set(packet.id, target.clone())
        addLabel(packet, node, 'packet-label')
        const sourceId = packet.sourceRefs?.[0]
        const sourcePosition = sourceId ? objectPositions.get(sourceId) : undefined
        node.userData.pickProxy = addPickProxy(packet.id, target, packet.level === "source" ? 0.061 : 0.083)
        if (sourcePosition) {
          const flow = { curve: createFlowCurve([sourcePosition.clone(), target.clone(), corePosition.clone()]), phase: 0, basis: "recursive-packet-path" }
          const route = createFlowRoute(flow, color, 0.3, true, "recursive-packet-path")
          route.userData.visibilityId = packet.id
          route.userData.structural = true
          route.userData.evidence = packet.evidence
          activationGroup.add(route)
        }
      })
    }

    projection.contextFragments.forEach((fragment) => {
      const target = new THREE.Vector3(fragment.position[0], fragment.position[1], fragment.position[2])
      const node = new THREE.Group()
      node.position.copy(target)
      node.userData.objectId = fragment.id
      node.userData.basePosition = target.clone()
      node.userData.idlePhase = fragment.order * 0.23
      const fragmentSource = fragment.sourceRefs.find(id => objectPositions.has(id))
      node.userData.eventSeq = fragment.eventSeq
      node.userData.flow = fragmentSource === undefined ? undefined : {
        curve: createFlowCurve(flowPointsFor(fragmentSource, target)),
        phase: (fragment.order * 0.23) % 1,
      }
      node.userData.pickProxy = addPickProxy(fragment.id, target, 0.077)
      const mesh = new THREE.Mesh(fragmentGeometry, new THREE.MeshBasicMaterial({ color: COLORS.pearl, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending }))
      mesh.userData.objectId = fragment.id
      node.add(createGlowSprite(glowTexture, COLORS.pearl, 0.16, 0.2), mesh)
      fragmentGroup.add(node)
      fragmentMeshes.push(node)
      sourceObjects.set(fragment.id, node)
      objectPositions.set(fragment.id, target.clone())
      focusTargets.set(fragment.id, target.clone())
      addLabel(fragment, node, 'fragment-label')
      if (node.userData.flow) {
        const route = createFlowRoute(node.userData.flow, COLORS.pearl, 0.2, true, "context-fragment-source-and-hierarchy-path")
        route.userData.visibilityId = fragment.id
        route.userData.eventSeq = fragment.eventSeq
        route.userData.sourceRefs = fragment.sourceRefs
        route.userData.evidence = fragment.evidence
        fragmentGroup.add(route)
      }
    })

    projection.contextFragments.forEach((fragment, index) => {
      const angle = (index / Math.max(projection.contextFragments.length, 1)) * Math.PI * 2
      const center = corePosition.clone().add(new THREE.Vector3(Math.cos(angle) * 0.18, Math.sin(angle) * 0.14, (index % 2 ? 0.08 : -0.08)))
      const coreFragment = createCoreLattice(center, COLORS.pearl, 0.28)
      coreFragment.userData.objectId = fragment.id
      coreFragment.userData.eventSeq = fragment.eventSeq
      coreFragment.userData.fragmentOrder = fragment.order
      coreFragment.userData.pickProxy = addPickProxy(fragment.id, center, 0.12)
      coreFragmentLayer.add(coreFragment)
      coreFragmentMeshes.push(coreFragment)
    })
    buildBackground(projection.layout.seed)
  }

  buildProjection(projection)

  let width = 1
  let height = 1
  let yaw = 0.25
  let pitch = 0.2
  const defaultDistance = 7.4
  let distance = defaultDistance
  let userZoomed = false
  let target = corePosition.clone()
  const focusOrigin = corePosition.clone()
  const focusGoal = corePosition.clone()
  let focusStartedAt = 0
  let focusTransitionActive = false
  const focusTransitionDuration = 420
  let mode: OceanSceneMode = "galaxy"
  let selectedId: string | undefined = projection.aggregationCore.id
  let hoveredId: string | undefined
  let replayEvent: number | undefined
  let lowMotion = options.reducedMotion
  let paused = false
  let disposed = false
  let autoOrbit = true
  let dragging = false
  let panning = false
  let didDrag = false
  let lastX = 0
  let lastY = 0
  let animationFrame = 0
  const listenerOwner = new AbortController()

  function resize(viewport?: OceanRendererViewport) {
    const bounds = viewport ?? mount.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    const cap = renderProfile.tier === 'full' ? 2 : renderProfile.tier === 'compact' ? 1.6 : 1.25
    const ratio = Math.min(viewport?.devicePixelRatio ?? window.devicePixelRatio ?? 1, cap)
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio)
    width = Math.max(Math.round(bounds.width), 1)
    height = Math.max(Math.round(bounds.height), 1)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    if (!userZoomed) distance = Math.min(18, defaultDistance * Math.max(1, 1.25 / camera.aspect))
  }

  function applyCamera() {
    const cosPitch = Math.cos(pitch)
    camera.position.set(
      target.x + Math.sin(yaw) * cosPitch * distance,
      target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(yaw) * cosPitch * distance,
    )
    camera.lookAt(target)
    camera.updateMatrixWorld()
  }

  function updateFocusTransition(time: number) {
    if (!focusTransitionActive) return
    const progress = Math.min(1, Math.max(0, (time - focusStartedAt) / focusTransitionDuration))
    const eased = progress * progress * (3 - 2 * progress)
    target.lerpVectors(focusOrigin, focusGoal, eased)
    if (progress >= 1) {
      target.copy(focusGoal)
      focusTransitionActive = false
    }
  }

  function cancelFocusTransition() {
    focusTransitionActive = false
    focusGoal.copy(target)
  }

  function updateLabels() {
    if (labelLayer.hidden) return
    const focused = document.activeElement
    const priority = (entry: WorldLabel) => {
      const id = entry.object.userData.objectId
      if (entry.element === focused) return 5
      if (id === hoveredId) return 4
      if (id === selectedId) return 3
      return entry.overview ? 2 : 1
    }
    const entries = [...labelObjects.values()].filter(entry => {
      const visible = entry.object.visible && entry.object.parent?.visible !== false
        && (priority(entry) >= 2 || projection.recursiveView)
      if (!visible) entry.element.hidden = true
      return visible
    }).sort((left, right) => priority(right) - priority(left))
    const accepted: { left: number; right: number; top: number; bottom: number }[] = []
    entries.forEach((entry) => {
      const projected = entry.object.position.clone().project(camera)
      const visible = Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && Math.abs(projected.z) < 1
      entry.element.hidden = !visible
      if (!visible) return
      const labelWidth = Math.min(entry.width, width * 0.8)
      const x = THREE.MathUtils.clamp((projected.x * 0.5 + 0.5) * width, labelWidth / 2, width - labelWidth / 2)
      const y = (-projected.y * 0.5 + 0.5) * height - (entry.element.classList.contains('core-label') ? 24 : 0)
      const labelHeight = 22
      const box = { left: x - labelWidth / 2, right: x + labelWidth / 2, top: y - labelHeight / 2, bottom: y + labelHeight / 2 }
      const collides = accepted.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)
      if (collides && entry.element !== focused) {
        entry.element.hidden = true
        entry.element.dataset.collided = "true"
        return
      }
      accepted.push(box)
      entry.element.dataset.collided = "false"
      entry.element.style.left = x + "px"
      entry.element.style.top = y + "px"
      entry.element.dataset.selected = entry.object.userData.objectId === selectedId ? "true" : "false"
      entry.element.dataset.hovered = entry.object.userData.objectId === hoveredId ? "true" : "false"
    })
  }

  function objectAt(event: MouseEvent) {
    const bounds = renderer.domElement.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return undefined
    pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1
    pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const hits = raycaster.intersectObjects(pickGroup.children, true)
    const firstHit = hits.find((hit) => hit.object.userData.pickable !== false && hit.object.userData.pickEnabled !== false)
    if (instancedSources && firstHit?.object === instancedSources.pickMesh && firstHit.instanceId !== undefined) {
      return instancedSources.ids[firstHit.instanceId]
    }
    const id: unknown = firstHit?.object.userData.objectId
    return typeof id === 'string' ? id : undefined
  }

  function focus(id: string) {
    const object = sourceObjects.get(id)
    const position = object?.userData.basePosition ? object.position : focusTargets.get(id)
    if (!position) return
    focusOrigin.copy(target)
    focusGoal.copy(position)
    focusStartedAt = performance.now()
    focusTransitionActive = !options.reducedMotion && !focusOrigin.equals(focusGoal)
    if (!focusTransitionActive) target.copy(focusGoal)
    emitCamera()
  }

  function setSelection(id: string | undefined, shouldFocus = true, notify = true) {
    selectedId = id
    sourceObjects.forEach((object, objectId) => {
      object.userData.selected = objectId === id
    })
    if (notify) callbacks.onSelect?.(id)
    if (shouldFocus && id !== undefined) focus(id)
  }

  function setHover(id: string | undefined) {
    if (id === hoveredId) return
    hoveredId = id
    sourceObjects.forEach((object, objectId) => {
      object.userData.hovered = objectId === hoveredId
    })
    labelObjects.forEach((entry) => {
      entry.element.dataset.hovered = entry.object.userData.objectId === hoveredId ? "true" : "false"
    })
    callbacks.onHover?.(hoveredId)
  }

  function setGroupOpacity(group: THREE.Group, factor: number) {
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Sprite)) return
      const materials: THREE.Material[] = Array.isArray(object.material) ? object.material : [object.material]
      materials.forEach((material) => {
        if (material.userData.baseOpacity === undefined) material.userData.baseOpacity = material.opacity
        material.opacity = material.userData.baseOpacity * factor
      })
    })
  }

  function currentEventSeq() {
    return replayEvent ?? projection.traceEvents.at(-1)?.eventSeq ?? -Infinity
  }

  function applyEventVisibility() {
    const seq = currentEventSeq()
    for (const group of [activationGroup, fragmentGroup, coreFragmentLayer]) {
      for (const object of group.children) {
        const { eventSeq, structural, pickProxy } = object.userData
        object.visible = mode !== 'replay' || structural === true || (typeof eventSeq === 'number' && eventSeq <= seq)
        if (pickProxy) pickProxy.userData.pickEnabled = object.visible && group.visible
      }
    }
    const hovered = hoveredId ? sourceObjects.get(hoveredId) : undefined
    if (hovered && (!hovered.visible || hovered.parent?.visible === false)) setHover(undefined)
  }

  function applyMode(nextMode: OceanSceneMode) {
    mode = nextMode
    regionGroup.visible = true
    neighborhoodGroup.visible = true
    relationGroup.visible = true
    setGroupOpacity(regionGroup, nextMode === "galaxy" ? 1 : 0.56)
    setGroupOpacity(neighborhoodGroup, nextMode === "galaxy" ? 1 : 0.72)
    setGroupOpacity(relationGroup, nextMode === "galaxy" ? 1 : 0.5)
    activationGroup.visible = nextMode !== "galaxy" || projection.recursiveView === true
    fragmentGroup.visible = nextMode === "context" || nextMode === "trace" || nextMode === "replay"
    coreFragmentLayer.visible = nextMode === "context" || nextMode === "trace" || nextMode === "replay"
    applyEventVisibility()
    applyParticleOpacity()
  }

  function applyParticleOpacity() {
    const density = THREE.MathUtils.clamp(visualSettings.particleDensity, 0, 1.2)
    for (const group of [backgroundGroup, regionGroup, sourceGroup, coreGroup]) {
      group.traverse(object => {
        if (!(object instanceof THREE.Points) || !(object.material instanceof THREE.PointsMaterial)) return
        const material = object.material
        material.userData.baseOpacity ??= material.opacity
        const regionFactor = group === regionGroup && mode !== 'galaxy' ? 0.56 : 1
        material.opacity = Math.min(1, material.userData.baseOpacity * density * regionFactor)
      })
    }
  }

  function animate() {
    if (paused || disposed) return
    const now = performance.now()
    const time = options.reducedMotion ? 0 : now
    const motionFactor = options.reducedMotion ? 0 : (lowMotion ? 0.2 : 1) * visualSettings.motionIntensity
    if (!lowMotion && !dragging && !panning && autoOrbit) yaw += 0.0007 * motionFactor
    const focusing = focusTransitionActive
    updateFocusTransition(now)
    {
      regionFields.forEach((field, index) => {
        field.rotation.z += 0.00008 * (index + 1) * motionFactor
        field.rotation.y += 0.00005 * (index + 1) * motionFactor
      })
      neighborhoodCores.forEach((node, index) => {
        const neighborhood = node.userData.neighborhood
        if (!neighborhood) return
        const emphasis = node.userData.selected ? 1.28 : node.userData.hovered ? 1.18 : 1
        const pulse = 1 + Math.sin(time * 0.0018 + index * 0.7) * (node.userData.selected ? 0.08 : node.userData.hovered ? 0.06 : 0.03) * motionFactor
        node.scale.setScalar(emphasis * pulse)
        neighborhood.lens.rotation.z += 0.0012 * (index % 2 === 0 ? 1 : -1) * motionFactor
        neighborhood.core.rotation.y += 0.001 * motionFactor
        if (neighborhood.halo.material) neighborhood.halo.material.opacity = neighborhood.halo.material.userData.baseOpacity * (node.userData.selected ? 2.4 : node.userData.hovered ? 1.9 : 1)
      })
      regionCores.forEach((node, index) => {
        const region = node.userData.region
        if (!region) return
        const emphasis = node.userData.selected ? 1.22 : node.userData.hovered ? 1.14 : 1
        const pulse = 1 + Math.sin(time * 0.0016 + index * 0.8) * (node.userData.selected ? 0.07 : node.userData.hovered ? 0.05 : 0.025) * motionFactor
        node.scale.setScalar(emphasis * pulse)
        region.ring.rotation.z += 0.0006 * (index + 1) * motionFactor
        region.core.rotation.y += 0.0004 * motionFactor
        if (region.halo.material) region.halo.material.opacity = region.halo.material.userData.baseOpacity * (node.userData.selected ? 2.2 : node.userData.hovered ? 1.8 : 1)
      })
      neuronNodes.forEach((node, index) => {
        const neuron = node.userData.neuron
        const emphasis = node.userData.selected ? 1.38 : node.userData.hovered ? 1.22 : 1
        const pulse = 1 + Math.sin(time * 0.0022 + neuron.phase) * (node.userData.selected ? 0.08 : node.userData.hovered ? 0.06 : 0.035) * motionFactor
        node.scale.setScalar(emphasis * pulse)
        neuron.shell.rotation.y += 0.0014 * (index % 2 === 0 ? 1 : -1) * motionFactor
        neuron.shell.rotation.z += 0.0008 * motionFactor
        neuron.orbitRings.forEach((ring: THREE.Mesh, ringIndex: number) => {
          ring.rotation.z += 0.0012 * (ringIndex + 1) * (index % 2 === 0 ? 1 : -1) * motionFactor
        })
        if (neuron.halo.material) neuron.halo.material.opacity = neuron.halo.material.userData.baseOpacity * (node.userData.selected ? 1.5 : node.userData.hovered ? 1.3 : 1)
      })
      if (instancedSources) {
        const instances = instancedSources
        instances.ids.forEach((id, index) => {
          const node = sourceObjects.get(id)
          if (!node) return
          const emphasis = node.userData.selected ? 1.38 : node.userData.hovered ? 1.22 : 1
          const pulse = 1 + Math.sin(time * 0.0022 + (instances.phases[index] ?? 0)) * (node.userData.selected ? 0.08 : node.userData.hovered ? 0.06 : 0.035) * motionFactor
          instances.dummy.position.copy(node.position)
          instances.dummy.scale.setScalar((instances.baseScales[index] ?? 1) * emphasis * pulse)
          instances.dummy.updateMatrix()
          instances.mesh.setMatrixAt(index, instances.dummy.matrix)
        })
        instancedSources.mesh.instanceMatrix.needsUpdate = true
      }
      let mergedCount = 0
      const animateFlowNode = (node: THREE.Group, index: number, size: number) => {
        if (!node.visible || node.parent?.visible === false) return
        const flow: { curve: THREE.CatmullRomCurve3; phase: number } | undefined = node.userData.flow
        let travelScale = 1
        if (flow && !options.reducedMotion && mode !== 'galaxy') {
          const progress = mode === 'replay' && node.userData.eventSeq < currentEventSeq()
            ? 1
            : (time * motionFactor * (size === 0.7 ? 0.00022 : 0.00014) + flow.phase) % 1
          const nextProgress = Math.min(1, progress + 0.025)
          const position = flowPosition(flow, progress)
          node.position.copy(position)
          node.lookAt(flowPosition(flow, nextProgress))
          if (progress > 0.92) {
            mergedCount += 1
            travelScale = 0.28
          }
        } else if (node.userData.basePosition) {
          node.position.copy(node.userData.basePosition)
        }
        const emphasis = node.userData.selected ? 1.55 : node.userData.hovered ? 1.36 : 1
        const idlePhase = Number.isFinite(node.userData.idlePhase) ? node.userData.idlePhase : index * 0.6
        const pulse = 1 + Math.sin(time * 0.0018 + idlePhase) * (node.userData.selected ? 0.1 : node.userData.hovered ? 0.08 : 0.04) * motionFactor
        node.scale.setScalar(size * emphasis * travelScale * pulse)
        const proxy: THREE.Mesh | undefined = node.userData.pickProxy
        if (proxy) {
          proxy.position.copy(node.position)
          proxy.scale.setScalar(proxy.userData.radius * node.scale.x)
        }
        node.rotation.z += 0.0006 * motionFactor
      }
      activationMeshes.forEach((mesh, index) => animateFlowNode(mesh, index, 0.7))
      fragmentMeshes.forEach((mesh, index) => animateFlowNode(mesh, index + activationMeshes.length, 0.58))
      coreFragmentMeshes.forEach((mesh, index) => {
        if (!mesh.visible) return
        const selected = selectedId === mesh.userData.objectId
        const hovered = hoveredId === mesh.userData.objectId
        const emphasis = selected ? 1.24 : hovered ? 1.16 : 1
        const pulse = 1 + Math.sin(time * 0.0017 + index * 0.6) * (selected ? 0.1 : hovered ? 0.08 : 0.06) * motionFactor
        mesh.scale.setScalar(emphasis * pulse)
        mesh.rotation.y += 0.0007 * motionFactor
        mesh.rotation.x += 0.0003 * motionFactor
      })
      const coreEmphasis = coreGroup.userData.selected ? 1.24 : coreGroup.userData.hovered ? 1.16 : 1
      const corePulse = 1 + Math.sin(time * 0.0018) * (coreGroup.userData.selected ? 0.1 : coreGroup.userData.hovered ? 0.08 : 0.06) * motionFactor + Math.min(mergedCount, 6) * 0.012
      const pulse = corePulse * coreEmphasis
      coreGlow.scale.setScalar(pulse)
      coreHalo.scale.setScalar(0.94 + pulse * 0.08)
      coreSphere.scale.setScalar(1 + Math.sin(time * 0.0018 + 0.7) * 0.06 * motionFactor)
      if (coreGlow.material) coreGlow.material.opacity = coreGlow.material.userData.baseOpacity * (coreGroup.userData.selected ? 1.7 : coreGroup.userData.hovered ? 1.45 : 1)
      if (coreHalo.material) coreHalo.material.opacity = coreHalo.material.userData.baseOpacity * (coreGroup.userData.selected ? 1.8 : coreGroup.userData.hovered ? 1.5 : 1)
      coreShell.rotation.y += 0.0008 * motionFactor
      coreShell.rotation.x += 0.00045 * motionFactor
      coreHelices.forEach((helix, index) => {
        helix.rotation.y += 0.0009 * (index % 2 === 0 ? 1 : -1) * motionFactor
        helix.rotation.x += 0.00035 * motionFactor
      })
    }
    coreRings.forEach((ring, index) => {
      ring.rotation.z += 0.00035 * (index + 1) * motionFactor
      ring.rotation.y = yaw * 0.3 + index * 0.12
    })
    applyCamera()
    updateLabels()
    try {
      renderer.render(scene, camera)
    } catch (error) {
      setPaused(true)
      callbacks.onFailure({ code: 'render-failed', detail: error instanceof Error ? error.message : String(error) })
      return
    }
    if (focusing && !focusTransitionActive) emitCamera()
    if (!paused && !disposed) animationFrame = requestAnimationFrame(animate)
  }

  function onPointerDown(event: PointerEvent) {
    cancelFocusTransition()
    panning = event.button === 1 || event.shiftKey
    dragging = !panning
    didDrag = false
    lastX = event.clientX
    lastY = event.clientY
    renderer.domElement.setPointerCapture?.(event.pointerId)
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging && !panning) {
      const hoverId = objectAt(event)
      setHover(hoverId)
      renderer.domElement.style.cursor = hoverId ? "pointer" : "grab"
      return
    }
    const deltaX = event.clientX - lastX
    const deltaY = event.clientY - lastY
    if (Math.abs(deltaX) + Math.abs(deltaY) > 2) didDrag = true
    if (panning) {
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0)
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1)
      const panScale = distance * 0.0018
      target.addScaledVector(right, -deltaX * panScale)
      target.addScaledVector(up, deltaY * panScale)
    } else {
      yaw -= deltaX * 0.006
      pitch = Math.max(-1.15, Math.min(1.15, pitch + deltaY * 0.004))
    }
    lastX = event.clientX
    lastY = event.clientY
  }

  function onPointerUp(event: PointerEvent) {
    dragging = false
    panning = false
    if (renderer.domElement.hasPointerCapture?.(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId)
    emitCamera()
    renderer.domElement.style.cursor = hoveredId ? "pointer" : "grab"
  }

  function onClick(event: MouseEvent) {
    if (didDrag) {
      didDrag = false
      return
    }
    const id = objectAt(event)
    if (id) setSelection(id)
  }

  function onDoubleClick(event: MouseEvent) {
    if (didDrag) {
      didDrag = false
      return
    }
    const id = objectAt(event)
    if (id) callbacks.onEnterRequest?.(id)
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault()
    cancelFocusTransition()
    userZoomed = true
    distance = Math.max(2.6, Math.min(18, distance + event.deltaY * 0.006))
    emitCamera()
  }

  const { signal } = listenerOwner
  const canvas = renderer.domElement
  const labelId = (target: EventTarget | null) => target instanceof Element
    ? target.closest<HTMLElement>("[data-object-id]")?.dataset.objectId
    : undefined
  canvas.addEventListener("pointerdown", onPointerDown, { signal })
  canvas.addEventListener("pointermove", onPointerMove, { signal })
  canvas.addEventListener("pointerup", onPointerUp, { signal })
  canvas.addEventListener("pointercancel", onPointerUp, { signal })
  canvas.addEventListener("pointerleave", () => { setHover(undefined); canvas.style.cursor = "grab"; }, { signal })
  canvas.addEventListener("click", onClick, { signal })
  canvas.addEventListener("dblclick", onDoubleClick, { signal })
  canvas.addEventListener("wheel", onWheel, { passive: false, signal })
  canvas.addEventListener("webglcontextlost", () => {
    setPaused(true)
    callbacks.onFailure({ code: 'context-lost' })
  }, { signal })
  labelLayer.addEventListener("click", event => {
    const id = labelId(event.target)
    if (id) setSelection(id)
  }, { signal })
  labelLayer.addEventListener("dblclick", event => {
    const id = labelId(event.target)
    if (id) callbacks.onEnterRequest?.(id)
  }, { signal })
  labelLayer.addEventListener("keydown", event => {
    const id = labelId(event.target)
    if (id && event.key === "Enter") {
      event.preventDefault()
      callbacks.onEnterRequest?.(id)
    }
  }, { signal })
  labelLayer.addEventListener("pointerover", event => { setHover(labelId(event.target)); }, { signal })
  labelLayer.addEventListener("pointerout", event => { setHover(labelId(event.relatedTarget)); }, { signal })
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { resize(); }) : undefined
  resizeObserver?.observe(mount)
  window.addEventListener("resize", () => { resize(); }, { signal })
  resize()
  applyCamera()
  setSelection(selectedId, false, false)
  applyMode(mode)
  animationFrame = requestAnimationFrame(animate)

  function getCamera(): OceanCameraState {
    applyCamera()
    return { position: camera.position.toArray(), target: target.toArray(), zoom: camera.zoom }
  }

  function emitCamera() {
    callbacks.onCameraChange?.(getCamera())
  }

  function setPaused(value: boolean) {
    if (paused === value || disposed) return
    paused = value
    if (value) {
      cancelAnimationFrame(animationFrame)
      cancelFocusTransition()
      setHover(undefined)
    } else animationFrame = requestAnimationFrame(animate)
  }

  return {
    updateProjection(nextProjection: DisplayProjection) {
      if (projection === nextProjection) return
      const previousSelection = selectedId
      setHover(undefined)
      buildProjection(nextProjection)
      setSelection(previousSelection && sourceObjects.has(previousSelection) ? previousSelection : projection.aggregationCore.id, false, false)
      applyMode(mode)
      resize()
    },
    setMode: applyMode,
    setSelection,
    focus,
    getCamera,
    setCamera(state: OceanCameraState) {
      cancelFocusTransition()
      target.fromArray(state.target)
      const offset = new THREE.Vector3().fromArray(state.position).sub(target)
      distance = Math.max(0.1, offset.length())
      yaw = Math.atan2(offset.x, offset.z)
      pitch = Math.asin(THREE.MathUtils.clamp(offset.y / distance, -1, 1))
      camera.zoom = state.zoom
      camera.updateProjectionMatrix()
      userZoomed = true
      applyCamera()
    },
    setHover,
    setEventSeq(seq: number | undefined) {
      replayEvent = seq
      applyEventVisibility()
    },
    setLowMotion(value: boolean) { lowMotion = options.reducedMotion || value; },
    setAutoOrbit(value: boolean) { autoOrbit = value; },
    setVisualSettings(settings: OceanVisualSettings) {
      visualSettings = settings
      applyParticleOpacity()
    },
    setPaused,
    resize,
    getCoreProjection() {
      const screen = corePosition.clone().project(camera)
      return { x: (screen.x + 1) * width / 2, y: (1 - screen.y) * height / 2, visible: Math.abs(screen.z) < 1 }
    },
    getDiagnostics() {
      return { profile: { ...renderProfile, maxPixelRatio: renderer.getPixelRatio() }, renderer: { ...renderer.info.render }, memory: { ...renderer.info.memory } }
    },
    reset() {
      yaw = 0.25
      pitch = 0.2
      distance = defaultDistance
      userZoomed = false
      camera.zoom = 1
      cancelFocusTransition()
      target.copy(corePosition)
      resize()
      setHover(undefined)
      emitCamera()
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(animationFrame)
      listenerOwner.abort()
      resizeObserver?.disconnect()
      clearProjectionObjects()
      projectionGeometry.dispose()
      fragmentGeometry.dispose()
      pickGeometry.dispose()
      pickMaterial.dispose()
      glowTexture?.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
