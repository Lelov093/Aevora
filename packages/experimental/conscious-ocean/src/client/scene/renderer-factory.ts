/** Public renderer adapter and the controls used by the product workspace. */

import { CognitiveSourceId } from '../../types.ts'
import { buildDisplayProjection, type DisplayProjection } from '../display-projection.ts'
import { buildRecursiveIndex } from '../recursive-view.ts'
import type { OceanCameraState, OceanRendererCreateOptions, OceanRendererFailure, OceanRendererHandle, OceanRendererSnapshot, OceanSceneMode } from '../renderer.ts'
import { createWorldScene } from './world-scene.ts'

interface WorkspaceRendererOptions extends OceanRendererCreateOptions {
  readonly labelLayer?: HTMLElement
  readonly onObjectSelect?: (id: string | undefined) => void
  readonly onEnterRequest?: (id: string) => void
}

/** Display controls used by the product tab to operate a renderer handle. */
export interface WorkspaceRenderer extends OceanRendererHandle {
  setDisplayProjection(projection: DisplayProjection): void
  selectObject(id: string | undefined, focus: boolean): void
  reset(): void
  camera(): OceanCameraState
  setLowMotion(enabled: boolean): void
  setAutoOrbit(enabled: boolean): void
  diagnostics(): ReturnType<NonNullable<ReturnType<typeof createWorldScene>>['getDiagnostics']> | undefined
}

/** Renderer factory with the product tab's scoped DOM and navigation inputs. */
export interface WorkspaceRendererFactory {
  readonly preferredBackend: 'webgl2'
  create(options: WorkspaceRendererOptions): Promise<WorkspaceRenderer>
}

/**
 * Create the adapter shared by the optional product tab and renderer-only consumers.
 * @returns A factory whose per-view handles own their WebGL and DOM resources.
 */
export function createThreeWebGL2RendererFactory(): WorkspaceRendererFactory {
  return { preferredBackend: 'webgl2', create: async options => createRenderer(options) }
}

/**
 * @param handle - Renderer optionally injected by the workspace owner.
 * @returns Whether the handle exposes the product's recursive view controls.
 */
export function isWorkspaceRenderer(handle: OceanRendererHandle): handle is WorkspaceRenderer {
  return 'setDisplayProjection' in handle
}

