import { parseRgb } from './webview-inject'

/**
 * The admin animates focus mode's palette rather than snapping to it: a 300ms
 * `ease` transition on the colour tokens (`admin/src/styles.css`, the
 * transition block on the palette owners, with `--easing-standard: ease`).
 *
 * The native chrome draws the header and tab bar the page no longer draws, so
 * it has to run the same curve over the same duration -- otherwise it lands on
 * the new colour while the page is still on its way there.
 */
export const FOCUS_CHROME_DURATION_MS = 300

const clampProgress = (progress: number): number =>
  Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 1

// CSS `ease` is cubic-bezier(0.25, 0.1, 0.25, 1). Solve x(t) = progress by
// Newton-Raphson, then read y(t); bisection covers the flat spots where the
// derivative is too small to step on.
const cubicBezier = (x1: number, y1: number, x2: number, y2: number) => {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx

  return (x: number): number => {
    let t = x
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x
      if (Math.abs(error) < 1e-6) return sampleY(t)
      const slope = slopeX(t)
      if (Math.abs(slope) < 1e-6) break
      t -= error / slope
    }
    let low = 0
    let high = 1
    t = x
    for (let i = 0; i < 24; i += 1) {
      const error = sampleX(t) - x
      if (Math.abs(error) < 1e-6) break
      if (error > 0) high = t
      else low = t
      t = (low + high) / 2
    }
    return sampleY(t)
  }
}

const ease = cubicBezier(0.25, 0.1, 0.25, 1)

export const easeStandard = (progress: number): number => {
  const p = clampProgress(progress)
  // The curve's own endpoints are exact; short-circuiting keeps the start and
  // end frames byte-identical to the palette they came from.
  return p === 0 || p === 1 ? p : ease(p)
}

const channel = (from: number, to: number, progress: number): number =>
  Math.round(from + (to - from) * progress)

/**
 * Interpolate one colour towards another. An unparseable colour has no
 * midpoint to travel through, so it switches at the end of the transition
 * rather than being dropped.
 */
export const mixColor = (from: string, to: string, progress: number): string => {
  const p = clampProgress(progress)
  if (p === 0) return from
  if (p === 1) return to
  const a = parseRgb(from)
  const b = parseRgb(to)
  if (!a || !b) return p >= 1 ? to : from
  const red = channel(a[0], b[0], p)
  const green = channel(a[1], b[1], p)
  const blue = channel(a[2], b[2], p)
  const alpha = a[3] + (b[3] - a[3]) * p
  return alpha >= 1
    ? `rgb(${red}, ${green}, ${blue})`
    : `rgba(${red}, ${green}, ${blue}, ${Math.round(alpha * 1000) / 1000})`
}
