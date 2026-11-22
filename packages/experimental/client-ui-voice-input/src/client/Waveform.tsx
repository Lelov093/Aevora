/** Live microphone amplitude history; animation updates SVG geometry without React state churn. */
import { useEffect, useRef } from 'react'
import type { Recording } from './audio.ts'
import css from './VoiceInput.module.css'

const BAR_COUNT = 32

/** Render recent measured microphone levels; silent audio remains a dotted baseline. */
export function Waveform({ recording, label }: { readonly recording: Recording | undefined; readonly label: string }) {
  const svg = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const bars = Array.from((svg.current as SVGSVGElement).querySelectorAll('line')).reverse()
      .map(element => ({ element, level: 0 }))
    const reducedMotion = typeof globalThis.matchMedia === 'function'
      && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame: number | undefined, previous = -Infinity
    const draw = (now: number): void => {
      if (now - previous >= 50) {
        previous = now
        let next = recording?.amplitude() ?? 0
        for (const bar of bars) {
          const previousLevel = bar.level
          bar.level = next; next = previousLevel
          const height = 1 + Math.min(1, bar.level * 5) * 17
          bar.element.setAttribute('y1', String(20 - height)); bar.element.setAttribute('y2', String(20 + height))
        }
      }
      if (!reducedMotion) frame = requestAnimationFrame(draw)
    }
    if (reducedMotion) {
      draw(0)
      return () => {}
    }
    frame = requestAnimationFrame(draw)
    return () => { if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [recording])
  return <svg ref={svg} className={css.waveform} viewBox="0 0 256 40" preserveAspectRatio="none" role="img" aria-label={label}>
    {Array.from({ length: BAR_COUNT }, (_, index) => <line key={index} x1={index * 8 + 4} x2={index * 8 + 4}
      y1="19" y2="21" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke"
      strokeLinecap="round" opacity={0.3 + 0.65 * index / (BAR_COUNT - 1)} />)}
  </svg>
}
