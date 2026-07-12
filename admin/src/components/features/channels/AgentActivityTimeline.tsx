import { useState } from 'react'
import type { IntegrationUiCard, IntegrationUiCardStatus } from '@nessie/schemas'

// The trust-building "what it did" view for an external-agent assistant turn.
// Activities (narrated reasoning steps) arrive as `role: 'activity'` UI cards on
// the message; this renders them as a compact, collapsed-by-default summary line
// that expands to a vertical plan/timeline of steps. Presentational only — the
// data is already mapped by the worker (packages/mcp-manage external-chat).

type StepStatus = IntegrationUiCardStatus

const isDoneStatus = (status: StepStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'warning'

// A count-based, plain-language roll-up: "3 steps · 1 running". Kept generic so
// it reads sensibly for any external agent, not just DeepSignal.
const summarize = (activities: IntegrationUiCard[]): string => {
  const total = activities.length
  const running = activities.filter(
    (activity) => activity.status === 'running' || activity.status === 'queued',
  ).length
  const failed = activities.filter((activity) => activity.status === 'failed').length
  const stepLabel = `${total} step${total === 1 ? '' : 's'}`
  const parts: string[] = [stepLabel]
  if (running > 0) parts.push(`${running} running`)
  if (failed > 0) parts.push(`${failed} failed`)
  return parts.join(' · ')
}

const StepIcon = ({ status }: { status: StepStatus }) => {
  if (status === 'failed') {
    return (
      <svg className="h-3.5 w-3.5 text-[var(--danger-text)]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
        <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'completed') {
    return (
      <svg className="h-3.5 w-3.5 text-[var(--success-text)]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
        <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'needs_setup' || status === 'warning') {
    return (
      <svg className="h-3.5 w-3.5 text-[var(--warning-text)]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
        <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'running' || status === 'queued') {
    return <span className="streaming-dot" />
  }
  return <span className="h-2 w-2 rounded-full bg-[var(--tx3)]" />
}

const stepStatusLabel = (status: StepStatus): string =>
  status.replace(/_/g, ' ')

const ActivityStep = ({ activity }: { activity: IntegrationUiCard }) => {
  const links = (activity.actions ?? []).filter((action) => Boolean(action.href))
  return (
    <li className="relative pl-6">
      <span className="absolute left-0 top-1 flex h-4 w-4 items-center justify-center">
        <StepIcon status={activity.status} />
      </span>
      <div className="text-xs font-semibold text-[var(--tx)]">{activity.title}</div>
      {activity.summary ? (
        <p className="mt-0.5 text-xs leading-5 text-[var(--tx2)]">{activity.summary}</p>
      ) : null}
      {links.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-2">
          {links.map((link) => (
            <a
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--accent)] hover:underline"
              href={link.href}
              key={`${link.label}:${link.href}`}
              rel="noreferrer"
              target={link.href?.startsWith('http') ? '_blank' : undefined}
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : (
        <span className="sr-only">{stepStatusLabel(activity.status)}</span>
      )}
    </li>
  )
}

export const AgentActivityTimeline = ({
  activities,
}: {
  activities: IntegrationUiCard[]
}) => {
  const [expanded, setExpanded] = useState(false)
  if (activities.length === 0) {
    return null
  }
  const allDone = activities.every((activity) => isDoneStatus(activity.status))

  return (
    <div className="mt-2 max-w-2xl overflow-hidden rounded-lg border border-[var(--sep)] bg-[var(--panel)]">
      <button
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          {allDone ? (
            <svg className="h-3.5 w-3.5 text-[var(--tx3)]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <span className="streaming-dot" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--tx3)]">
          {summarize(activities)}
        </span>
        <svg
          className={['h-3.5 w-3.5 flex-shrink-0 text-[var(--tx3)] transition-transform', expanded ? '' : '-rotate-90'].join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          viewBox="0 0 24 24"
        >
          <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {expanded ? (
        <ol className="flex flex-col gap-3 border-t border-[var(--sep)] px-3 py-3">
          {activities.map((activity, index) => (
            <ActivityStep activity={activity} key={`${activity.title}:${index}`} />
          ))}
        </ol>
      ) : null}
    </div>
  )
}