function createRenderer(options: WorkspaceRendererOptions): WorkspaceRenderer {
  const { mount, callbacks } = options
  const labelLayer = options.labelLayer ?? document.createElement('div')
  if (options.labelLayer === undefined) {
    Object.assign(labelLayer.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
    mount.append(labelLayer)
  }
  let engine: ReturnType<typeof createWorldScene>
  let projection: DisplayProjection | undefined
  let viewport = options.viewport
  let mode: OceanSceneMode = 'galaxy'
  let replayEvent: number | undefined
  let settings = options.visualSettings
  let cameraState = options.initialCamera
  let explicitCamera = options.labelLayer === undefined
  let lowMotion = options.reducedMotion
  let autoOrbit = true
  let fallback: HTMLDivElement | undefined
  let selectedId: string | undefined
  let paused = false
  let disposed = false
  let failed = false
  let sceneVersion = 0
  const listeners = new Set<() => void>()
  let snapshot: OceanRendererSnapshot

  function publish() {
    const diagnostics = engine?.getDiagnostics()
    const coreProjection = engine?.getCoreProjection()
    snapshot = {
      lifecycle: disposed ? 'disposed' : paused ? 'paused' : 'ready',
      capabilities: {
        backend: disposed ? 'unavailable' : failed ? '2d-fallback' : 'webgl2',
        supportsPicking: !disposed,
        supportsBloom: false,
        maxDevicePixelRatio: diagnostics?.profile.maxPixelRatio ?? viewport.devicePixelRatio,
      },
      camera: cameraState,
      sceneVersion,
      ...(coreProjection ? { coreProjection } : {}),
    }
    for (const listener of listeners) listener()
  }

  function renderFallback() {
    if (!failed || !projection || disposed || options.labelLayer !== undefined) return
    fallback ??= mount.appendChild(document.createElement('div'))
    const fragment = document.createDocumentFragment()
    for (const descriptor of buildRecursiveIndex(projection).descriptors.values()) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.objectId = descriptor.id
      button.setAttribute('aria-pressed', String(descriptor.id === selectedId))
      button.textContent = descriptor.item.label
      button.onclick = () => select(descriptor.id)
      fragment.append(button)
    }
    fallback.replaceChildren(fragment)
  }

  function select(id: string | undefined) {
    selectedId = id
    const sourceId = projection?.sources.find(source => source.id === id)?.id
    callbacks.onSelect(sourceId === undefined ? undefined : CognitiveSourceId(sourceId))
    options.onObjectSelect?.(id)
    for (const button of fallback?.querySelectorAll('button') ?? []) {
      button.setAttribute('aria-pressed', String(button.dataset.objectId === id))
    }
  }

  function handleFailure(failure: OceanRendererFailure) {
    failed = true
    engine?.dispose()
    engine = undefined
    callbacks.onFailure(failure)
    renderFallback()
    publish()
  }

  function setDisplayProjection(next: DisplayProjection) {
    if (disposed) {
      callbacks.onFailure({ code: 'disposed' })
      return
    }
    if (projection === next) return
    projection = next
    if (engine) engine.updateProjection(next)
    else if (!failed) {
      engine = createWorldScene({
        mount, labelLayer, projection: next, viewport, reducedMotion: options.reducedMotion, visualSettings: settings,
        callbacks: {
          onSelect: select,
          onHover(id) {
            const sourceId = projection?.sources.find(source => source.id === id)?.id
            callbacks.onHover(sourceId === undefined ? undefined : CognitiveSourceId(sourceId))
          },
          onCameraChange(value) {
            cameraState = value
            callbacks.onCameraChange(value)
            publish()
          },
          onFailure: handleFailure,
          onEnterRequest(id) { options.onEnterRequest?.(id) },
        },
      })
      if (explicitCamera) engine?.setCamera(cameraState)
      if (engine) cameraState = engine.getCamera()
      engine?.setLowMotion(lowMotion)
      engine?.setAutoOrbit(autoOrbit)
      engine?.setPaused(paused)
    }
    engine?.setMode(mode)
    engine?.setEventSeq(replayEvent)
    sceneVersion++
    renderFallback()
    publish()
  }

  publish()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setScene(scene) { setDisplayProjection(buildDisplayProjection(scene)) },
    setDisplayProjection,
    selectObject(id, focus) {
      selectedId = id
      engine?.setSelection(id, focus, false)
      if (focus && !engine && id) Array.from(fallback?.querySelectorAll('button') ?? []).find(button => button.dataset.objectId === id)?.focus()
    },
    setMode(next) { mode = next; engine?.setMode(mode) },
    setReplayEvent(seq) { replayEvent = seq; engine?.setEventSeq(seq) },
    setVisualSettings(next) { settings = next; engine?.setVisualSettings(next) },
    setPaused(value) {
      if (paused === value || disposed) return
      paused = value
      engine?.setPaused(value)
      publish()
    },
    setLowMotion(value) { lowMotion = value; engine?.setLowMotion(value) },
    setAutoOrbit(value) { autoOrbit = value; engine?.setAutoOrbit(value) },
    camera: () => engine?.getCamera() ?? cameraState,
    setCamera(next) {
      cameraState = next
      explicitCamera = true
      engine?.setCamera(next)
      publish()
    },
    resize(next) { viewport = next; engine?.resize(next); publish() },
    focus(id) { if (id === undefined) engine?.reset(); else engine?.focus(id) },
    reset() { engine?.reset() },
    diagnostics: () => engine?.getDiagnostics(),
    dispose() {
      if (disposed) return
      disposed = true
      engine?.dispose()
      engine = undefined
      fallback?.remove()
      if (options.labelLayer === undefined) labelLayer.remove()
      publish()
      listeners.clear()
    },
  }
}
