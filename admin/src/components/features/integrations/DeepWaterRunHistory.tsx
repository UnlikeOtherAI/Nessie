import { Link } from 'react-router-dom'
import type {
  DeepWaterResearchRunRecord,
  ProductIntegrationRunStatus,
} from '../../../lib/api-client'
import { Pill, type PillTone } from '../../primitives/Pill'
import { EmptyState } from '../../shared/EmptyState'

const statusLabels: Record<ProductIntegrationRunStatus, string> = {
  completed: 'Completed',
  failed: 'Failed',
  needs_setup: 'Needs setup',
  queued: 'Queued',
  running: 'Running',
  warning: 'Warning',
}

const statusTone: Record<ProductIntegrationRunStatus, PillTone> = {
  completed: 'success',
  failed: 'danger',
  needs_setup: 'warning',
  queued: 'accent',
  running: 'accent',
  warning: 'warning',
}

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

/**
 * The run list only — loading and error belong to the caller's `QueryState`,
 * which owns the query this list is built from.
 */
export const DeepWaterRunHistory = ({
  runs,
}: {
  runs: DeepWaterResearchRunRecord[]
}) => (
  <section className="mt-4 border-t border-[color:var(--sep)] pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-[color:var(--tx)]">Recent research runs</h3>
        <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
          Durable Deep Water launches for the active team.
        </p>
      </div>
      <Pill radius="chip" size="sm" tone="outline" uppercase={false}>
        {runs.length} shown
      </Pill>
    </div>

    {runs.length === 0 ? (
      <EmptyState className="mt-3">No Deep Water runs yet.</EmptyState>
    ) : (
      <div className="mt-3 divide-y divide-[color:var(--sep)] overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--sep)]">
        {runs.map((run) => {
          const nativeDocument = hasNativeDocument(run)
          return (
            <div className="p-3" key={run.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill
                      height="control"
                      radius="chip"
                      size="sm"
                      tone={statusTone[run.status]}
                      uppercase={false}
                    >
                      {statusLabels[run.status]}
                    </Pill>
                    <span className="text-xs text-[color:var(--tx3)]">
                      {formatRunDate(run.requestedAt)}
                    </span>
                  </div>
                  {nativeDocument && run.knowledgePageId ? (
                    <Link
                      className="mt-2 block truncate text-sm font-semibold text-[color:var(--tx)] hover:underline"
                      to={knowledgeHref(run.knowledgePageId)}
                    >
                      {runTitle(run)}
                    </Link>
                  ) : (
                    <div className="mt-2 truncate text-sm font-semibold text-[color:var(--tx)]">
                      {runTitle(run)}
                    </div>
                  )}
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-[color:var(--tx2)]">
                    {run.queryPreview}
                  </div>
                </div>
                {nativeDocument && run.knowledgePageId ? (
                  <Link
                    className="admin-button admin-button-primary admin-button-compact h-8"
                    to={knowledgeHref(run.knowledgePageId)}
                  >
                    Open document
                  </Link>
                ) : null}
                {run.channelId ? (
                  <Link
                    className="admin-button admin-button-secondary admin-button-compact h-8"
                    to={`/channels/${run.channelId}`}
                  >
                    Open chat
                  </Link>
                ) : null}
                {run.reportUrl ? (
                  <a
                    className="admin-button admin-button-secondary admin-button-compact h-8"
                    href={run.reportUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open original report
                  </a>
                ) : null}
              </div>
              {run.statusDetail ? (
                <div className="mt-2 text-xs leading-5 text-[color:var(--tx2)]">
                  {run.statusDetail}
                </div>
              ) : null}
              <div className="mt-3 grid gap-2 text-xs text-[color:var(--tx2)] sm:grid-cols-3">
                <div className="rounded bg-[color:var(--overlay)] px-2 py-1 capitalize">
                  {modeLabel(run)}
                </div>
                <div className="rounded bg-[color:var(--overlay)] px-2 py-1">
                  {destinationLabel(run)}
                </div>
                <div className="rounded bg-[color:var(--overlay)] px-2 py-1">
                  {sourceLabel(run.sourceCount)}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    )}
  </section>
)
