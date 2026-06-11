import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { pageStatusTone } from './page-status'

type PageColumnProps = {
  activeChildId?: string
  onBack?: () => void
  onCreateChild: () => void
  onDrill: (childPageId: string) => void
  onEdit: () => void
  onOpenHistory: () => void
  onPublish: () => void
  page: KnowledgePageRecord
  publishPending?: boolean
  subPages: KnowledgePageRecord[]
}

export const PageColumn = ({
  activeChildId,
  onBack,
  onCreateChild,
  onDrill,
  onEdit,
  onOpenHistory,
  onPublish,
  page,
  publishPending,
  subPages,
}: PageColumnProps) => (
  <ColumnBrowserColumn
    headerAction={
      <div className="flex items-center gap-2">
        <button
          className="admin-button admin-button-secondary rounded-md px-2 py-1 text-xs"
          onClick={onOpenHistory}
          type="button"
        >
          History
        </button>
        <button
          className="admin-button admin-button-secondary rounded-md px-2 py-1 text-xs"
          onClick={onEdit}
          type="button"
        >
          Edit
        </button>
        <button
          className="admin-button admin-button-primary rounded-md px-2 py-1 text-xs"
          disabled={publishPending}
          onClick={onPublish}
          type="button"
        >
          Publish
        </button>
      </div>
    }
    onBack={onBack}
    showBack={Boolean(onBack)}
    title={page.title}
  >
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          <span>{page.status}</span>
          <span>{page.visibilityReason}</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--tx)]">{page.title}</h1>
        {page.summary ? (
          <p className="mt-2 text-sm text-[color:var(--tx2)]">{page.summary}</p>
        ) : null}
        {page.labels.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {page.labels.map((label) => (
              <span
                className="rounded bg-[var(--overlay-weak)] px-2 py-1 text-xs text-[color:var(--tx2)]"
                key={label}
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <pre className="min-h-[160px] flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-[color:var(--sep)] p-4 text-sm text-[color:var(--tx)]">
        {page.latestVersion?.body || 'No body yet.'}
      </pre>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
            Sub-pages
          </span>
          <button
            className="admin-button admin-button-secondary rounded-md px-2 py-1 text-xs"
            onClick={onCreateChild}
            type="button"
          >
            New sub-page
          </button>
        </div>
        <div className="mt-2 grid gap-1">
          {subPages.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-[color:var(--tx3)]">No sub-pages</div>
          ) : (
            subPages.map((child) => (
              <button
                className={[
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  child.id === activeChildId
                    ? 'bg-[color:var(--accent)] text-[var(--on-accent)]'
                    : 'text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[var(--tx)]',
                ].join(' ')}
                key={child.id}
                onClick={() => onDrill(child.id)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
                <span
                  className={`text-[10px] uppercase tracking-[0.14em] ${pageStatusTone[child.status]}`}
                >
                  {child.status}
                </span>
                <span aria-hidden className="opacity-60">
                  →
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="rounded-md border border-[color:var(--sep)] p-3 text-xs text-[color:var(--tx3)]">
        <div>Source: {page.sourceRef}</div>
        <div>Policy: {page.policyChainTrace.join(' / ')}</div>
      </div>
    </div>
  </ColumnBrowserColumn>
)
