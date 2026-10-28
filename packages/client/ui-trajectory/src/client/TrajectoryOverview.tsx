/** User-facing process view over the target's incrementally indexed recorded turns. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { TurnNavigator, Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconClockOutlineRegular, IconInfoOutlineRegular, IconLoadingOutlineRegular, IconStopFillRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OverviewItem, OverviewState, OverviewTurn } from './overview-model.ts'
import type { TrajectoryTranslate } from './locales.ts'
import { COMPACTION_INTERRUPTED_ERROR } from './copy-codes.ts'
import { TrajectorySearchField } from './TrajectorySearchField.tsx'
import { TrajectorySearchIndex } from './trajectory-search-index.ts'
import { OverviewSearchText, hasParameterOnlyMatch } from './OverviewSearchText.tsx'
import { overviewNavigation } from './overview-navigation.ts'
import css from './overview.module.css'

const VIRTUAL_TURN_THRESHOLD = 40
const ESTIMATED_TURN_HEIGHT = 360

interface OverviewProps {
  readonly outline?: unknown
  readonly loadThrough?: ((seq: SessionSeq) => Promise<void>) | undefined
  readonly turns: readonly OverviewTurn[]
  readonly running: boolean
  readonly waiting: 'approval' | 'response' | undefined
  readonly waitingCallId?: string | undefined
  readonly loading: boolean
  readonly loadingOlder: boolean
  readonly hasMore: boolean
  readonly loadOlder: () => Promise<boolean>
  readonly inspect: (callId: string) => void
  readonly t: TrajectoryTranslate
}

function StatusIcon({ state }: { state: OverviewState | 'waiting' }) {
  const Icon = state === 'done' ? IconCheckOutlineRegular : state === 'error' ? IconWarningOutlineRegular : state === 'running' ? IconLoadingOutlineRegular : state === 'waiting' ? IconClockOutlineRegular : state === 'stopped' ? IconStopFillRegular : IconInfoOutlineRegular
  return <span className={css.statusIcon} data-state={state}><Icon className={state === 'running' ? css.spinning : undefined} /></span>
}

function itemState(item: OverviewItem, turn: OverviewTurn, running: boolean): OverviewState {
  return item.state === 'running' && (turn.ending !== undefined || !running) ? 'unknown' : item.state
}

function stateLabel(state: OverviewState | 'waiting', t: TrajectoryTranslate): string {
  return t(state === 'waiting' ? 'overview.waiting' : state === 'done' ? 'overview.completed' : state === 'running' ? 'overview.inProgress' : state === 'error' ? 'overview.failed' : state === 'stopped' ? 'overview.stopped' : 'overview.resultUnknown')
}

function title(item: OverviewItem, t: TrajectoryTranslate): string {
  switch (item.kind) {
    case 'tool': return t(`overview.action.${item.action ?? 'other'}`)
    case 'response': return t(item.state === 'running' ? 'overview.responseRunning' : 'overview.response')
    case 'context': return t('overview.context')
    case 'compaction': return t('overview.compaction')
    case 'retry': return t('overview.retry')
    case 'unknown': return t('overview.unknownRecord')
  }
}

function RecordDetails({ item, state, inspect, t, query, matched = false }: { item: OverviewItem; state: OverviewState | 'waiting'; inspect: OverviewProps['inspect']; t: TrajectoryTranslate; query: string; matched?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const text = item.text === COMPACTION_INTERRUPTED_ERROR ? t('layout.compactionInterrupted') : item.text
  const callId = item.callId
  return <div className={css.record}>
    {item.object && <p className={css.object}><OverviewSearchText text={item.object} query={query} /></p>}
    {item.kind === 'tool' && state === 'unknown' && <p className={css.issue}>{t('overview.noResult')}</p>}
    {item.kind === 'tool' && state === 'running' && <p className={css.secondary}>{t('overview.pendingResult')}</p>}
    {state === 'waiting' && <p className={css.secondary}>{t('overview.respond')}</p>}
    {state === 'error' && text && <p className={css.errorText}><OverviewSearchText text={text} query={query} /></p>}
    {text && state !== 'error' && <details className={css.disclosure} open={matched || expanded} onToggle={(event) =>{  setExpanded(event.currentTarget.open) }}><summary>{t(item.kind === 'tool' ? 'overview.details' : 'overview.responseDetails')}<IconChevronDownOutlineRegular /></summary>{(matched || expanded) && <pre className={css.recordText}><OverviewSearchText text={text} query={query} /></pre>}</details>}
    {item.toolName && (item.action === 'other' || matched) && <span className={css.toolName}><OverviewSearchText text={item.toolName} query={query} /></span>}
    {matched && hasParameterOnlyMatch(item, query) && <p className={css.secondary}>{t('overview.parameterMatch')}</p>}
    {item.duration !== undefined && <span className={css.duration}>{t('overview.duration', { seconds: Math.round(item.duration) / 1000 })}</span>}
    {callId !== undefined && <Button size="sm" variant="ghost" onClick={() => { inspect(callId) }}>{t('overview.inspect')}</Button>}
  </div>
}

function Activity({ item, turn, running, waitingCallId, inspect, t, matches, query, nested = false }: {
  item: OverviewItem
  turn: OverviewTurn
  running: boolean
  waitingCallId?: string | undefined
  inspect: OverviewProps['inspect']
  t: TrajectoryTranslate
  matches?: ReadonlySet<string> | null | undefined
  query: string
  nested?: boolean
}) {
  const state = item.state === 'running' && waitingCallId !== undefined && item.callId === waitingCallId ? 'waiting' : itemState(item, turn, running)
  return <li className={css.step} data-nested={nested || undefined}>
    <StatusIcon state={state} /><div className={css.stepBody}>
      <div className={css.stepTitle}><span>{title(item, t)}</span><span className={css.stateLabel} data-state={state}>{stateLabel(state, t)}</span>{item.retryCount !== undefined && <span className={css.secondary}>{t('overview.retryCount', { count: item.retryCount })}</span>}</div>
      <RecordDetails item={item} state={state} inspect={inspect} t={t} query={query} matched={matches?.has(item.id) === true} />
      {item.children?.length ? <ol className={css.children}>
        {item.children.map(child => <Activity key={child.id} item={child} turn={turn} running={running}
          waitingCallId={waitingCallId} inspect={inspect} t={t} matches={matches} query={query} nested />)}
      </ol> : null}
    </div>
  </li>
}

type ActivityGroup = [OverviewItem, ...OverviewItem[]]

function activities(items: readonly OverviewItem[]): readonly ActivityGroup[] {
  const groups: ActivityGroup[] = []
  for (const item of items) {
    if (item.kind === 'response' && item.text === '' && item.state === 'done') continue
    const previous = groups.at(-1)
    if (item.kind === 'tool' && item.action === 'read' && item.state === 'done' && previous?.every(member => member.kind === 'tool' && member.action === 'read' && member.state === 'done')) previous.push(item)
    else groups.push([item])
  }
  return groups
}

function ReadGroup({ items, turn, inspect, t, matches, query }: { items: readonly OverviewItem[]; turn: OverviewTurn; inspect: OverviewProps['inspect']; t: TrajectoryTranslate; matches?: ReadonlySet<string> | null | undefined; query: string }) {
  const [expanded, setExpanded] = useState(false)
  const matched = items.some(item => matches?.has(item.id))
  return <li className={css.step}><StatusIcon state="done" /><div className={css.stepBody}><details open={matched || expanded} onToggle={(event) =>{  setExpanded(event.currentTarget.open) }} className={css.readGroup}><summary><span className={css.stepTitle}>{t('overview.action.read')}<span className={css.secondary}>{t('overview.count', { count: items.length })}</span></span><span className={css.groupState}>{t('overview.completed')}<IconChevronDownOutlineRegular /></span></summary>{(matched || expanded) && <ol className={css.groupRecords}>{items.map(item => <Activity key={item.id} item={item} turn={turn} running={false} inspect={inspect} t={t} matches={matches} query={query} nested />)}</ol>}</details></div></li>
}

function hasIssue(item: OverviewItem): boolean {
  return item.state === 'error' || item.state === 'unknown' || item.state === 'stopped' || item.children?.some(hasIssue) === true
}

function Turn({ turn, running, waiting, waitingCallId, inspect, t, hasMore, collapsed, toggle, matches, query }: { turn: OverviewTurn; running: boolean; waiting: OverviewProps['waiting']; waitingCallId?: string | undefined; inspect: OverviewProps['inspect']; t: TrajectoryTranslate; hasMore: boolean; collapsed: boolean; toggle: () => void; matches: ReadonlySet<string> | null; query: string }) {
  const state = waiting ? 'waiting' : turn.ending?.state ?? (running ? 'running' : 'unknown')
  const groups = activities(turn.items)
  const noTools = !hasMore && turn.startedAt !== undefined && turn.ending?.state === 'done' && !turn.items.some(item => item.kind === 'tool')
  return <article className={css.turn} data-overview-turn={turn.turn} data-overview-key={turn.key} data-collapsed={collapsed || undefined}>
    <div className={css.kicker}>{turn.turn === undefined ? t('overview.between') : t('overview.request', { turn: turn.turn })}</div>
    <h2 className={css.request}><OverviewSearchText text={turn.request || (turn.turn === undefined ? t('overview.between') : t('overview.noRequest'))} query={query} /></h2>
    <div className={css.overall} data-state={state}><StatusIcon state={state} /><span>{waiting ? t(waiting === 'approval' ? 'overview.approval' : 'overview.waiting') : t(`overview.${state}`)}</span></div>
    <Button size="sm" variant="ghost" aria-expanded={!collapsed} onClick={toggle}>{t(collapsed ? 'overview.expandTurn' : 'overview.collapseTurn')}</Button>
    {turn.ending?.error && <p className={css.errorText}><OverviewSearchText text={turn.ending.error} query={query} /></p>}
    {turn.items.some(hasIssue) && <p className={css.issue}>{t('overview.failedCalls')}</p>}
    {turn.ending && turn.ending.state !== 'done' && <p className={css.issue}>{t('overview.unfinished')}</p>}
    {!collapsed && noTools && <div className={css.chatOnly}><IconInfoOutlineRegular /><div><p>{t('overview.noTools')}</p><span>{t('overview.noToolsNote')}</span></div></div>}
    <ol className={css.steps} hidden={collapsed}>{groups.map(group => group.length > 1
      ? <ReadGroup key={group[0].id} items={group} turn={turn} inspect={inspect} t={t} matches={matches} query={query} />
      : <Activity key={group[0].id} item={group[0]} turn={turn} running={running}
        waitingCallId={waitingCallId} inspect={inspect} t={t} matches={matches} query={query} />)}</ol>
  </article>
}

/**
 * Render loaded process groups without requesting models or performing tool operations.
 * @param props - Target facts, live interaction state, and existing read/navigation actions.
 * @returns Chronological process overview with visible failures and unknown outcomes.
 */
