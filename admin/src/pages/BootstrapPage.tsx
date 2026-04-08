import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuthSession } from '../providers/AuthSessionProvider'

const fieldClass = [
  'w-full rounded-2xl border border-[color:var(--line)]',
  'bg-white/80 px-4 py-3 text-sm text-[color:var(--ink)]',
  'outline-none transition focus:border-[color:var(--accent)]',
  'focus:ring-2 focus:ring-[color:var(--accent-soft)]',
].join(' ')

const primaryButtonClass = [
  'rounded-2xl bg-[color:var(--accent)] px-5 py-3 text-sm',
  'font-medium text-white transition hover:opacity-90',
  'disabled:cursor-not-allowed disabled:opacity-60',
].join(' ')

const errorBoxClass = [
  'rounded-2xl border border-[color:var(--danger)]/30',
  'bg-[color:var(--danger)]/8 px-4 py-3 text-sm',
  'text-[color:var(--danger)]',
].join(' ')

export const BootstrapPage = () => {
  const navigate = useNavigate()
  const { bootstrap, bootstrapState, sessionState } = useAuthSession()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [bootstrapToken, setBootstrapToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (sessionState === 'authenticated') {
      void navigate('/channels', { replace: true })
    }
  }, [navigate, sessionState])

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
          <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--muted)]">
            First-time setup
          </p>
          <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight md:text-5xl">
            Create the owner account for this Nessie workspace.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[color:var(--muted)] md:text-base">
            This screen appears only when the backend has no users yet. The token from the
            bootstrap URL unlocks the one-time owner setup flow.
          </p>

          <div className="mt-8 grid gap-4 rounded-[1.5rem] border border-[color:var(--line)] bg-white/60 p-5">
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">
                Bootstrap URL
              </div>
              <div className="mt-1 break-all font-mono text-sm">
                {bootstrapState?.bootstrapUrl ?? '/admin/bootstrap?token=...'}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">
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
                className={fieldClass}
                onChange={(event) => setDisplayName(event.target.value)}
                required
                value={displayName}
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span>Password</span>
              <input
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
