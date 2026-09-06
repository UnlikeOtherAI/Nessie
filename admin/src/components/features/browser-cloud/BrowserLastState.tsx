import { useEffect, useState } from 'react'

import type { AgentRecord } from '../../../lib/api-client'
import { useAgentBrowserTabs, useResumeAgentBrowser } from '../../../facades/browser-cloud/hooks'
import { Pill } from '../../primitives/Pill'
import { TabBar } from '../../primitives/TabBar'
import { FormError } from '../../shared/FormActions'
import { AgentBrowserPanel } from './AgentBrowserPanel'

type BrowserLastStateProps = {
  agent: AgentRecord
  threadId: string | null
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const formatWhen = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  })

/**
 * The browser column's idle face: the last state, not an apology.
 *
 * A persistent Browser button is pressed far more often than the agent is
 * browsing. What answers that press is what the browser was left on — its
 * tabs, the page each was showing, and when — with the one action that
 * changes it: Resume, which brings the same browser back on the same
 * sign-ins at the same addresses. The tab strip is the design system's
 * `TabBar`, the same control the live viewer uses for the live tabs, so the
 * two faces of the column read as one.
 */
export const BrowserLastState = ({ agent, threadId }: BrowserLastStateProps) => {
  const tabs = useAgentBrowserTabs(threadId, agent.id)
  const resume = useResumeAgentBrowser(threadId, agent.id)
  const rows = tabs.data?.tabs ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Follow the first tab until the reader picks one, and never point at a tab
  // that a fresh capture has since removed.
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])

  const resumeError =
    resume.error instanceof Error ? resume.error.message : resume.error ? 'Could not resume.' : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 px-4 py-2">
        <span className="truncate text-sm font-medium text-[color:var(--tx)]">{agent.name}</span>
        <Pill size="sm" tone="muted">
          {rows.length > 0 ? 'Last state' : 'Idle'}
        </Pill>
        {threadId && (rows.length > 0 || tabs.data?.hasBrowser) ? (
          <button
            className="admin-button admin-button-primary admin-button-compact ml-auto"
            disabled={resume.isPending}
            onClick={() => resume.mutate()}
            type="button"
          >
            {resume.isPending ? 'Resuming…' : 'Resume'}
          </button>
        ) : null}
      </div>

      {rows.length > 1 ? (
        <div className="flex-shrink-0 px-3 pb-2">
          <TabBar
            ariaLabel="Last open tabs"
            items={rows.map((row) => ({
              label: row.title || hostOf(row.url) || 'Tab',
              title: row.url,
              value: row.id,
            }))}
            onChange={setSelectedId}
            size="sm"
            value={selected?.id ?? ''}
          />
        </div>
      ) : null}

      {resumeError ? (
        <FormError className="mx-3 mb-2">{resumeError}</FormError>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selected ? (
          <figure className="mx-3 mb-3 overflow-hidden border border-[color:var(--sep)] bg-[color:var(--bg2)]">
            {selected.screenshotDataUrl ? (
              <img
                alt={`${selected.title || hostOf(selected.url)} — the page as the browser last saw it`}
                className="block w-full"
                src={selected.screenshotDataUrl}
              />
            ) : (
              <div className="flex h-40 items-center justify-center px-4 text-center text-sm text-[color:var(--tx3)]">
                No picture of this tab was kept.
              </div>
            )}
            <figcaption className="grid gap-0.5 border-t border-[color:var(--sep)] px-3 py-2">
              <span className="truncate text-sm font-medium text-[color:var(--tx)]">
                {selected.title || hostOf(selected.url)}
              </span>
              <span className="truncate text-xs text-[color:var(--tx3)]" title={selected.url}>
                {selected.url}
              </span>
              {selected.capturedAt ? (
                <span className="text-xs text-[color:var(--tx3)]">
                  Seen {formatWhen(selected.capturedAt)}
                </span>
              ) : null}
            </figcaption>
          </figure>
        ) : tabs.isLoading ? (
          <p className="px-4 py-3 text-sm text-[color:var(--tx2)]">Loading…</p>
        ) : (
          <p className="px-4 py-3 text-sm text-[color:var(--tx2)]">
            {agent.name} has not opened a browser in this conversation yet. Its tabs will
            appear here the moment it does.
          </p>
        )}

        {agent.systemManaged ? null : (
          <div className="px-3 pb-3">
            <AgentBrowserPanel agent={agent} heading={false} />
          </div>
        )}
      </div>
    </div>
  )
}
