/** Aevora's Session-scoped Temp-pre viewport and review controls. */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivationTraceEvent, ActivationTraceStatus, CognitiveNode, CognitiveWorldSnapshot, ProvenanceStatus, SourceEvidence } from '../types.ts'
import { CognitiveSourceId } from '../types.ts'
import type { OceanSceneProjection } from '../scene-projection.ts'
import type { ConsciousOceanClientEventWindow } from './scene-source.ts'
import { buildDisplayProjection, type DisplayProjection, type DisplaySource } from './display-projection.ts'
import { buildDrilldownProjection, buildRecursiveIndex, type OceanDescriptor } from './recursive-view.ts'
import { createThreeWebGL2RendererFactory, isWorkspaceRenderer, type WorkspaceRenderer } from './scene/renderer-factory.ts'
import type { OceanCameraState, OceanRendererFactory, OceanRendererFailure, OceanRendererHandle, OceanRendererSnapshot, OceanSceneMode } from './renderer.ts'
import { regionTokens } from './scene/visual-tokens.ts'
import { sourceTypeLabel, stageLabels as stages, type ConsciousOceanKey } from './locales.ts'
import css from './OceanTab.module.css'

/** Read faces bound to the Session selected by the right Sidebar. */
export interface ConsciousOceanInjected {
  readonly rendererFactory?: OceanRendererFactory
  readonly sessionKey?: string
  readonly scene?: OceanSceneProjection
  readonly hooks: {
    readonly scene: HostObservable<OceanSceneProjection | undefined>
    readonly world: HostObservable<CognitiveWorldSnapshot | undefined>
    readonly eventWindow: HostObservable<ConsciousOceanClientEventWindow | undefined>
  }
}

/** Props for the registered Conscious Ocean slot. */
export type ConsciousOceanProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'consciousOcean'> & InjectFace<ConsciousOceanInjected>

type Translate = ConsciousOceanProps['t']
const factoryDefault = createThreeWebGL2RendererFactory()
const defaultCamera: OceanCameraState = { position: [1.794, 1.47, 7.027], target: [0, 0, 0], zoom: 1 }
const defaultSettings = { particleDensity: 1, motionIntensity: 1 }
const modes: readonly OceanSceneMode[] = ['galaxy', 'trace', 'context', 'replay']
const activationStatus: Record<ActivationTraceStatus, ConsciousOceanKey> = {
  forming: 'statusForming', prepared: 'statusPrepared', submitted: 'statusSubmitted', completed: 'statusCompleted',
  failed: 'statusFailed', cancelled: 'statusCancelled', rejected_before_dispatch: 'statusRejected', unknown: 'statusUnknown',
}
const evidenceKeys: Record<ProvenanceStatus, ConsciousOceanKey> = {
  observed: 'observed', derived: 'derived', estimated: 'estimated', simulated: 'simulated', unavailable: 'statusUnavailable',
}
const objectKeys: Record<OceanDescriptor['kind'], ConsciousOceanKey> = {
  'aggregation-core': 'aggregationCore', region: 'region', neighborhood: 'neighborhood', source: 'source',
  projection: 'projection', fragment: 'fragment', packet: 'sourcePacket',
}

interface Cursor { traceId: string; eventSeq: number }
interface ParentView {
  enteredId: string
  camera: OceanCameraState | undefined
  mode: OceanSceneMode
  selection: string | undefined
  cursor: Cursor | undefined
}
interface WorkspaceProps {
  t: Translate
  scene: OceanSceneProjection | undefined
  world: CognitiveWorldSnapshot | undefined
  eventWindow: ConsciousOceanClientEventWindow | undefined
  evidence: 'complete' | 'partial' | 'unavailable' | undefined
  traceStatus: ActivationTraceStatus | null | undefined
  visible: boolean
  fullscreen: boolean
  factory: OceanRendererFactory
}

/**
 * @param props - Localized slot and Session bindings supplied by the client plugin.
 * @returns One workspace per visible Session tab occurrence.
 */
export function OceanTab(props: ConsciousOceanProps): ReactNode {
  const scene = props.useScene(value => value)
  const world = props.useWorld(value => value)
  const eventWindow = props.useEventWindow(value => value)
  const session = props.useProjection('consciousOcean/session')
  const { tab, sidebar } = props.useTabInfo()
  return <OceanWorkspace key={props.sessionKey} t={props.t} scene={props.scene ?? scene} world={world} eventWindow={eventWindow}
    evidence={session?.activationEvidence} traceStatus={session?.latestTraceStatus} visible={tab.visible}
    fullscreen={sidebar.fullscreen} factory={props.rendererFactory ?? factoryDefault} />
}