export function TrajectoryOverview({
  turns, outline, loadThrough, running, waiting, waitingCallId, loading, loadingOlder, hasMore, loadOlder, inspect, t,
}: OverviewProps) {
  const [query, setQuery] = useState('')
  const [index] = useState(() => new TrajectorySearchIndex())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [activeTurn, setActiveTurn] = useState<number | null>(null)
  const [busyTurn, setBusyTurn] = useState<number | null>(null)
  const [landing, setLanding] = useState<{ turn: number | null; serial: number } | null>(null)
  const [loadingPage, setLoadingPage] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const requestId = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)
  const turnList = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [awayFromLatest, setAwayFromLatest] = useState(false)
  useEffect(() => () => { requestId.current++ }, [])
  const rail = useMemo(() => overviewNavigation(turns, outline), [turns, outline])
  const matches = useMemo(() => { index.updateOverview(turns); return index.search(query) }, [index, turns, query])
  const filtered = useMemo(() => {
    if (matches === null) return turns
    const itemMatches = (item: OverviewItem): boolean => matches.has(item.id) || item.children?.some(itemMatches) === true
    return turns.filter(turn => matches.has(turn.key) || turn.items.some(itemMatches))
  }, [matches, turns])
  const virtualized = filtered.length > VIRTUAL_TURN_THRESHOLD
  const getScrollElement = useCallback(() => scroller.current, [])
  const getItemKey = useCallback((index: number) => filtered[index]?.key ?? index, [filtered])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: filtered.length,
    getScrollElement,
    getItemKey,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    initialRect: { width: 0, height: 600 },
    overscan: 4,
    anchorTo: 'end',
    followOnAppend: 'auto',
    scrollEndThreshold: 24,
    scrollPaddingStart: 12,
    scrollMargin,
    scrollToFn: (offset, options, instance) => {
      if (instance.scrollElement !== null) instance.scrollElement.scrollTop = offset + (options.adjustments ?? 0)
    },
  })
  const virtualItems = virtualizer.getVirtualItems()
  // The virtual list starts below variable-height history and interaction notices.
  useLayoutEffect(() => {
    const port = scroller.current
    const list = turnList.current
    if (port === null || list === null) return
    const margin = list.getBoundingClientRect().top - port.getBoundingClientRect().top + port.scrollTop
    setScrollMargin(current => current === margin ? current : margin)
  }, [hasMore, waiting, query, loadFailed, virtualizer.scrollRect?.width])
  const allCollapsed = filtered.length > 0 && filtered.every(turn => (matches === null ? collapsed : searchCollapsed).has(turn.key))
  const toggle = (key: string) =>{  (matches === null ? setCollapsed : setSearchCollapsed)((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }) }
  const navigate = async (turn: number) => {
    const item = rail.find(item => item.turn === turn)
    if (item === undefined) return
    const serial = ++requestId.current
    setQuery(''); setLoadFailed(false); setBusyTurn(turn)
    try {
      if (!item.loaded && loadThrough) await loadThrough(item.seq)
      if (requestId.current !== serial) return
      setCollapsed((current) => { const next = new Set(current); next.delete(`turn:${turn}`); return next })
      setActiveTurn(turn); setLanding({ turn, serial })
    } catch (error) {
      if (requestId.current === serial) { setLoadFailed(true); console.error('trajectory turn navigation failed', error) }
    } finally { if (requestId.current === serial) setBusyTurn(null) }
  }
  useLayoutEffect(() => {
    const port = scroller.current
    if (port === null || port.clientHeight === 0 || filtered.length === 0) return
    if (landing !== null) {
      const index = landing.turn === null ? filtered.length - 1 : filtered.findIndex(turn => turn.turn === landing.turn)
      if (index < 0) return
      virtualizer.scrollToIndex(index, { align: landing.turn === null ? 'end' : 'start' })
      initialized.current = true
      setLanding(null)
    } else if (!initialized.current) {
      virtualizer.scrollToEnd()
      initialized.current = true
    }
  }, [landing, filtered, scrollMargin, virtualizer, virtualizer.scrollRect?.height])
  const load = async () => {
    if (loadingPage || loadingOlder) return
    setLoadFailed(false)
    setLoadingPage(true)
    try { await loadOlder() }
    catch (error) { setLoadFailed(true); console.error('trajectory overview history load failed', error) }
    finally { setLoadingPage(false) }
  }
  const latest = () => {
    const serial = ++requestId.current
    setBusyTurn(null)
    setLanding({ turn: null, serial })
  }
  const interruptNavigation = () => {
    requestId.current++
    setBusyTurn(null)
    setLanding(null)
  }
  const changeQuery = (value: string) => {
    interruptNavigation()
    setActiveTurn(null)
    setQuery(value)
    setSearchCollapsed(new Set())
  }
  const toggleAll = () => {
    const update = matches === null ? setCollapsed : setSearchCollapsed
    update((current) => {
      const next = new Set(current)
      for (const turn of filtered) {
        if (allCollapsed) next.delete(turn.key)
        else next.add(turn.key)
      }
      return next
    })
  }
  return <div className={css.overviewShell}>
    <div className={css.overviewToolbar} role="toolbar" aria-label={t('overview.toolbar')}>
      <Button size="sm" variant="ghost" aria-pressed={allCollapsed} onClick={toggleAll}>
        {t(allCollapsed ? 'overview.expandVisible' : 'overview.collapseVisible')}
      </Button>
      <TrajectorySearchField query={query} onChange={changeQuery} t={t} />
      {query !== '' && <Button size="sm" variant="ghost" onClick={() => { changeQuery('') }}>{t('overview.clearSearch')}</Button>}
      {awayFromLatest && <Button size="sm" variant="ghost" onClick={latest}>{t('overview.latest')}</Button>}
    </div>
    <div className={css.overviewViewport}>
      <div ref={scroller} className={css.overview} role="region" aria-label={t('overview.overview')} onWheel={interruptNavigation} onTouchStart={interruptNavigation} onKeyDown={(event) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interruptNavigation() }} onScroll={() => {
        const port = scroller.current
        if (port === null) return
        const top = port.getBoundingClientRect().top
        const first = [...port.querySelectorAll<HTMLElement>('[data-overview-turn]')].find(element => element.getBoundingClientRect().bottom > top + 12)
        const atEnd = port.scrollHeight - port.clientHeight - port.scrollTop <= 24
        setAwayFromLatest(!atEnd)
        const current = atEnd ? filtered.at(-1)?.turn : first?.dataset.overviewTurn
        setActiveTurn(current === undefined ? null : Number(current))
      }}>
        <div className={css.content}>
          {waiting && <div className={css.waiting} role="status"><StatusIcon state="waiting" /><div><p>{t(waiting === 'approval' ? 'overview.approval' : 'overview.waiting')}</p><span>{t('overview.respond')}</span></div></div>}
          {matches !== null && <p className={css.searchScope} role="status">{t(hasMore ? 'overview.searchLoaded' : 'overview.searchAll')} · {t('overview.matches', { count: filtered.length })}</p>}
          {hasMore && <div className={css.history}><p>{t('overview.history')}</p><Button size="sm" variant="outline" aria-label={t('overview.older')} disabled={loadingPage || loadingOlder} onClick={() => { void load() }}>{loadingPage || loadingOlder ? <IconLoadingOutlineRegular className={css.spinning} /> : t('overview.older')}</Button></div>}
          {loadFailed && <p className={css.errorText} role="alert">{t('overview.loadFailed')}</p>}
          {loading && turns.length === 0 ? <div className={css.empty} role="status" aria-label={t('overview.running')}><IconLoadingOutlineRegular className={css.spinning} /></div> : filtered.length === 0 ? <p className={css.empty}>{t(matches === null ? 'overview.empty' : 'overview.noMatches')}</p> : null}
          <div ref={turnList} className={css.turnList} style={virtualized ? { height: virtualizer.getTotalSize() } : undefined}>
            {(virtualized ? virtualItems : filtered.map((turn, index) => ({ key: turn.key, index, start: 0 }))).map((row) => {
              const turn = filtered[row.index]
              if (turn === undefined) return null
              return <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} className={css.turnRow}
                style={virtualized ? { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start - scrollMargin}px)` } : undefined}>
                <Turn turn={turn} running={running && turn === turns.at(-1)} waiting={turn === turns.at(-1) ? waiting : undefined}
                  waitingCallId={turn === turns.at(-1) ? waitingCallId : undefined} inspect={inspect} t={t} hasMore={hasMore}
                  collapsed={(matches === null ? collapsed : searchCollapsed).has(turn.key)} toggle={() => { toggle(turn.key) }}
                  matches={matches} query={query} />
              </div>
            })}
          </div>
          {turns.length > 0 && <div className={css.footer}><IconInfoOutlineRegular />{t('overview.recorded')}</div>}
        </div>
      </div>
      <TurnNavigator compact items={rail} activeTurn={activeTurn ?? filtered.at(-1)?.turn ?? null} busyTurn={busyTurn} onNavigate={(turn) => { void navigate(turn) }} labels={{ label: t('overview.index'), jump: (turn, loaded) => t(loaded ? 'overview.jump' : 'overview.jumpLoad', { turn }), turn: turn => t('overview.request', { turn }) }} />
    </div>
  </div>
}
