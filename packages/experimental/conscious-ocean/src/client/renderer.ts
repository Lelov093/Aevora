/** Renderer-neutral client seam for the first Conscious Ocean 3D slice. */

import type { CognitiveSourceId } from '../types.ts'
import type { OceanSceneProjection } from '../scene-projection.ts'

/** Renderer backend selected by capability detection. */
export type OceanRendererBackend = 'webgl2' | '2d-fallback' | 'unavailable'

/** Spatial emphasis selected by the Conscious Space observation toolbar. */
export type OceanSceneMode = 'galaxy' | 'trace' | 'context' | 'replay'

/** Renderer lifecycle state exposed to the right-Sidebar UI. */
export type OceanRendererLifecycle = 'ready' | 'paused' | 'failed' | 'disposed'

/** Three-dimensional point or direction. */
export type OceanVector3 = readonly [number, number, number]

/** Camera state persisted by the Session-scoped view owner. */
export interface OceanCameraState {
  readonly position: OceanVector3
  readonly target: OceanVector3
  readonly zoom: number
}

/** Size and pixel-ratio input supplied by the host layout. */
export interface OceanRendererViewport {
  readonly width: number
  readonly height: number
  readonly devicePixelRatio: number
}

/** User-controlled visual emphasis for non-semantic renderer effects. */
export interface OceanVisualSettings {
  /** Relative opacity of generated environment and evidence particles. */
  readonly particleDensity: number
  /** Relative speed and pulse amplitude for renderer animation. */
  readonly motionIntensity: number
}

/** Capabilities reported after backend selection. */
export interface OceanRendererCapabilities {
  readonly backend: OceanRendererBackend
  readonly supportsPicking: boolean
  readonly supportsBloom: boolean
  readonly maxDevicePixelRatio: number
}

/** Screen projection of a world-space marker within the renderer viewport. */
export interface OceanRendererScreenPoint {
  readonly x: number
  readonly y: number
  readonly visible: boolean
}

/** A structured renderer failure; raw Error instances do not cross the seam. */
export interface OceanRendererFailure {
  readonly code: 'webgl2-unavailable' | 'context-lost' | 'resource-limit' | 'render-failed' | 'disposed'
  readonly detail?: string
}

/** Current renderer state observed by the UI. */
export interface OceanRendererSnapshot {
  readonly lifecycle: OceanRendererLifecycle
  readonly capabilities: OceanRendererCapabilities
  readonly camera: OceanCameraState
  readonly sceneVersion: number
  readonly coreProjection?: OceanRendererScreenPoint
}

/** Callbacks owned by the Session-scoped Ocean UI. */
export interface OceanRendererCallbacks {
  /** @param sourceId - selected source node, or undefined when selection clears. */
  readonly onSelect: (sourceId: CognitiveSourceId | undefined) => void
  /** @param sourceId - hovered source node, or undefined when the pointer leaves. */
  readonly onHover: (sourceId: CognitiveSourceId | undefined) => void
  /** @param camera - camera state after a user gesture. */
  readonly onCameraChange: (camera: OceanCameraState) => void
  /** @param failure - structured failure suitable for localized UI handling. */
  readonly onFailure: (failure: OceanRendererFailure) => void
}

/** Inputs required to create one renderer instance for one mounted Session view. */
export interface OceanRendererCreateOptions {
  readonly mount: HTMLElement
  readonly viewport: OceanRendererViewport
  readonly reducedMotion: boolean
  readonly visualSettings: OceanVisualSettings
  readonly initialCamera: OceanCameraState
  readonly callbacks: OceanRendererCallbacks
}

/** One renderer instance owned by one mounted right-Sidebar view. */
export interface OceanRendererHandle {
  /** @returns the current lifecycle, capability, camera, and scene version. */
  readonly getSnapshot: () => OceanRendererSnapshot
  /** @param listener - called after renderer state changes. @returns unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void
  /** @param scene - immutable scene projection to draw. */
  readonly setScene: (scene: OceanSceneProjection) => void
  /** @param viewport - current right-Sidebar viewport. */
  readonly resize: (viewport: OceanRendererViewport) => void
  /** @param camera - a validated camera state. */
  readonly setCamera: (camera: OceanCameraState) => void
  /** @param paused - whether animation and render scheduling should pause. */
  readonly setPaused: (paused: boolean) => void
  /** @param settings - visual intensity values owned by the current view. */
  readonly setVisualSettings: (settings: OceanVisualSettings) => void
  /** @param mode - spatial emphasis for the current observation scene. */
  readonly setMode: (mode: OceanSceneMode) => void
  /** @param eventSeq - selected recorded event, or undefined to show the full replay. */
  readonly setReplayEvent: (eventSeq: number | undefined) => void
  /** @param sourceId - node to focus, or undefined to restore the world view. */
  readonly focus: (sourceId: CognitiveSourceId | undefined) => void
  /** Release GPU, DOM, listeners, and animation resources. */
  readonly dispose: () => void
}

/**
 * Replaceable renderer factory. The first implementation candidate is Three.js
 * WebGL2; the interface deliberately contains no Three.js types.
 */
export interface OceanRendererFactory {
  readonly preferredBackend: 'webgl2'
  /** @param options - Session-owned mount, camera, accessibility, and callbacks. @returns a ready or failed renderer handle. */
  readonly create: (options: OceanRendererCreateOptions) => Promise<OceanRendererHandle>
}