function canEnter(record: OceanDescriptor | undefined): record is OceanDescriptor {
  return record !== undefined && record.kind !== 'packet' && record.kind !== 'aggregation-core'
}

function modeKey(event: KeyboardEvent<HTMLButtonElement>, mode: OceanSceneMode, choose: (next: OceanSceneMode) => void) {
  const tabList = event.currentTarget.parentElement
  const index = modes.indexOf(mode)
  const next = event.key === 'ArrowRight' ? (index + 1) % modes.length
    : event.key === 'ArrowLeft' ? (index + modes.length - 1) % modes.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1 : undefined
  if (next === undefined) return
  const value = modes[next]
  if (value === undefined) return
  event.preventDefault()
  choose(value)
  tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}

function OceanWorkspace({ t, scene, world, eventWindow, visible, fullscreen, factory, evidence, traceStatus }: WorkspaceProps) {
  const uid = useId()
  const mount = useRef<HTMLDivElement>(null)
  const labels = useRef<HTMLDivElement>(null)
  const inspector = useRef<HTMLElement>(null)
  const [renderer, setRenderer] = useState<OceanRendererHandle>()
  const [snapshot, setSnapshot] = useState<OceanRendererSnapshot>()
  const [failure, setFailure] = useState<OceanRendererFailure>()
  const [diagnostics, setDiagnostics] = useState<ReturnType<WorkspaceRenderer['diagnostics']>>()
  const [mode, setMode] = useState<OceanSceneMode>('galaxy')
  const [selection, setSelection] = useState<string>()
  const [cursor, setCursor] = useState<Cursor>()
  const [path, setPath] = useState<ParentView[]>([])
  const [twoD, setTwoD] = useState(false)
  const [showObjectLabels, setShowObjectLabels] = useState(true)
  const [lowMotion, setLowMotion] = useState(false)
  const [orbit, setOrbit] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  const [inspectOpen, setInspectOpen] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden')
  const requestedView = useRef<{ camera?: OceanCameraState; focus?: string }>()

  const full = useMemo(() => {
    if (!scene || (world && world.worldVersion !== scene.worldVersion)) return undefined
    return buildDisplayProjection(scene, world, t)
  }, [scene, world, t])
  const index = useMemo(() => full ? buildRecursiveIndex(full) : undefined, [full])
  const invalidDepth = path.findIndex(frame => !index?.descriptors.has(frame.enteredId))
  const validDepth = invalidDepth < 0 ? path.length : invalidDepth
  const viewRoot = path[validDepth - 1]?.enteredId
  const projection = useMemo(() => full && index && viewRoot ? buildDrilldownProjection(full, index, viewRoot) : full, [full, index, viewRoot])
  const localIndex = useMemo(() => projection ? buildRecursiveIndex(projection) : undefined, [projection])
  const record = localIndex?.descriptors.get(selection ?? '') ?? localIndex?.descriptors.get(viewRoot ?? localIndex.rootId)
  const events = full?.traceEvents
  const current = cursor?.traceId === full?.traceId && events?.some(event => event.eventSeq === cursor?.eventSeq) ? cursor?.eventSeq : undefined
  const shownEvent = current ?? events?.at(-1)?.eventSeq
  const inspectedEvent = events?.find(event => event.eventSeq === shownEvent)
  const inspectorEvent = mode === 'trace' || mode === 'replay' ? inspectedEvent : undefined
  const traceId = scene?.aggregationCore.traceId
  const submissionConfirmed = useMemo(() => scene?.manifest?.status === 'submitted'
    || events?.some(event => event.stage === 'activation.submitted') === true
    || eventWindow?.entries.some(entry => entry.type === 'event'
      && entry.event.type === 'cognition/request-submitted' && entry.event.data.traceId === traceId) === true,
  [scene?.manifest?.status, events, eventWindow, traceId])
  const workspace = renderer && isWorkspaceRenderer(renderer) ? renderer : undefined
  const fallback = snapshot?.capabilities.backend === '2d-fallback' || snapshot?.capabilities.backend === 'unavailable'
  const showList = twoD || fallback
  const presentationActive = visible && documentVisible
  const sceneOpen = presentationActive && !showList && projection !== undefined

  useEffect(() => {
    const update = () => { setDocumentVisible(document.visibilityState !== 'hidden') }
    document.addEventListener('visibilitychange', update)
    return () => { document.removeEventListener('visibilitychange', update) }
  }, [])

  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const update = () => { setReducedMotion(preference?.matches ?? false) }
    preference?.addEventListener('change', update)
    return () => { preference?.removeEventListener('change', update) }
  }, [])

  useEffect(() => {
    if (!mount.current || !labels.current) return
    const canvasHost = mount.current
    let active = true
    let owned: OceanRendererHandle | undefined
    let stop: (() => void) | undefined
    const options = {
      mount: canvasHost,
      labelLayer: labels.current,
      viewport: { width: canvasHost.clientWidth, height: canvasHost.clientHeight, devicePixelRatio: window.devicePixelRatio || 1 },
      reducedMotion,
      visualSettings: defaultSettings,
      initialCamera: defaultCamera,
      onObjectSelect(id: string | undefined) { if (active) setSelection(id) },
      onEnterRequest(id: string) { if (active) enterRef.current(id) },
      callbacks: {
        onSelect(id: string | undefined) { if (active) setSelection(id) },
        onHover() {},
        onCameraChange() {},
        onFailure(value: OceanRendererFailure) { if (active) setFailure(value) },
      },
    }
    setRenderer(undefined)
    setFailure(undefined)
    setSnapshot(undefined)
    const initialize = async () => {
      try {
        const handle = await factory.create(options)
        if (!active) {
          handle.dispose()
          return
        }
        owned = handle
        stop = handle.subscribe(() => { if (active) setSnapshot(handle.getSnapshot()) })
        setSnapshot(handle.getSnapshot())
        setRenderer(handle)
      } catch (error) {
        if (active) setFailure({ code: 'render-failed', detail: error instanceof Error ? error.message : String(error) })
      }
    }
    void initialize()
    return () => {
      active = false
      stop?.()
      owned?.dispose()
    }
  }, [factory, reducedMotion])

  useLayoutEffect(() => {
    if (!renderer || !scene || !projection) return
    if (!workspace) {
      renderer.setScene(scene)
      return
    }
    workspace.setDisplayProjection(projection)
    const request = requestedView.current
    requestedView.current = undefined
    if (request?.camera) renderer.setCamera(request.camera)
    if (request?.focus) workspace.selectObject(request.focus, true)
  }, [renderer, workspace, scene, projection])

  useLayoutEffect(() => {
    renderer?.setMode(mode)
    renderer?.setReplayEvent(mode === 'replay' ? shownEvent : undefined)
    workspace?.selectObject(record?.id, false)
    workspace?.setLowMotion(lowMotion || reducedMotion)
    workspace?.setAutoOrbit(orbit && !lowMotion && !reducedMotion)
    renderer?.setPaused(!sceneOpen)
  }, [renderer, workspace, mode, shownEvent, record?.id, lowMotion, reducedMotion, orbit, sceneOpen])

  useEffect(() => {
    if (!workspace || !sceneOpen) return
    const sample = () => { setDiagnostics(workspace.diagnostics()) }
    sample()
    const timer = window.setInterval(sample, 1000)
    return () => { window.clearInterval(timer) }
  }, [workspace, sceneOpen])

  useEffect(() => {
    if (!playing || !presentationActive || mode !== 'replay' || !full || !events?.length) return
    const traceId = full.traceId
    const timer = window.setInterval(() => {
      setCursor(previous => {
        const position = previous?.traceId === traceId ? events.findIndex(event => event.eventSeq === previous.eventSeq) : -1
        const next = events[(position + 1) % events.length]
        return next ? { traceId, eventSeq: next.eventSeq } : undefined
      })
    }, 900)
    return () => { window.clearInterval(timer) }
  }, [playing, presentationActive, mode, full?.traceId, events])

  useEffect(() => {
    if (invalidDepth >= 0 && full) setPath(previous => previous.slice(0, invalidDepth))
  }, [invalidDepth, full])

  function select(id: string, focus = true) {
    setSelection(id)
    if (workspace) workspace.selectObject(id, focus)
    else if (focus) renderer?.focus(CognitiveSourceId(id))
  }

  function backTo(depth: number) {
    const frame = path[depth]
    if (!frame) return
    requestedView.current = frame.camera ? { camera: frame.camera } : {}
    setPath(path.slice(0, depth))
    setSelection(frame.selection)
    setMode(frame.mode)
    setCursor(frame.cursor)
    setPlaying(false)
  }

  function enter(id: string) {
    if (id === viewRoot) return
    const existing = path.findIndex(frame => frame.enteredId === id)
    if (existing >= 0 && existing < validDepth - 1) { backTo(existing + 1); return }
    const next = localIndex?.descriptors.get(id)
    if (!canEnter(next) || !index?.descriptors.has(id)) return
    if (id === index.descriptors.get(viewRoot ?? '')?.parentId) {
      backTo(validDepth - 1)
      return
    }
    requestedView.current = { focus: id }
    setPath(previous => {
      if (previous.some(frame => frame.enteredId === id)) return previous
      return [...previous.slice(0, validDepth), {
        enteredId: id, camera: workspace?.camera() ?? renderer?.getSnapshot().camera, mode, selection: record?.id, cursor,
      }]
    })
    setSelection(id)
    setPlaying(false)
    setRailOpen(false)
  }

  const enterRef = useRef(enter)
  useLayoutEffect(() => { enterRef.current = enter })

  function reset() {
    if (path.length > 0 && full) requestedView.current = { focus: full.aggregationCore.id }
    setPath([])
    setMode('galaxy')
    setCursor(undefined)
    setSelection(undefined)
    setPlaying(false)
    setTwoD(false)
    setLowMotion(false)
    setOrbit(true)
    workspace?.reset()
  }

  function chooseMode(next: OceanSceneMode) {
    setMode(next)
    if (next !== 'replay') setPlaying(false)
    if (next === 'context' && projection?.contextFragments[0]) select(projection.contextFragments[0].id)
  }

  function selectEvent(event: NonNullable<typeof inspectedEvent>) {
    setCursor({ traceId: event.traceId, eventSeq: event.eventSeq })
    if (mode === 'galaxy') setMode('trace')
  }

  function reveal(id: string, nextMode: OceanSceneMode) {
    setMode(nextMode)
    setPlaying(false)
    if (!localIndex?.descriptors.has(id)) {
      requestedView.current = { focus: id }
      setPath([])
      setSelection(id)
    } else select(id)
  }

  const statusKey = traceStatus == null ? 'statusUnknown' : activationStatus[traceStatus]
  const windowKey = eventWindow === undefined ? 'statusUnknown' : eventWindow.hasMore ? 'evidencePartial' : 'evidenceComplete'
  const loadKey = eventWindow === undefined || eventWindow.hasMore ? 'loading' : 'noTrace'
  const detailTier = diagnostics?.profile.tier
  const frameCount = diagnostics?.renderer.frame
  const emptyModeText = mode === 'context' && projection?.contextFragments.length === 0 ? t('contextEmpty')
    : events?.length === 0 && mode === 'replay' ? t('replayEmpty')
      : events?.length === 0 && mode === 'trace' ? t('traceEmpty') : undefined
  const list = useMemo(() => [...(localIndex?.descriptors.values() ?? [])].filter(item => {
    if (item.kind === 'projection') return (mode !== 'galaxy' || projection?.recursiveView) && (mode !== 'replay' || item.item.eventSeq <= (shownEvent ?? -Infinity))
    if (item.kind === 'fragment') return mode !== 'galaxy' && (mode !== 'replay' || (item.item.eventSeq !== undefined && item.item.eventSeq <= (shownEvent ?? -Infinity)))
    return true
  }), [localIndex, mode, projection?.recursiveView, shownEvent])
  const visibleRecord = showList && record && !list.includes(record) ? undefined : record
  useLayoutEffect(() => {
    if (inspector.current) inspector.current.scrollTop = 0
  }, [visibleRecord?.id])

  return <section className={css.surface} aria-label={t('tabTitle')} data-conscious-ocean-mode={mode}
    data-conscious-ocean-visual="temp-pre" data-fullscreen={fullscreen} data-conscious-ocean-trace={full?.traceId}
    data-conscious-ocean-renderer={snapshot?.capabilities.backend ?? 'pending'} data-conscious-ocean-failure={failure?.code}
    data-conscious-ocean-scene-version={snapshot?.sceneVersion ?? 0} data-event-window-revision={eventWindow?.revision}
    data-event-window-change={eventWindow?.change.kind} data-render-frame={frameCount} data-draw-calls={diagnostics?.renderer.calls}
    data-render-triangles={diagnostics?.renderer.triangles} data-render-geometries={diagnostics?.memory.geometries}
    data-render-textures={diagnostics?.memory.textures} data-render-lod={detailTier}>
    <header className={css.topbar}>
      <div className={css.brand}><strong>{t('brand')}</strong><span>{t('spaceSubtitle')}</span></div>
      <div className={css['mode-tabs']} role="tablist" aria-label={t('tabTitle')}>
        {modes.map(item => <button type="button" role="tab" key={item} id={`${uid}-${item}`} aria-selected={mode === item}
          aria-controls={`${uid}-scene`} tabIndex={mode === item ? 0 : -1} onClick={() => chooseMode(item)}
          onKeyDown={event => modeKey(event, item, chooseMode)}>{t(item)}</button>)}
      </div>
      <div className={css['top-actions']}>
        <span className={css['fixture-badge']}>{t('runtime')}</span>
        <button type="button" aria-pressed={showObjectLabels} aria-controls={`${uid}-labels`}
          onClick={() => setShowObjectLabels(value => !value)}>{t('showObjectLabels')}</button>
        <button type="button" aria-pressed={orbit && !lowMotion && !reducedMotion} disabled={reducedMotion} onClick={() => { setOrbit(!orbit || lowMotion); setLowMotion(false) }}>{t('orbit')}</button>
        <button type="button" aria-pressed={showList} disabled={fallback} onClick={() => setTwoD(value => !value)}>{t(fallback ? 'fallback' : 'check2d')}</button>
        <button type="button" onClick={() => validDepth > 0 ? backTo(validDepth - 1) : reset()}>{t(validDepth > 0 ? 'back' : 'backCore')}</button>
        <button type="button" aria-pressed={lowMotion || reducedMotion} disabled={reducedMotion} onClick={() => setLowMotion(value => !value)}>{t('lowMotion')}</button>
        <button type="button" onClick={reset}>{t('resetView')}</button>
      </div>
    </header>
    <div className={css.workspace}>
      <nav className={css.rail} aria-label={t('rail')} data-expanded={railOpen}>
        <h2>{t('regions')}</h2>
        {projection?.regions.map(region => <button type="button" key={region.id} data-region-id={region.id} aria-pressed={record?.id === region.id}
          style={{ '--region-color': region.colorToken ? regionTokens[region.colorToken] : '#e8fbff' } as CSSProperties}
          onClick={() => select(region.id)} onDoubleClick={() => enter(region.id)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); enter(region.id) } }}>
          <span className={css['rail-key']} />{region.label}
        </button>)}
      </nav>
      <div className={css['space-shell']} id={`${uid}-scene`} role="tabpanel" aria-labelledby={`${uid}-${mode}`} data-conscious-ocean-viewport>
        <div className={css['scene-mount']} data-scene-state={projection ? 'ready' : 'empty'} ref={mount} hidden={showList || !projection} />
        <div className={css['label-layer']} id={`${uid}-labels`} ref={labels} data-ocean-label-layer hidden={!showObjectLabels || showList || !projection} />
        <div className={css['space-hud']}>
          <span>{t('layout')} · <strong>{t('stable')}</strong></span>
          <span>{t('provenance')} · <strong>{t(evidence === 'complete' ? 'evidenceComplete' : evidence === 'partial' ? 'evidencePartial' : full ? evidenceKeys[full.aggregationCore.evidence] : 'statusUnavailable')}</strong></span>
          <span>{t('window')} · <strong>{t(windowKey)}{eventWindow ? ` · ${eventWindow.entries.length}` : ''}</strong></span>
          {detailTier && <span>{t('lod')} · <strong>{t(detailTier)} · {t('observedNodes', { count: projection?.sources.length ?? 0 })} · {diagnostics?.renderer.calls} {t('drawCalls')}</strong></span>}
        </div>
        <nav className={css['drilldown-bar']} aria-label={t('path')}>
          <button className={css['drilldown-crumb']} type="button" aria-current={validDepth === 0 ? 'page' : undefined} onClick={() => backTo(0)}>{t('tabTitle')}</button>
          {path.slice(0, validDepth).map((frame, depth) => {
            const descriptor = index?.descriptors.get(frame.enteredId)
            if (!descriptor) return null
            return <span key={frame.enteredId} className={css.crumb}>
              <span className={css['drilldown-separator']} aria-hidden="true">/</span>
              <button className={css['drilldown-crumb']} type="button" aria-current={depth === validDepth - 1 ? 'page' : undefined}
                onClick={() => backTo(depth + 1)}>{descriptor.item.label}</button>
            </span>
          })}
        </nav>
        <div className={css['compact-actions']}>
          <button type="button" aria-expanded={railOpen} onClick={() => { setRailOpen(!railOpen); setInspectOpen(false) }}>{t('regions')}</button>
          <button type="button" aria-expanded={inspectOpen} onClick={() => { setInspectOpen(!inspectOpen); setRailOpen(false) }}>{t('inspector')}</button>
        </div>
        {!projection && <div className={css.notice} role="status">{t(loadKey)}</div>}
        {failure && !fallback && <div className={css.notice} role="status">{t(failure.code === 'webgl2-unavailable' ? 'rendererUnavailable' : 'rendererFailed')}</div>}
        {projection && showList && <div className={css['two-d-view']} data-visible="true">
          <h2>{t(fallback ? 'fallback' : 'twoDTitle')}</h2>
          <div className={css['two-d-list']} data-ocean-object-list>
            {list.map(item => <button type="button" className={css['two-d-row']} key={item.id} data-object-id={item.id}
              aria-label={item.item.label} aria-pressed={visibleRecord?.id === item.id} onClick={() => select(item.id, false)}
              onDoubleClick={() => enter(item.id)} onKeyDown={event => {
                if (event.key === 'Enter' && canEnter(item)) { event.preventDefault(); enter(item.id) }
              }}>
              <strong>{t(objectKeys[item.kind])}</strong><span>{item.item.label}</span>
              <span>{item.parentId && index?.descriptors.get(item.parentId)?.item.label}</span><span>{t(evidenceKeys[item.item.evidence])}</span>
            </button>)}
            {events?.map(event => <button type="button" className={css['two-d-row']} key={event.eventSeq}
              aria-pressed={event.eventSeq === shownEvent} onClick={() => selectEvent(event)}>
              <strong>{t('event')} {event.eventSeq}</strong><span>{t(stages[event.stage])}</span>
              <span>{event.sourceRefs.map(id => index?.descriptors.get(id)?.item.label).filter(label => label !== undefined).join(', ')}</span><span>{t('observed')}</span>
            </button>)}
          </div>
        </div>}
      </div>
      <aside ref={inspector} className={css.inspector} aria-label={t('inspector')} data-expanded={inspectOpen}>
        <h2>{t('inspector')}</h2>
        {visibleRecord ? <Inspector key={visibleRecord.id} t={t} record={visibleRecord} projection={full} event={inspectorEvent}
          submissionConfirmed={submissionConfirmed} enter={enter} reveal={reveal} /> : <>
          <p className={css['inspector-copy']}>{t(projection ? 'statusUnavailable' : statusKey)}</p>
          {inspectorEvent && <>
            <p className={css['inspector-copy']}>{t(stages[inspectorEvent.stage])}</p>
            <details className={css['inspector-disclosure']}>
              <summary>{t('technicalDetails')}</summary>
              <InspectorFacts t={t} facts={eventFacts(inspectorEvent)} />
            </details>
          </>}
        </>}
        {emptyModeText && <p className={css['inspector-copy']}>{emptyModeText}</p>}
      </aside>
    </div>
    <footer className={css['bottom-bar']}>
      <div className={css['bottom-actions']}>
        <button type="button" aria-pressed={playing} disabled={!events?.length} onClick={() => {
          if (!playing && current === undefined) setCursor(undefined)
          setMode('replay')
          setPlaying(!playing)
        }}>{t(playing ? 'pause' : 'play')}</button>
        <button type="button" onClick={() => chooseMode('replay')}>{t('replay')}</button>
      </div>
      <div className={css['timeline-scroll']}>
        <div className={css.timeline} style={{ '--event-count': Math.max(1, events?.length ?? 0) } as CSSProperties} aria-label={t('timeline')}>
          {events?.map(event => <div key={event.eventSeq} className={css['timeline-step']}
            data-state={event.eventSeq === shownEvent ? 'current' : event.eventSeq < (shownEvent ?? -Infinity) ? 'done' : 'future'}>
            <button type="button" aria-label={`${t(stages[event.stage])} · ${event.eventSeq}`} aria-current={event.eventSeq === shownEvent ? 'step' : undefined}
              data-event-seq={event.eventSeq} title={t(stages[event.stage])} onClick={() => selectEvent(event)}>{event.eventSeq}</button>
            <span>{t(stages[event.stage])}</span>
          </div>)}
        </div>
      </div>
      <span className={css['bottom-status']}>{t(statusKey)}</span>
    </footer>
  </section>
}

