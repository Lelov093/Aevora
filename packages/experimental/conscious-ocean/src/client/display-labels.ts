/** Readable object names derived from the available world and Session labels. */

import { sourceTypeLabel, type ConsciousOceanKey } from './locales.ts'

/** Display copy used for an object's name. */
export type LabelText = (key: ConsciousOceanKey) => string

/** Complete display name and the suffix kept visible when the canvas shortens the name. */
export interface DisplayName {
  id: string
  label: string
  labelQualifier?: string | undefined
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function labelKey(value: string) {
  return value.normalize('NFKC').toLowerCase()
}

/** @param value - Title carried by the read model. @param id - Object identifier. @returns A usable title when present. */
export function readableTitle(value: string | undefined, id: string): string | undefined {
  const title = value?.replace(/\s+/gu, ' ').trim()
  return title && labelKey(title) !== labelKey(id) ? title : undefined
}

function shortExcerpt(summary: string | undefined) {
  const firstLine = summary?.trim().split(/\r?\n/u, 1)[0]?.replace(/\s+/gu, ' ').trim() ?? ''
  let excerpt = ''
  let count = 0
  for (const { segment } of graphemes.segment(firstLine)) {
    if (count === 26) return `${excerpt.trimEnd()}…`
    excerpt += segment
    count++
  }
  return excerpt
}

/**
 * @param t - Localized label lookup.
 * @param kind - Provider source kind.
 * @param title - Usable provider title, when available.
 * @param summary - Source text available in the existing projection.
 * @returns A provider title, a type and excerpt, or the type alone if the source has no text.
 */
export function sourceLabel(t: LabelText, kind: string, title: string | undefined, summary: string | undefined): string {
  if (title) return title
  const type = t(sourceTypeLabel(kind))
  const excerpt = shortExcerpt(summary)
  return excerpt ? `${type} · ${excerpt}` : type
}

function appendQualifier<T extends DisplayName>(item: T, qualifier: string): T {
  const labelQualifier = item.labelQualifier ? `${item.labelQualifier} · ${qualifier}` : qualifier
  return { ...item, label: `${item.label} · ${qualifier}`, labelQualifier }
}

/**
 * @param items - Named records in the full scene.
 * @param parentName - Readable parent qualifier for a duplicate label.
 * @returns Labels qualified by their parent or a stable ordinal, in input order.
 */
export function qualifyLabels<T extends DisplayName>(items: readonly T[], parentName?: (item: T) => string | undefined): T[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = labelKey(item.label)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const groups = new Map<string, T[]>()
  const named = items.map(item => {
    const parent = counts.get(labelKey(item.label)) === 1 ? undefined : parentName?.(item)
    const qualified = parent ? appendQualifier(item, parent) : item
    const key = labelKey(qualified.label)
    const group = groups.get(key)
    if (group) group.push(qualified)
    else groups.set(key, [qualified])
    return qualified
  })
  const occupied = new Set(groups.keys())
  const numbered = new Map<string, T>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    let ordinal = 1
    for (const item of group.toSorted((left, right) => left.id.localeCompare(right.id, 'en'))) {
      let qualified = appendQualifier(item, String(ordinal++))
      while (occupied.has(labelKey(qualified.label))) qualified = appendQualifier(item, String(ordinal++))
      occupied.add(labelKey(qualified.label))
      numbered.set(item.id, qualified)
    }
  }
  return named.map(item => numbered.get(item.id) ?? item)
}
