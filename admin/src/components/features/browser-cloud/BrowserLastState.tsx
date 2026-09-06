import { useState } from 'react'

import type { AgentRecord } from '../../../lib/api-client'
import { ApiClientError } from '@nessie/client-core'
import { useAgentBrowserTabs, useResumeAgentBrowser } from '../../../facades/browser-cloud/hooks'
import { Pill } from '../../primitives/Pill'
import { TabBar } from '../../primitives/TabBar'
import { FormError } from '../../shared/FormActions'
import { AgentBrowserPanel } from './AgentBrowserPanel'

type BrowserLastStateProps = {
  agent: AgentRecord
  threadId: string | null
  /**
   * A resumed session is on its way: the resume answered, and the panel is
   * waiting for the session to show up in the thread's list. The face stays
   * in its opening state until then — the window is not pressable twice.
   */
  opening: boolean
  /** The browser is coming back under this session; open it for the person. */
  onResumed: (sessionId: string) => void
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
 * The 409 and the 403 are the two ordinary refusals, and the server's own
 * sentences for the rest are written for whoever asked — a person here.
 */
const describeResumeError = (error: unknown): string | null => {
  if (!error) return null
  if (error instanceof ApiClientError) {
    if (error.code === 'CLOUD_BROWSER_SESSION_ALREADY_OPEN') {
      return 'This agent is using its browser right now. Wait for it to finish, then try again.'
    }
    if (error.code === 'CLOUD_BROWSER_CAPACITY') {
      return 'All of this team’s browsers are in use. Close one and try again.'
    }
    if (error.code === 'AGENT_BROWSER_SIGNED_IN_BY_OTHERS') {
      return 'This browser is signed in by someone else, so only they can open it.'
    }
    if (error.message) return error.message
  }
  return 'Couldn’t open the browser.'
}

/**
 * The window when there is no picture: a drawn browser with the address in
 * its bar, so it is unmistakably a browser and says honestly what it knows —
 * where the page was, not what it looked like.
 */
const PlaceholderWindow = ({ address, caption }: { address: string | null; caption: string }) => (
  <div aria-hidden="true" className="flex aspect-[16/10] w-full flex-col bg-[color:var(--bg2)]">
    <div className="flex items-center gap-1.5 border-b border-[color:var(--sep)] px-3 py-2">
      <span className="h-2 w-2 rounded-full bg-[color:var(--tx3)] opacity-40" />
      <span className="h-2 w-2 rounded-full bg-[color:var(--tx3)] opacity-40" />
      <span className="h-2 w-2 rounded-full bg-[color:var(--tx3)] opacity-40" />
      <span className="ml-2 flex h-5 flex-1 items-center truncate rounded-sm bg-[color:var(--overlay-weak)] px-2 text-[11px] text-[color:var(--tx3)]">
        {address ?? ''}
      </span>
    </div>
    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[color:var(--tx3)]">
      {caption}
    </div>
  </div>
)

/**
 * The browser panel's idle face: where the browser left off, not an apology.
 *
 * A persistent Browser button is pressed far more often than the agent is
 * browsing. What answers that press is the window itself — the tabs the
 * browser was left with, what each was showing, and when — and the window is
 * the control: tapping it brings the same browser back on the same sign-ins
 * at the same addresses, full screen, with the controls in the person's
 * hands. A browser that has never opened a page still gets a window, drawn,
 * so there is always something to tap. The tab strip is the design system's
 * `TabBar`, the same control the live viewer uses for live tabs, so the two
 * faces read as one; the still picture with "Seen …" under it is what says
 * these are remembered.
 */
export const BrowserLastState = ({ agent, onResumed, opening, threadId }: BrowserLastStateProps) => {
  const tabs = useAgentBrowserTabs(threadId, agent.id)
  const resume = useResumeAgentBrowser(threadId, agent.id)
  const rows = tabs.data?.tabs ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Follow the first tab until the reader picks one, and never point at a tab
  // a fresh capture has since removed.
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null

  const busy = resume.isPending || opening
  const canOpen = threadId !== null && !busy
  const start = () => {
    if (!canOpen) return
    resume.mutate(undefined, { onSuccess: (result) => onResumed(result.sessionId) })
  }
  const resumeError = describeResumeError(resume.error)
  const seen = selected?.capturedAt ? `Seen ${formatWhen(selected.capturedAt)}` : null
  const instruction = busy
    ? 'Opening…'
    : 'Tap to open it full screen and take control'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 px-4 py-2">
        <span className="truncate text-sm font-medium text-[color:var(--tx)]">{agent.name}</span>
        <Pill size="sm" tone="muted">
          {tabs.data?.hasBrowser ? 'Closed' : 'Not opened yet'}
        </Pill>
        <button
          className="admin-button admin-button-primary admin-button-compact ml-auto"
          disabled={!canOpen}
          onClick={start}
          type="button"
        >
          {busy ? 'Opening…' : 'Open browser'}
        </button>
      </div>

      {rows.length > 1 ? (
        <div className="flex-shrink-0 px-3 pb-2">
          <TabBar
            ariaLabel="Remembered tabs"
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
              ? `Open the browser on ${selected.title || hostOf(selected.url)}${seen ? `, ${seen.toLowerCase()}` : ''}`
              : 'Open the browser'
          }
          className="group mx-3 mb-3 block w-[calc(100%-1.5rem)] overflow-hidden border border-[color:var(--sep)] bg-[color:var(--bg2)] text-left transition-shadow hover:shadow-[0_0_0_2px_var(--accent)] disabled:opacity-60"
          disabled={!canOpen}
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
            <PlaceholderWindow
              address={selected ? hostOf(selected.url) : null}
              caption={
                selected
                  ? 'No picture of this page'
                  : tabs.isLoading
                    ? 'Loading…'
                    : 'Nothing open yet'
              }
            />
          )}
          <span className="grid gap-0.5 border-t border-[color:var(--sep)] px-3 py-2">
            {selected ? (
              <>
                <span className="truncate text-sm font-medium text-[color:var(--tx)]">
                  {selected.title || hostOf(selected.url)}
                </span>
                <span className="truncate text-xs text-[color:var(--tx3)]" title={selected.url}>
                  {selected.url}
                </span>
              </>
            ) : null}
            <span className="text-xs text-[color:var(--tx3)]">
              {seen ? `${seen} · ${instruction.charAt(0).toLowerCase()}${instruction.slice(1)}` : instruction}
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