type InspectorFact = readonly [ConsciousOceanKey, string | number | undefined]

const sourceKinds: Record<SourceEvidence['sourceKind'], ConsciousOceanKey> = {
  'user-confirmation': 'sourceUserConfirmation', 'session-event': 'sourceSessionEvent', external: 'sourceExternal', unknown: 'sourceUnknown',
}
const sourceStates: Record<DisplaySource['state'], ConsciousOceanKey> = {
  active: 'nodeActive', selected: 'nodeSelected', omitted: 'nodeOmitted', idle: 'nodeIdle',
}

function memoryStatus(detail: CognitiveNode | undefined): ConsciousOceanKey | undefined {
  if (detail?.deletionState === 'deleted') return 'memoryDeleted'
  if (detail?.deletionState === 'delete_pending') return 'memoryDeletionPending'
  if (detail?.recallState === 'forgotten') return 'recallDisabled'
  if (detail?.validityState === 'superseded') return 'memorySuperseded'
  if (detail?.validityState === 'expired') return 'memoryExpired'
  if (detail?.admissionState === 'candidate') return 'memoryPending'
  if (detail?.admissionState === 'rejected') return 'memoryRejected'
  if (detail?.admissionState === 'accepted') return 'memoryStored'
  return undefined
}

function eventFacts(event: ActivationTraceEvent): InspectorFact[] {
  return [['event', event.eventSeq], ['activation', event.stage], ['sourceId', event.sourceRefs.join(', ')], ['provenance', event.reasonCode]]
}

