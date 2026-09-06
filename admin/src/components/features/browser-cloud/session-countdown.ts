/**
 * How long a resumed browser has left, and whether to say so.
 *
 * A cloud browser bills for as long as it is up, so an idle one closes itself.
 * Closing it without warning would take a half-finished sign-in away from
 * somebody who had simply stopped to read a code off their phone — and warning
 * from the moment the panel opens would be noise, since most of the window is
 * ordinary working time. So the last minute is the warning, and the press that
 * answers it is the only thing that extends the window.
 *
 * Derived from the server's own `expiresAt` on every tick rather than from a
 * timer started at mount: a reload restarts a local timer, and it would go on
 * counting down against a session the reaper had already taken.
 */

/** How much of the idle window is spent warning. */
export const BROWSER_COUNTDOWN_MS = 60_000

export type BrowserCountdown = {
  /** Whole seconds left, floored at zero, for the label. */
  secondsLeft: number
  /** Whether the panel should be asking to be kept alive. */
  warning: boolean
  /** Whether the window has closed; the reaper's release follows it. */
  expired: boolean
}

export const browserCountdown = (
  expiresAt: string | null | undefined,
  now: number,
): BrowserCountdown | null => {
  if (!expiresAt) return null
  const end = Date.parse(expiresAt)
  if (Number.isNaN(end)) return null
  const remaining = end - now
  return {
    expired: remaining <= 0,
    secondsLeft: Math.max(0, Math.ceil(remaining / 1000)),
    warning: remaining <= BROWSER_COUNTDOWN_MS,
  }
}

/** `0:07`, `1:00` — a clock, because that is what a countdown reads as. */
export const formatCountdown = (secondsLeft: number): string => {
  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
