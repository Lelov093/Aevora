/** Append-only spoken prose over the existing GFM grammar and incremental block parser. */
import { IncrementalMarkdownParser } from './incremental.ts'
import { parseGfm } from './parse.ts'
import { extractMarkdownPlainText } from './plain-text.ts'

/** Newly committed speech plus whether an already observed source was rewritten. */
export interface SpeechTextUpdate { readonly parts: readonly string[]; readonly rewritten: boolean }

/** Keeps ambiguous Markdown at the frontier; ordinary prose advances by complete sentences. */
export class StreamingSpeechText {
  private previous = ''
  private committed = 0
  private parser = new IncrementalMarkdownParser(parseGfm)
  private readonly sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' })

  /**
   * Admit only fresh text from this attempt. Rewrites invalidate speech rather than replaying a prefix.
   * @param source - current native text-block content.
   * @param final - whether this text block can no longer receive content.
   * @returns new plain-text pieces and source invalidation.
   */
  update(source: string, final = false): SpeechTextUpdate {
    if (!source.startsWith(this.previous)) return { parts: [], rewritten: true }
    this.previous = source
    const pending = source.slice(this.committed)
    if (!pending) return { parts: [], rewritten: false }
    let cut = 0
    if (final) cut = pending.length
    else {
      const parsed = this.parser.update(pending)
      const last = parsed.frozen.at(-1)
      if (last?.node.position?.end.offset !== undefined) cut = last.node.position.end.offset
      if (cut === 0) {
        const first = parsed.tail[0]?.node
        // Plain prose has no open formatting that a later chunk can reinterpret.
        if (first?.type === 'paragraph' && first.children.every(node => node.type === 'text')
          && !/[`\[\]<>*_~|\\]/.test(pending)) {
          const segments = [...this.sentences.segment(pending)]
          const boundary = segments.at(-1)?.index
          if (segments.length > 1 && boundary !== undefined) cut = boundary
        }
      }
    }
    if (cut === 0) return { parts: [], rewritten: false }
    const raw = pending.slice(0, cut)
    const text = extractMarkdownPlainText(raw)
    const whitespace = /\s+$/.exec(raw)?.[0] ?? ''
    const leading = /^\s+/.exec(raw)?.[0] ?? ''
    this.committed += cut
    this.parser = new IncrementalMarkdownParser(parseGfm)
    return { parts: text ? [leading + text + whitespace] : [], rewritten: false }
  }
}
