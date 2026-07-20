import { Link } from 'react-router-dom'
import type {
  DeepWaterResearchRunRecord,
  ProductIntegrationRunStatus,
} from '../../../lib/api-client'

const statusLabels: Record<ProductIntegrationRunStatus, string> = {
  completed: 'Completed',
  failed: 'Failed',
  needs_setup: 'Needs setup',
  queued: 'Queued',
  running: 'Running',
  warning: 'Warning',
}

const statusClass = (status: ProductIntegrationRunStatus): string =>
  [
    'inline-flex h-6 items-center rounded px-2 text-[11px] font-semibold',
    status === 'completed'
      ? 'bg-[var(--success-soft)] text-[var(--success-text)]'
      : status === 'failed'
        ? 'bg-[var(--danger-soft)] text-[var(--danger-text)]'
        : status === 'warning' || status === 'needs_setup'
          ? 'bg-[var(--warning-soft)] text-[var(--warning-text)]'
          : 'bg-[var(--accent-soft)] text-[var(--thinking)]',
  ].join(' ')

const formatRunDate = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  }).format(new Date(value))

const sourceLabel = (value: number | null): string =>
  value === null ? 'Sources pending' : `${value} sources`

const destinationLabel = (run: DeepWaterResearchRunRecord): string =>
  run.artifactDestination === 'knowledge_draft' ? 'Knowledge draft' : 'Chat only'

const modeLabel = (run: DeepWaterResearchRunRecord): string =>
  [
    run.depth.replace(/_/g, ' '),
    run.outputTier === 'full' ? 'full report' : 'summary',
    run.searchQuality === 'premium' ? 'premium search' : 'standard search',
  ].join(' / ')

const runTitle = (run: DeepWaterResearchRunRecord): string =>
  run.title?.trim() || run.queryPreview || 'Deep Water research'

const knowledgeHref = (pageId: string): string =>
  `/knowledge-base?pageId=${encodeURIComponent(pageId)}`

// A finished run with a drafted Knowledge page should read as a native
// document, not an external list item — so its title links straight to the
// page and the "Open document" action is primary. Runs still in flight,
// failed, or predating the Knowledge draft (no knowledgePageId) degrade to
// the chat/report links only.
const hasNativeDocument = (run: DeepWaterResearchRunRecord): boolean =>
  run.status === 'completed' && Boolean(run.knowledgePageId)

export const DeepWaterRunHistory = ({
  loading,
  runs,
}: {
  loading: boolean
  runs: DeepWaterResearchRunRecord[]
}) => (
  <section className="mt-4 border-t border-[var(--sep)] pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--tx)]">Recent research runs</h3>
        <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">
          Durable Deep Water launches for the active team.
        </p>
      </div>
      <span className="rounded border border-[var(--sep)] px-2 py-1 text-xs text-[var(--tx3)]">
        {loading ? 'Loading' : `${runs.length} shown`}
      </span>
    </div>

    <div className="mt-3 overflow-hidden rounded border border-[var(--sep)]">
      {loading ? (
        <div className="px-3 py-4 text-sm text-[var(--tx3)]">Loading runs...</div>
      ) : runs.length === 0 ? (
        <div className="px-3 py-4 text-sm text-[var(--tx3)]">No Deep Water runs yet.</div>
      ) : (
        runs.map((run) => {
          const nativeDocument = hasNativeDocument(run)
          return (
            <div className="border-t border-[var(--sep)] p-3 first:border-t-0" key={run.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={statusClass(run.status)}>{statusLabels[run.status]}</span>
                    <span className="text-xs text-[var(--tx3)]">
                      {formatRunDate(run.requestedAt)}
                    </span>
                  </div>
                  {nativeDocument && run.knowledgePageId ? (
                    <Link
                      className="mt-2 block truncate text-sm font-semibold text-[var(--tx)] hover:underline"
                      to={knowledgeHref(run.knowledgePageId)}
                    >
                      {runTitle(run)}
                    </Link>
                  ) : (
                    <div className="mt-2 truncate text-sm font-semibold text-[var(--tx)]">
                      {runTitle(run)}
                    </div>
                  )}
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--tx2)]">
                    {run.queryPreview}
                  </div>
                </div>
                {nativeDocument && run.knowledgePageId ? (
                  <Link
                    className="admin-button admin-button-primary h-8 text-xs"
                    to={knowledgeHref(run.knowledgePageId)}
                  >
                    Open document
                  </Link>
                ) : null}
                {run.channelId ? (
                  <Link
                    className="admin-button admin-button-secondary h-8 text-xs"
                    to={`/channels/${run.channelId}`}
                  >
                    Open chat
                  </Link>
                ) : null}
                {run.reportUrl ? (
                  <a
                    className="admin-button admin-button-secondary h-8 text-xs"
                    href={run.reportUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open original report
                  </a>
                ) : null}
              </div>
              {run.statusDetail ? (
                <div className="mt-2 text-xs leading-5 text-[var(--tx2)]">
                  {run.statusDetail}
                </div>
              ) : null}
              <div className="mt-3 grid gap-2 text-xs text-[var(--tx2)] sm:grid-cols-3">
                <div className="rounded bg-[var(--overlay)] px-2 py-1 capitalize">
                  {modeLabel(run)}
                </div>
                <div className="rounded bg-[var(--overlay)] px-2 py-1">
                  {destinationLabel(run)}
                </div>
                <div className="rounded bg-[var(--overlay)] px-2 py-1">
                  {sourceLabel(run.sourceCount)}
                </div>
              </div>
            </div>
          )
        })
      )}
    </div>
  </section>
)
