import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Finder's name cell: `Fire_Risk_Ass…Distillery.docx`.
 *
 * A CSS `text-overflow: ellipsis` cuts the *end*, which throws away the two
 * things a filename carries — the type and whatever distinguishes it from the
 * other eleven reports in the folder. Every uploaded document in this admin is
 * titled with its filename, so an end-truncated column of documents reads
 * `Fire_Risk_Assessment_2026_…` eleven times over. The middle goes instead.
 *
 * The rule: keep the extension plus up to ten characters of the stem before
 * it, then as much of the start as fits, with one `…` (U+2026) between them.
 */

/** How many characters of the stem travel with the extension. */
const TAIL_STEM = 10

const ELLIPSIS = '…'

const splitExtension = (text: string): { stem: string; extension: string } => {
  const dot = text.lastIndexOf('.')
  // A leading dot is the whole name (`.gitignore`), not an extension, and an
  // "extension" longer than eight characters is a sentence that happens to
  // contain a full stop.
  if (dot <= 0 || dot === text.length - 1 || text.length - dot > 9) {
    return { stem: text, extension: '' }
  }
  return { stem: text.slice(0, dot), extension: text.slice(dot) }
}

/**
 * Pure so it can be tested without a browser: `measure` is whatever the caller
 * can measure text with — a canvas in the DOM, a per-character width in a test.
 *
 * Returns `text` unchanged when it fits. Never returns something wider than
 * `maxWidth` unless even a single character is too wide for the cell.
 */
export const middleTruncate = (
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
): string => {
  if (!text || maxWidth <= 0) return text
  if (measure(text) <= maxWidth) return text

  const { stem, extension } = splitExtension(text)
  let tail = stem.slice(Math.max(0, stem.length - TAIL_STEM)) + extension

  // The tail alone may already overflow a very narrow column (a long
  // extension, a 40px cell). Give the start back its turn by shortening it.
  while (tail.length > 1 && measure(ELLIPSIS + tail) > maxWidth) {
    tail = tail.slice(1)
  }

  const head = text.slice(0, Math.max(0, text.length - tail.length))
  if (!head) return ELLIPSIS + tail

  // Largest head that still fits. Binary search rather than a walk: a 200
  // character name in a resize observer would otherwise measure 200 times a
  // frame, and `measureText` is not free.
  let low = 0
  let high = head.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measure(head.slice(0, mid) + ELLIPSIS + tail) <= maxWidth) low = mid
    else high = mid - 1
  }
  return head.slice(0, low) + ELLIPSIS + tail
}

// One canvas for the whole app. A fresh one per row is a fresh GPU-backed
// surface per row, and the browser keeps them alive as long as the context is.
let sharedContext: CanvasRenderingContext2D | null | undefined

const measurer = (): CanvasRenderingContext2D | null => {
  if (sharedContext !== undefined) return sharedContext
  sharedContext = typeof document === 'undefined'
    ? null
    : document.createElement('canvas').getContext('2d')
  return sharedContext
}

// `useLayoutEffect` warns where there is no layout pass (SSR, an isolated
// render in a test); the measurement has to happen before paint in a real
// browser, so the hook is chosen rather than the effect weakened.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

type MiddleTruncateProps = {
  className?: string
  /** The full name. It is always what `title` and assistive tech get. */
  text: string
}

/**
 * Measures the cell it is in and re-measures on resize. The element always
 * carries the *whole* name on `title` and `aria-label`, so nothing a person
 * or a screen reader needs is ever only in the ellipsis.
 */
export const MiddleTruncate = ({ className, text }: MiddleTruncateProps) => {
  const ref = useRef<HTMLSpanElement>(null)
  const [display, setDisplay] = useState(text)

  useIsomorphicLayoutEffect(() => {
    const element = ref.current
    const context = measurer()
    if (!element || !context) {
      setDisplay(text)
      return undefined
    }

    const fit = () => {
      const width = element.getBoundingClientRect().width
      if (width <= 0) return
      const font = window.getComputedStyle(element).font
      if (font) context.font = font
      setDisplay(middleTruncate(text, width, (value) => context.measureText(value).width))
    }

    fit()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])

  return (
    <span
      aria-label={text}
      className={['block min-w-0 truncate', className ?? ''].filter(Boolean).join(' ')}
      data-middle-truncate
      ref={ref}
      title={text}
    >
      {display}
    </span>
  )
}
