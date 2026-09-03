import { Navigate, useLocation } from 'react-router-dom'
import {
  hasWebExternalAuthCallback,
  WEB_EXTERNAL_AUTH_LANDING_PATH,
} from '../providers/external-auth-callback'

export const ExternalAuthCompletionPage = () => {
  const location = useLocation()
  if (!hasWebExternalAuthCallback(location.search)) {
    return <Navigate replace to={WEB_EXTERNAL_AUTH_LANDING_PATH} />
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center px-6 py-12">
      <section
        aria-labelledby="external-auth-completion-title"
        className="glass-panel w-full max-w-lg rounded-[2rem] p-8 text-center md:p-10"
      >
        <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">
          Secure sign-in
        </p>
        <h1
          className="mt-4 text-3xl font-semibold tracking-tight text-[color:var(--tx)]"
          id="external-auth-completion-title"
        >
          Finishing sign-in…
        </h1>
        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
          We’re verifying your session and opening your team.
        </p>
        <p
          aria-live="polite"
          className="mt-6 rounded-2xl border border-[var(--line)] bg-[color:var(--overlay)] px-4 py-3 text-sm text-[color:var(--tx)]"
          role="status"
        >
          Connecting to Nessie…
        </p>
      </section>
    </main>
  )
}
