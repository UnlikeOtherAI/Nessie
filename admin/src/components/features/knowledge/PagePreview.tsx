import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { KnowledgePane } from './KnowledgePane'
import { pageStatusTone } from './page-status'
import { RichTextContent } from './RichTextContent'

type PagePreviewProps = {
  onBack: () => void
  onCreateChild: () => void
  onDrill: (childPageId: string) => void
  onEdit: () => void
  onOpenHistory: () => void
  onPublish: () => void
  page: KnowledgePageRecord
  publishPending?: boolean
  subPages: KnowledgePageRecord[]
}

export const PagePreview = ({
  onBack,
  onCreateChild,
  onDrill,
  onEdit,
  onOpenHistory,
  onPublish,
  page,
  publishPending,
  subPages,
}: PagePreviewProps) => (
  <KnowledgePane
    actions={
      <>
        <button
          className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
          onClick={onOpenHistory}
          type="button"
        >
          History
        </button>
        <button
          className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
          onClick={onEdit}
          type="button"
        >
          Edit
        </button>
        <button
          className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs"
          disabled={publishPending}
          onClick={onPublish}
          type="button"
        >
          Publish
        </button>
      </>
    }
    onBack={onBack}
    title={page.title}
  >
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="text-xs uppercase tracking-[0.16em]">
        <span className={pageStatusTone[page.status]}>{page.status}</span>
      </div>
      <h1 className="mt-3 text-3xl font-semibold text-[var(--tx)]">{page.title}</h1>
      {page.summary ? <p className="mt-2 text-[color:var(--tx2)]">{page.summary}</p> : null}
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

      <div className="mt-6">
        {page.latestVersion?.body ? (
          <RichTextContent html={page.latestVersion.body} />
        ) : (
          <p className="text-sm text-[color:var(--tx3)]">No content yet. Press Edit to start writing.</p>
        )}
      </div>

      <div className="mt-10 border-t border-[color:var(--sep)] pt-6">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
            Sub-pages
          </span>
          <button
            className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
            onClick={onCreateChild}
            type="button"
          >
            New sub-page
          </button>
        </div>
        <div className="mt-3 grid gap-1">
          {subPages.length === 0 ? (
            <div className="py-4 text-sm text-[color:var(--tx3)]">No sub-pages yet.</div>
          ) : (
            subPages.map((child) => (
              <button
                className={[
                  'flex items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm',
                  'text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[var(--tx)]',
                ].join(' ')}
                key={child.id}
                onClick={() => onDrill(child.id)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
                <span className={`text-[10px] uppercase tracking-[0.14em] ${pageStatusTone[child.status]}`}>
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
    </div>
  </KnowledgePane>
)
