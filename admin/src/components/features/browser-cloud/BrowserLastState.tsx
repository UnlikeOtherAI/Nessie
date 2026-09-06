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
  /** The browser is coming back: the column should open it for the person. */
  onResumed: () => void
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
 * The window when there is no picture: a drawn browser rather than an empty
 * box, so the frame is always there to tap. It says what it stands for — the
 * tab's address, or that the browser has never opened a page — instead of
 * pretending to be a screenshot.
 */
const PlaceholderWindow = ({ caption }: { caption: string }) => (
  <div
    aria-hidden="true"
    className="flex aspect-[16/10] w-full flex-col bg-[color:var(--bg2)]"
  >
    <div className="flex items-center gap-1.5 border-b border-[color:var(--sep)] px-3 py-2">
      <span className="h-2 w-2 rounded-full bg-[color:var(--tx3)] opacity-40" />
      <span className="h-2 w-2 rounded-full bg-[color:var(--tx3)] opacity-40" />
      <span className="h-2 w-2 rounded-full bg-[color:var(--tx3)] opacity-40" />
      <span className="ml-2 h-4 flex-1 rounded-sm bg-[color:var(--overlay-weak)]" />
    </div>
    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[color:var(--tx3)]">
      {caption}
    </div>
  </div>
)

/**
 * The browser column's idle face: the last state, not an apology.
 *
 * A persistent Browser button is pressed far more often than the agent is
 * browsing. What answers that press is the window itself — the tabs the
 * browser was left with, what each was showing, and when — and the window is
 * the control: tapping it brings the same browser back on the same sign-ins at
 * the same addresses and hands the person the keyboard. A browser that has
 * never opened a page still gets a window, drawn, so there is always
 * something to tap. The tab strip is the design system's `TabBar`, the same
 * control the live viewer uses for the live tabs, so the two faces read as one.
 */
export const BrowserLastState = ({ agent, onResumed, threadId }: BrowserLastStateProps) => {
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

  const canResume = threadId !== null && !resume.isPending
  const start = () => {
    if (!canResume) return
    resume.mutate(undefined, { onSuccess: onResumed })
  }
  const resumeError =
    resume.error instanceof Error ? resume.error.message : resume.error ? 'Could not resume.' : null
  const caption = selected
    ? hostOf(selected.url)
    : tabs.isLoading
      ? 'Loading…'
      : 'No page yet — tap to open the browser'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 px-4 py-2">
        <span className="truncate text-sm font-medium text-[color:var(--tx)]">{agent.name}</span>
        <Pill size="sm" tone="muted">
          {rows.length > 0 ? 'Last state' : 'Idle'}
        </Pill>
        <button
          className="admin-button admin-button-primary admin-button-compact ml-auto"
          disabled={!canResume}
          onClick={start}
          type="button"
        >
          {resume.isPending ? 'Opening…' : 'Open browser'}
        </button>
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

      {resumeError ? <FormError className="mx-3 mb-2">{resumeError}</FormError> : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <button
          aria-label={
            selected
              ? `Open the browser on ${selected.title || hostOf(selected.url)}`
              : 'Open the browser'
          }
          className="group mx-3 mb-3 block w-[calc(100%-1.5rem)] overflow-hidden border border-[color:var(--sep)] bg-[color:var(--bg2)] text-left transition-shadow hover:shadow-[0_0_0_2px_var(--accent)] disabled:opacity-60"
          disabled={!canResume}
          onClick={start}
          type="button"
        >
          {selected?.screenshotDataUrl ? (
            <img
              alt=""
              className="block aspect-[16/10] w-full object-cover object-top"
              src={selected.screenshotDataUrl}
            />
          ) : (
            <PlaceholderWindow caption={caption} />
          )}
          <span className="grid gap-0.5 border-t border-[color:var(--sep)] px-3 py-2">
            <span className="truncate text-sm font-medium text-[color:var(--tx)]">
              {selected ? selected.title || hostOf(selected.url) : `${agent.name}’s browser`}
            </span>
            {selected ? (
              <span className="truncate text-xs text-[color:var(--tx3)]" title={selected.url}>
                {selected.url}
              </span>
            ) : null}
            <span className="text-xs text-[color:var(--tx3)]">
              {selected?.capturedAt
                ? `Seen ${formatWhen(selected.capturedAt)} · tap to open here and take the keyboard`
                : 'Tap to open here and take the keyboard'}
            </span>
          </span>
        </button>

        {agent.systemManaged ? null : (
          <div className="px-3 pb-3">
            <AgentBrowserPanel agent={agent} heading={false} />
          </div>
        )}
      </div>
    </div>
  )
}
