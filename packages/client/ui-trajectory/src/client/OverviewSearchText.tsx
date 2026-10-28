/** Literal search-term highlighting for recorded overview text. */
import { trajectorySearchTerms } from './trajectory-search-index.ts'
import type { OverviewItem } from './overview-model.ts'
import css from './overview.module.css'

/**
 * Highlight literal query terms without changing recorded text.
 * @param props - Original text and the overview's current query.
 * @returns Original text with matching ranges marked.
 */
export function OverviewSearchText({ text, query }: { text: string; query: string }) {
  const terms = trajectorySearchTerms(query)
  if (terms.length === 0) return text
  const expression = terms.sort((left, right) => right.length - left.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const matches = [...text.matchAll(new RegExp(expression, 'giu'))]
  let end = 0
  return <>{matches.map((match) => {
    const start = match.index
    const prefix = text.slice(end, start)
    end = start + match[0].length
    return <span key={start}>{prefix}<mark className={css.searchMark}>{match[0]}</mark></span>
  })}{text.slice(end)}</>
}

/**
 * Identify query terms that only the recorded tool arguments explain.
 * @param item - A tool record already matched by the shared search index.
 * @param query - Current literal, space-separated query.
 * @returns Whether an argument-only term needs a visible explanation.
 */
export function hasParameterOnlyMatch(item: OverviewItem, query: string): boolean {
  const visible = [item.object ?? '', item.text, item.toolName ?? '', item.callId ?? ''].join('\n').toLocaleLowerCase()
  const input = (item.inputText ?? '').toLocaleLowerCase()
  return trajectorySearchTerms(query).some(term => !visible.includes(term) && input.includes(term))
}
