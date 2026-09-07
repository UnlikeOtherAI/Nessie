import { useState } from 'react'

import type { AgentRecord } from '../../../lib/api-client'
import { useAgentBrowser, useResetAgentBrowser } from '../../../facades/browser-cloud/hooks'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { FormError } from '../../shared/FormActions'
import { PrivateAgentHomeLink } from '../agents/PrivateAgentHomeLink'
import { ChromeCookieImportDialog } from './ChromeCookieImportDialog'

type AgentBrowserPanelProps = {
  agent: AgentRecord
  /**
   * Off inside the browser column, whose own bar already says "Browser":
   * the agent's configuration page needs the heading to separate this card
   * from its neighbours, and a column of one card does not.
   */
  heading?: boolean
  threadId?: string | null
}

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * What this agent's browser is signed in to, and the way to undo it.
 *
 * A durable team browser that predates private jars may contain an unproven
 * personal sign-in. It is reset-only; neither the service nor the signer is
 * exposed again.
 */
export const AgentBrowserPanel = ({ agent, heading = true, threadId = null }: AgentBrowserPanelProps) => {
  const browser = useAgentBrowser(agent.id)
  const reset = useResetAgentBrowser(agent.id)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)

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
        <div className="mt-3 grid gap-2 text-sm text-[color:var(--tx2)]">
          <p>
            This agent has no browser yet. One is created the first time it — or you —
            opens it, and it keeps its sign-ins between runs.
          </p>
          {agent.visibility === 'private' && agent.browserEnabled === true && !threadId ? (
            <span className="flex flex-wrap items-center gap-1">
              <PrivateAgentHomeLink agent={agent} className="text-sm text-[color:var(--lnk)] hover:underline" />
              <span>to import selected Chrome sign-ins.</span>
            </span>
          ) : null}
        </div>
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

          {row.loginStatus === 'legacy_team_human' ? (
            <div className="grid gap-2 border border-[color:var(--danger)] bg-[color:var(--danger-soft)] p-3">
              <p className="text-sm font-medium text-[color:var(--tx)]">
                This shared browser is private until it is reset.
              </p>
              <p className="text-sm text-[color:var(--tx2)]">
                It may contain a person’s sign-in from before private browser homes were enforced.
                Its pages cannot be opened or viewed. Reset it, then use a private agent or
                Personal Assistant browser for sign-ins.
              </p>
            </div>
          ) : row.logins.length === 0 ? (
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
            </div>
          )}

          <div className="border-t border-[color:var(--sep)] pt-3">
            {agent.visibility === 'private' && agent.browserEnabled === true && threadId ? (
              <button
                className="admin-button admin-button-secondary admin-button-compact mr-2"
                disabled={row.inUse}
                onClick={() => setImportOpen(true)}
                type="button"
              >
                Import selected Chrome sign-ins
              </button>
            ) : null}
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
      {threadId ? (
        <ChromeCookieImportDialog
          agent={agent}
          onClose={() => setImportOpen(false)}
          open={importOpen}
          threadId={threadId}
        />
      ) : null}
    </section>
  )
}
