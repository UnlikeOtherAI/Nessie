import { Link } from 'react-router-dom'

import { useMyBrowserLogins } from '../../../facades/browser-cloud/hooks'
import { SectionLabel } from '../../primitives/SectionLabel'

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Every sign-in this person performed, across agents.
 *
 * Revoking "I signed that agent into my Google" should never mean hunting
 * through agents to find which one, so the list is keyed by the act rather
 * than by the agent, and each row links to the agent that holds it.
 */
export const MyBrowserLoginsPanel = () => {
  const logins = useMyBrowserLogins()
  const rows = logins.data?.logins ?? []
  if (logins.isLoading || rows.length === 0) return null

  return (
    <section className="admin-card p-4">
      <SectionLabel>Your browser sign-ins</SectionLabel>
      <p className="mt-2 text-sm text-[color:var(--tx2)]">
        Services you have signed an agent’s browser into. Reset a browser from the agent’s
        Tools tab to clear them.
      </p>
      <ul className="mt-3 grid gap-2">
        {rows.map((login) => (
          <li
            className="flex items-baseline justify-between gap-3 border-b border-[color:var(--sep)] pb-2 last:border-0 last:pb-0"
            key={login.id}
          >
            <span className="min-w-0 text-sm text-[color:var(--tx)]">
              {login.serviceHint}
              <Link
                className="ml-2 text-[color:var(--lnk)] hover:underline"
                to={`/agents/${login.agentId}`}
              >
                {login.agentName}
              </Link>
            </span>
            <span className="text-xs text-[color:var(--tx3)]">{formatDate(login.createdAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
