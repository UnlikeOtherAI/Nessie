import { useMemo, useState } from 'react'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { computeLineDiff, htmlToLines, type DiffLineOp } from '../../../lib/line-diff'
import { AgentDraftBadge } from './AgentDraftBadge'
import { isAgentDraft } from './page-status'

type ReviewPanelProps = {
  canWrite: boolean
  onPublish: () => void
  onRequestChanges: () => void
  page: KnowledgePageRecord
  publishPending?: boolean
}

const diffLineClass: Record<DiffLineOp['type'], string> = {
  equal: 'text-[color:var(--tx2)]',
  add: 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]',
  remove: 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
}

const diffLinePrefix: Record<DiffLineOp['type'], string> = {
  equal: '  ',
  add: '+ ',
  remove: '- ',
}

// Human-facing review surface for a draft an agent authored: a "Review
// changes" toggle revealing a plain-text line diff against the published
// version (or the full draft when there is nothing published yet), plus the
// Publish / Request changes actions. Renders nothing once the page is no
// longer an unreviewed agent draft (published, archived, or human-authored).
export const ReviewPanel = ({
  canWrite,
  onPublish,
  onRequestChanges,
  page,
  publishPending,
}: ReviewPanelProps) => {
  const [showDiff, setShowDiff] = useState(false)
  const published = page.publishedVersion
  const draft = page.latestVersion

  const diff = useMemo<DiffLineOp[]>(() => {
    const draftLines = htmlToLines(draft?.body)
    if (!published) {
      return draftLines.map((text): DiffLineOp => ({ type: 'add', text }))
    }
    return computeLineDiff(htmlToLines(published.body), draftLines)
  }, [draft, published])

  if (!isAgentDraft(page)) return null

  return (
    <div className="mt-6 rounded-lg border border-[color:var(--accent)]/30 bg-[color:var(--overlay-weak)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AgentDraftBadge />
          <span className="text-sm text-[color:var(--tx2)]">
            Drafted by an agent — review before publishing.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={() => setShowDiff((value) => !value)}
            type="button"
          >
            {showDiff ? 'Hide changes' : 'Review changes'}
          </button>
          {canWrite ? (
            <>
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={onRequestChanges}
                type="button"
              >
                Request changes
              </button>
              <button
                className="admin-button admin-button-primary admin-button-compact"
                disabled={publishPending}
                onClick={onPublish}
                type="button"
              >
                Publish
              </button>
            </>
          ) : null}
        </div>
      </div>

      {showDiff ? (
        <div className="mt-4 rounded-md border border-[color:var(--sep)] bg-[color:var(--main)] p-3">
          {!published ? (
            <p className="mb-2 text-xs text-[color:var(--tx3)]">
              New page — no published version to compare.
            </p>
          ) : null}
          {diff.length === 0 ? (
            <p className="text-sm text-[color:var(--tx3)]">No content to show.</p>
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-relaxed">
              {diff.map((line, index) => (
                <div className={diffLineClass[line.type]} key={`${index}-${line.type}`}>
                  {diffLinePrefix[line.type]}
                  {line.text}
                </div>
              ))}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  )
}
