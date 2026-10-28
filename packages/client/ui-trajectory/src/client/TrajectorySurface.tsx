/** Two representations of the same recorded trajectory, sharing one persisted preference. */
import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TrajectoryView, type TrajectoryViewInjected } from './TrajectoryView.tsx'
import { TrajectoryOverview } from './TrajectoryOverview.tsx'
import type { TrajectoryPresentation } from './presentation-store.ts'
import css from './overview.module.css'

/** Session-bound trajectory controls plus one plugin-owned, browser-local presentation preference. */
export interface TrajectorySurfaceInjected extends TrajectoryViewInjected {
  hooks: TrajectoryViewInjected['hooks'] & { trajectoryPresentation: SnapshotStore<TrajectoryPresentation> }
  /**
   * Persist the representation selected by the user or an explicit inspector request.
   * @param presentation - Overview or original detailed trajectory.
   */
  setTrajectoryPresentation: (presentation: TrajectoryPresentation) => void
}

/**
 * Keep the original trajectory component intact while adding its ordinary-user representation.
 * @param props - Framework-baked session hooks, locale, and read/navigation actions.
 * @returns Same trajectory entry with accessible representation tabs.
 */
export function TrajectorySurface({
  useTrajectoryPresentation, setTrajectoryPresentation, ...props
}: ComponentProps<typeof TrajectoryView> & InjectFace<TrajectorySurfaceInjected>) {
  const { useTrajectory, useSession, useSessionStatus, useProjection, sessionId, viewRequest, openView, t } = props
  const chosen = useTrajectoryPresentation(value => value)
  const requested = viewRequest?.view === 'trajectory'
  const selected = requested ? 'detail' : chosen
  const [openedDetail, setOpenedDetail] = useState(selected === 'detail')
  const overviewTab = useRef<HTMLButtonElement>(null)
  const detailTab = useRef<HTMLButtonElement>(null)
  const outline = useProjection('turnOutline')
  const turns = useTrajectory(snapshot => snapshot.overview ?? EMPTY_TURNS)
  const session = useSession(snapshot => snapshot)
  const pending = useSessionStatus(snapshot => snapshot.get(sessionId)?.pendingInteraction)
  const waitingCallId = pending !== undefined && 'callId' in pending && typeof pending.callId === 'string' ? pending.callId : undefined
  useEffect(() => {
    if (selected === 'detail') setOpenedDetail(true)
    if (requested) setTrajectoryPresentation('detail')
  }, [requested, selected, setTrajectoryPresentation])
  const choose = (next: TrajectoryPresentation) =>{  setTrajectoryPresentation(next) }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'detail' : selected === 'overview' ? 'detail' : 'overview'
    choose(next)
    ;(next === 'overview' ? overviewTab : detailTab).current?.focus()
  }
  return <div className={css.root} data-conversation-composer-overlay="">
    <div className={css.modeBar}>
      <div className={css.tabs} role="tablist" aria-label={t('overview.switch')} onKeyDown={keyDown}>
        <button ref={overviewTab} role="tab" aria-selected={selected === 'overview'} tabIndex={selected === 'overview' ? 0 : -1} onClick={() =>{  choose('overview') }}>{t('overview.overview')}</button>
        <button ref={detailTab} role="tab" aria-label={t('overview.detail')} aria-selected={selected === 'detail'} tabIndex={selected === 'detail' ? 0 : -1} onClick={() =>{  choose('detail') }}>{t('overview.detail')}<span>{t('overview.native')}</span></button>
      </div>
    </div>
    <section className={css.panel} role="tabpanel" aria-label={t('overview.overview')} hidden={selected !== 'overview'}>
      <TrajectoryOverview key={sessionId} turns={turns} outline={outline} loadThrough={props.loadThrough} running={session.running} waiting={pending === undefined ? undefined : pending.kind === 'approval' ? 'approval' : 'response'} waitingCallId={waitingCallId} loading={session.openState === 'loading'} loadingOlder={session.loadingOlder} hasMore={session.hasMore} loadOlder={props.loadOlder} inspect={(callId) => { choose('detail'); openView('trajectory', callId) }} t={t} />
    </section>
    {(openedDetail || selected === 'detail') && <section className={css.panel} role="tabpanel" aria-label={t('overview.detail')} hidden={selected !== 'detail'}><TrajectoryView key={sessionId} {...props} /></section>}
  </div>
}

const EMPTY_TURNS = Object.freeze([])
