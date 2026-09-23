import { useEffect, useState } from 'react'
import { formatElapsed } from './research-presentation'

/**
 * How long something has been going, as `formatElapsed` words it ("12s",
 * "1:05", "1:02:03"), ticking once a second — the brief dialog's "replying"
 * clock and a running research's time so far. A display tick only: nothing is
 * fetched on it, and it stops when `since` is null.
 */
export const useElapsed = (since: string | null): string | null => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!since) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [since])
  if (!since) return null
  const started = Date.parse(since)
  return Number.isFinite(started) ? formatElapsed(now - started) : null
}
