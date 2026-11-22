import clsx from 'clsx'
import css from './AevoraStatusMark.module.css'

/** Visual states supported by the Aevora process marker. */
export type AevoraStatusMarkKind = 'thinking' | 'running' | 'tool' | 'search' | 'waiting' | 'success' | 'error' | 'stopped' | 'unknown'

/**
 * Render the product-owned status mark used by live process and Tool rows.
 * @param props.kind - semantic state shown by the mark.
 * @param props.size - outer mark size in pixels.
 * @param props.className - optional layout class.
 * @returns an aria-hidden visual marker.
 */
export function AevoraStatusMark({ kind, size = 14, className }: {
  kind: AevoraStatusMarkKind
  size?: number
  className?: string
}) {
  return (
    <span
      className={clsx(css.mark, className)}
      data-kind={kind}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className={css.orbit} />
      <span className={css.core} />
      <span className={css.spark} />
    </span>
  )
}
