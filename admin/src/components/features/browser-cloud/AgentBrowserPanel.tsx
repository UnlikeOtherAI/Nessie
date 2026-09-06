import { useState } from 'react'

import type { AgentRecord } from '../../../lib/api-client'
import { useAgentBrowser, useResetAgentBrowser } from '../../../facades/browser-cloud/hooks'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { FormError } from '../../shared/FormActions'

type AgentBrowserPanelProps = {
  agent: AgentRecord
  /**
   * Off inside the browser column, whose own bar already says "Browser":
   * the agent's configuration page needs the heading to separate this card
   * from its neighbours, and a column of one card does not.
   */
  heading?: boolean
}

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * What this agent's browser is signed in to, and the way to undo it.
 *
 * The signer's name is shown beside each service on purpose: on a team
 * agent the logins are shared with everyone who can reach it, so "whose Google
 * is this" is the question a person actually has when they look here.
 */
export const AgentBrowserPanel = ({ agent, heading = true }: AgentBrowserPanelProps) => {
  const browser = useAgentBrowser(agent.id)
  const reset = useResetAgentBrowser(agent.id)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const row = browser.data?.browser ?? null

  const run = () => {
    setError(null)
    reset.mutate(undefined, {
      onError: (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Could not reset the browser.')
        setConfirming(false)
      },
      onSuccess: () => setConfirming(false),
    })
  }

  return (
    <section className="admin-card p-4">
      {heading ? <SectionLabel>Browser</SectionLabel> : null}
      {browser.isLoading ? (
        <p className="mt-3 text-sm text-[color:var(--tx2)]">Loading…</p>
      ) : browser.isError ? (
        // A failed read is not an empty one. Saying "no browser yet" here
        // would be a guess presented as a fact — and it is the wrong guess on
        // a system-managed agent, whose record this route refuses to hand out.
        <div className="mt-3 flex items-baseline gap-3">
          <p className="text-sm text-[color:var(--tx2)]">
            Couldn’t load this agent’s browser.
          </p>
          <button
            className="text-sm text-[color:var(--lnk)] hover:underline"
            onClick={() => void browser.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : !row ? (
        <p className="mt-3 text-sm text-[color:var(--tx2)]">
          This agent has no browser yet. One is created the first time it — or you —
          opens it, and it keeps its sign-ins between runs.
        </p>
      ) : (
        <div className="mt-3 grid gap-4">
          <div className="flex items-start justify-between gap-4">
            <p className="text-sm text-[color:var(--tx2)]">
              {row.connectionScope === 'organization'
                ? 'Runs on the company Browserbase account.'
                : 'Runs on its owner’s personal Browserbase account.'}
              {row.lastUsedAt ? ` Last used ${formatDate(row.lastUsedAt)}.` : ' Never used yet.'}
            </p>
            {row.inUse ? <Pill size="sm" tone="success">Open now</Pill> : null}
          </div>

          {row.logins.length === 0 ? (
            <p className="text-sm text-[color:var(--tx2)]">
              Not signed in to anything. When it needs a sign-in it will ask in chat, and
              you type into the browser yourself.
            </p>
          ) : (
            <div className="grid gap-2">
              <SectionLabel as="span" size="xs">Signed in to</SectionLabel>
              <ul className="grid gap-2">
                {row.logins.map((login) => (
                  <li
                    className="flex items-baseline justify-between gap-3 border-b border-[color:var(--sep)] pb-2 last:border-0 last:pb-0"
                    key={login.id}
                  >
                    <span className="text-sm text-[color:var(--tx)]">{login.serviceHint}</span>
                    <span className="text-xs text-[color:var(--tx3)]">
                      {login.signedInByName ?? 'Someone'} · {formatDate(login.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
              {agent.visibility === 'private' ? null : (
                <p className="text-xs text-[color:var(--tx3)]">
                  Anyone who can reach this agent can use these sign-ins, and anything it
                  reads through them is shared with them too.
                </p>
              )}
            </div>
          )}

          <div className="border-t border-[color:var(--sep)] pt-3">
            <button
              className="admin-button admin-button-danger admin-button-compact"
              disabled={reset.isPending || row.inUse}
              onClick={() => setConfirming(true)}
              type="button"
            >
              Sign out &amp; reset
            </button>
            <p className="mt-2 text-xs text-[color:var(--tx3)]">
              {row.inUse
                ? 'The browser is open right now. Close it first.'
                : 'Clears every sign-in at once and starts the browser over. It does not '
                  + 'sign the services themselves out: to do that fully, use each service’s '
                  + 'own security page.'}
            </p>
          </div>
        </div>
      )}

      <FormError className="mt-3">{error}</FormError>

      <ConfirmDialog
        body="Every sign-in in this browser is cleared, including ones other people added. The agent will have to be signed in again before it can reach those services."
        confirmLabel="Sign out & reset"
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={run}
        open={confirming}
        pending={reset.isPending}
        title="Reset this agent’s browser?"
      />
    </section>
  )
}
