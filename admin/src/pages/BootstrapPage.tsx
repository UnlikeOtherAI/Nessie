import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useRedirect } from '../navigation/redirect'
import { useAuthSession } from '../providers/AuthSessionProvider'

const LOCAL_BOOTSTRAP_EMAIL = 'owner@example.com'
const LOCAL_BOOTSTRAP_DISPLAY_NAME = 'Owner'
const LOCAL_BOOTSTRAP_PASSWORD = 'Password123!'

const fieldClass = [
  'w-full rounded-2xl border border-[var(--line)]',
  'bg-[color:var(--surface-inverse)] px-4 py-3 text-sm text-[var(--ink)]',
  'outline-none transition focus:border-[var(--accent)]',
  'focus:ring-2 focus:ring-[var(--accent-soft)]',
].join(' ')

const primaryButtonClass = [
  'rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm',
  'font-medium text-[color:var(--on-accent)] transition hover:opacity-90',
  'disabled:cursor-not-allowed disabled:opacity-60',
].join(' ')

const errorBoxClass = [
  'rounded-2xl border border-[color:var(--danger-border)]',
  'bg-[color:var(--danger-soft)] px-4 py-3 text-sm',
  'text-[color:var(--danger-text)]',
].join(' ')

export const BootstrapPage = () => {
  const navigate = useNavigate()
  const redirect = useRedirect()
  const { bootstrap, bootstrapState, sessionState } = useAuthSession()
  const [email, setEmail] = useState(LOCAL_BOOTSTRAP_EMAIL)
  const [displayName, setDisplayName] = useState(LOCAL_BOOTSTRAP_DISPLAY_NAME)
  const [password, setPassword] = useState(LOCAL_BOOTSTRAP_PASSWORD)
  const [bootstrapToken, setBootstrapToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (sessionState === 'authenticated') {
      redirect('/channels')
    }
  }, [redirect, sessionState])

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token')
    if (token) {
      setBootstrapToken(token)
    }
  }, [])

  if (sessionState === 'authenticated') {
    return <Navigate to="/channels" replace />
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)

    try {
      await bootstrap({
        bootstrapToken,
        displayName,
        email,
        password,
      })
      void navigate('/channels', { replace: true })
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Bootstrap failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen px-6 py-10">
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="glass-panel rounded-[2rem] p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">
            First-time setup
          </p>
          <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight md:text-5xl">
            Create the owner account for this Nessie team.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--muted)] md:text-base">
            This screen appears only when the backend has no users yet. The token from the
            bootstrap URL unlocks the one-time owner setup flow.
          </p>

          <div className="mt-8 grid gap-4 rounded-[1.5rem] border border-[var(--line)] bg-[color:var(--surface-inverse)] p-5">
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-[var(--muted)]">
                Bootstrap URL
              </div>
              <div className="mt-1 break-all font-mono text-sm">
                {bootstrapState?.bootstrapUrl ?? '/bootstrap?token=...'}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-[var(--muted)]">
                Current mode
              </div>
              <div className="mt-1 text-sm">
                {bootstrapState ? 'Bootstrap enabled' : 'Waiting for backend bootstrap state'}
              </div>
            </div>
          </div>
        </section>

        <section className="glass-panel rounded-[2rem] p-8 md:p-10">
          <h2 className="text-2xl font-semibold">Owner account</h2>
          <form className="mt-6 grid gap-4" onSubmit={handleSubmit}>
            <label className="grid gap-2 text-sm">
              <span>Email</span>
              <input
                autoComplete="username"
                className={fieldClass}
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span>Display name</span>
              <input
                autoComplete="name"
                className={fieldClass}
                onChange={(event) => setDisplayName(event.target.value)}
                required
                value={displayName}
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span>Password</span>
              <input
                autoComplete="new-password"
                className={fieldClass}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span>Bootstrap token</span>
              <input
                className={fieldClass}
                onChange={(event) => setBootstrapToken(event.target.value)}
                required
                value={bootstrapToken}
              />
            </label>

            {error ? <div className={errorBoxClass}>{error}</div> : null}

            <button className={primaryButtonClass} disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Creating account...' : 'Create owner account'}
            </button>
          </form>
        </section>
      </div>
    </main>
  )
}
