import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'

export const SESSION_LOADING_ESCAPE_MS = 10_000

type SessionLoadingGateProps = {
  timeoutMs?: number
}

/**
 * Authentication is fail-closed: an unresolved restore is never evidence of a
 * signed-in session. Browser history restoration can leave WebKit/Chromium
 * holding an aborted request forever, so give the person a deterministic way
 * back to the login surface instead of an unbounded workspace spinner.
 */
export const SessionLoadingGate = ({
  timeoutMs = SESSION_LOADING_ESCAPE_MS,
}: SessionLoadingGateProps) => {
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setTimedOut(true), timeoutMs)
    return () => window.clearTimeout(timer)
  }, [timeoutMs])

  if (timedOut) return <Navigate to="/login" replace />

  return (
    <main
      className={[
        'flex min-h-screen items-center justify-center bg-[color:var(--main)]',
        'px-6 py-10 text-[color:var(--tx)]',
      ].join(' ')}
    >
      <div aria-live="polite" className="admin-card w-full max-w-xl p-8">
        Loading workspace...
      </div>
    </main>
  )
}