function InspectorFacts({ t, facts }: { t: Translate; facts: readonly InspectorFact[] }) {
  return <dl className={css.facts}>
    {facts.filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => <div key={key}>
      <dt>{t(key)}</dt><dd>{value}</dd>
    </div>)}
  </dl>
}

function Inspector({ t, record, projection, event, submissionConfirmed, enter, reveal }: {
  t: Translate
  record: OceanDescriptor
  projection: DisplayProjection | undefined
  event: ActivationTraceEvent | undefined
  submissionConfirmed: boolean
  enter: (id: string) => void
  reveal: (id: string, mode: OceanSceneMode) => void
}) {
  const facts: InspectorFact[] = [['objectId', record.id], ['provenance', record.item.evidence]]
  const statuses: string[] = []
  const manifests = record.kind === 'aggregation-core' ? projection?.contextFragments ?? [] : []
  let heading = record.item.label
  let summary: string | undefined
  let evidence: readonly SourceEvidence[] | undefined
  let sourceRefs: readonly string[] = []
  let linkedFragment: string | undefined

  if (record.kind === 'source') {
    const { detail, state, regionId, neighborhoodId } = record.item
    heading = t(sourceTypeLabel(detail?.kind))
    summary = record.item.summary?.trim() ? record.item.summary : t('sourceContentUnavailable')
    evidence = detail?.evidence ?? []
    if (detail?.scope === 'user') statuses.push(t('userMemory'))
    else if (detail?.scope?.startsWith('workspace:')) statuses.push(t('workspaceMemory'))
    const stateKey = memoryStatus(detail)
    if (stateKey) statuses.push(t(stateKey))
    if (state !== 'idle') statuses.push(t('sourceTraceState', { state: t(sourceStates[state]) }))
    facts.push(['region', regionId], ['neighborhood', neighborhoodId], ['revision', detail?.revision], ['scope', detail?.scope],
      ['state', state], ['sourceKind', detail?.kind], ['validity', detail?.validityState], ['storage', detail?.storageTier], ['recall', detail?.recallState],
      ['admission', detail?.admissionState], ['deletion', detail?.deletionState], ['epistemic', detail?.epistemicState],
      ['evidenceSources', detail?.evidence?.length])
    linkedFragment = projection?.contextFragments.find(item => item.sourceRefs.includes(record.id))?.id
  } else if (record.kind === 'projection') {
    const { sourceId, eventSeq, stage, state } = record.item
    statuses.push(t(stages[stage]))
    sourceRefs = [sourceId]
    facts.push(['sourceId', sourceId], ['event', eventSeq], ['activation', stage], ['state', state])
  } else if (record.kind === 'fragment') {
    const { detail, status, order, estimatedTokens } = record.item
    sourceRefs = record.item.sourceRefs
    const submission = detail?.submitted ?? (status === 'submitted' ? 'yes' : 'unknown')
    const compiled = detail?.compiled ?? (status === 'unknown' ? undefined : true)
    summary = t('fragmentSummary', { count: new Set(sourceRefs).size })
    statuses.push(t(compiled === undefined ? 'statusUnknown' : compiled ? 'fragmentCompiled' : 'notCompiled'),
      t(submission === 'yes' ? 'fragmentSubmitted' : submission === 'no' ? 'fragmentNotSubmitted' : 'submissionUnconfirmed'))
    facts.push(['fragmentOrder', order], ['sourceId', sourceRefs.join(', ')], ['estimatedTokens', estimatedTokens],
      ['state', status], ['compiled', compiled === undefined ? undefined : String(compiled)], ['submission', submission])
  } else if (record.kind === 'packet') {
    const { detail } = record.item
    sourceRefs = record.item.sourceRefs
    facts.push(['sourceId', sourceRefs.join(', ')], ['sourceKind', detail?.sourceKind], ['sourceSessionId', detail?.sessionId],
      ['event', detail?.eventSeq], ['externalSourceId', detail?.externalSourceId])
    if (detail) statuses.push(t(sourceKinds[detail.sourceKind]))
    if (record.item.evidence === 'unavailable') summary = t('packetUnavailable')
  } else if (record.kind === 'aggregation-core') {
    summary = t('coreSummary', { fragments: manifests.length, sources: new Set(manifests.flatMap(fragment => fragment.sourceRefs)).size })
    statuses.push(t(activationStatus[record.item.status]), t(submissionConfirmed ? 'fragmentSubmitted' : 'submissionUnconfirmed'))
    facts.push(['traceId', projection?.traceId], ['activation', record.item.status], ['submission', submissionConfirmed ? 'yes' : 'unknown'])
  } else if (record.kind === 'region') {
    summary = t('regionSummary', {
      neighborhoods: projection?.neighborhoods.filter(item => item.regionId === record.id).length ?? 0,
      sources: projection?.sources.filter(item => item.regionId === record.id).length ?? 0,
    })
  } else if (record.kind === 'neighborhood') {
    summary = t('sourceCount', { count: projection?.sources.filter(item => item.neighborhoodId === record.id).length ?? 0 })
    facts.push(['region', record.item.regionId])
  }

  const related = [...new Set(sourceRefs)].map(id => projection?.sources.find(source => source.id === id)).filter(item => item !== undefined)
  const firstRelated = related[0]
  const linkedText = record.kind === 'projection' ? firstRelated?.summary?.trim() : undefined
  const canViewSource = evidence !== undefined || sourceRefs.length > 0
  if (statuses.length === 0 || record.item.evidence === 'simulated' || record.item.evidence === 'unavailable') {
    statuses.push(t(evidenceKeys[record.item.evidence]))
  }

  return <>
    <div className={css['inspector-primary']} data-selected-object={record.id}>
      <h3>{heading}</h3>
      {summary && <p className={css['inspector-body']}>{summary}</p>}
      {linkedText && <>
        <span className={css['inspector-copy']}>{t('linkedSourceText')}</span>
        <p className={css['inspector-body']}>{linkedText}</p>
      </>}
      <div className={css['inspector-status']}>{[...new Set(statuses)].map(status => <span key={status}>{status}</span>)}</div>
    </div>
    {event && <p className={css['inspector-copy']}>{t('event')} · {t(stages[event.stage])}</p>}
    {(canViewSource || canEnter(record) || linkedFragment) && <div className={css['inspector-actions']}>
      {firstRelated && related.length === 1 && <button type="button" onClick={() => reveal(firstRelated.id, 'galaxy')}>{t('viewSource')}</button>}
      {canViewSource && related.length !== 1 && <details className={css['source-disclosure']}>
        <summary>{t('viewSource')}</summary>
        {evidence && evidence.length > 0 && <ul className={css['source-evidence']}>
          {evidence.map((item, index) => <li key={`${item.sourceKind}:${index}`}>{t(sourceKinds[item.sourceKind])}</li>)}
        </ul>}
        {related.map(source => <button type="button" key={source.id} onClick={() => reveal(source.id, 'galaxy')}>{source.label}</button>)}
        {(!evidence || evidence.length === 0) && related.length === 0 && <p className={css['inspector-copy']}>{t('sourceEvidenceUnavailable')}</p>}
      </details>}
      {canEnter(record) && <button type="button" onClick={() => enter(record.id)}>{t('openRecursive')}</button>}
      {linkedFragment && <button type="button" onClick={() => reveal(linkedFragment, 'context')}>{t('openFragment')}</button>}
    </div>}
    {manifests.length > 0 && <div className={css['context-manifest']}><span>{t('manifest')}</span>
      {manifests.map(item => <button type="button" key={item.id} className={css['context-manifest-row']} onClick={() => reveal(item.id, 'context')}>
        <span>{item.label}</span><em>{t('sourceCount', { count: new Set(item.sourceRefs).size })}</em>
      </button>)}
    </div>}
    <details className={css['inspector-disclosure']}>
      <summary>{t('technicalDetails')}</summary>
      <InspectorFacts t={t} facts={facts} />
      {evidence?.map((item, index) => <InspectorFacts key={`${item.sourceKind}:${index}`} t={t} facts={[
        ['sourceKind', item.sourceKind], ['sourceSessionId', item.sessionId], ['event', item.eventSeq], ['externalSourceId', item.externalSourceId],
      ]} />)}
      {event && <InspectorFacts t={t} facts={eventFacts(event)} />}
    </details>
  </>
}
