/** Aevora-specific controls rendered inside the existing DSH Plugins page. */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AevoraControlKey } from './locales.ts'
import type { AevoraControlInjected, AevoraFeature } from './controller.ts'
import css from './AevoraPluginsTab.module.css'

/** Props supplied by the Plugins page and the Aevora control registration. */
export type AevoraPluginsTabProps = PropsRuntime<'plugins.tab'>
  & PropsLocale<'settings.aevoraControl'>
  & InjectFace<AevoraControlInjected>

function phaseLabel(feature: AevoraFeature, t: (key: AevoraControlKey, params?: Record<string, string>) => string): string {
  if (!feature.available) return t('unavailableFeature')
  if (!feature.enabled) return t('stopped')
  if (feature.phase === 'failed') return t('failed')
  return feature.phase === 'active' ? t('running') : t('enabled')
}

function phaseState(feature: AevoraFeature): 'done' | 'idle' | 'ongoing' | 'error' {
  if (!feature.available || !feature.enabled) return 'idle'
  if (feature.phase === 'failed') return 'error'
  if (feature.phase === 'active') return 'done'
  return 'ongoing'
}

/** Render Aevora capability cards and their existing Loader switches. */
export function AevoraPluginsTab(props: AevoraPluginsTabProps): ReactNode {
  const { t } = props
  const state = props.useAevoraControl(snapshot => snapshot)
  return (
    <section className={css.page} aria-busy={state.status === 'loading'}>
      <header className={css.heading}>
        <div>
          <h2>{t('title')}</h2>
          <p>{t('description')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={props.refresh} disabled={state.status === 'loading'}>{t('refresh')}</Button>
      </header>
      {state.status === 'loading' && state.features.length === 0 ? <p className={css.notice} role="status">{t('loading')}</p> : null}
      {state.status === 'error' ? <p className={css.notice} role="alert">{t('error')}</p> : null}
      {state.status === 'ready' ? (
        <div className={css.cards}>
          {state.features.map((feature) => {
            const title = t(feature.title)
            const locked = !feature.available || feature.readOnlyReason !== undefined
            return (
              <article className={css.card} key={feature.id}>
                <div className={css.cardCopy}>
                  <div className={css.cardTitle}>
                    <StateDot state={phaseState(feature)} />
                    <h3>{title}</h3>
                  </div>
                  <p>{t(feature.description)}</p>
                  <span className={css.status}>{phaseLabel(feature, t)}</span>
                </div>
                <Switch
                  checked={feature.enabled}
                  label={t('toggle', { name: title })}
                  disabled={locked || state.busy !== undefined}
                  onChange={(enabled) => { props.toggle(feature, enabled) }}
                />
              </article>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
