/** Shared search input for both trajectory representations. */
import { IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TrajectoryTranslate } from './locales.ts'
import css from './TrajectoryToolbar.module.css'

/**
 * Render the trajectory's localized search field.
 * @param props - Current query, user edit callback, and locale.
 * @returns Search input without owning history or query state.
 */
export function TrajectorySearchField({ query, onChange, t }: {
  query: string
  onChange: (query: string) => void
  t: TrajectoryTranslate
}) {
  return <div className={css.search}>
    <IconSearchOutlineRegular size={11} className={css.searchIcon} />
    <input type="search" className={css.searchInput} aria-label={t('toolbar.search')}
      placeholder={t('toolbar.searchPlaceholder')} value={query}
      onChange={(event) => { onChange(event.currentTarget.value) }} />
  </div>
}
