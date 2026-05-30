import type { McpCatalogEntryRecord } from '../../../facades/mcp-catalog/hooks'

/**
 * Detail + action panel for a selected catalog entry. Pure presentational: the
 * page owns mutations and passes typed callbacks. Which actions render depends
 * on the viewer's relationship to the entry:
 * - `isMine` — the viewer authored it (private self-serve actions);
 * - `isOwner` — the viewer is a superuser (review-queue decisions).
 */

type CatalogDetailPanelProps = {
  entry: McpCatalogEntryRecord
  isOwner: boolean
  isMine: boolean
  busy: boolean
  onPublish: () => void
  onDeprecate: () => void
  onSubmit: () => void
  onApprove: () => void
  onReject: () => void
  onInstall: () => void
  onDelete: () => void
}

const ghostButton = [
  'admin-button rounded-md border border-[color:var(--sep)]',
  'px-3 py-1 text-xs text-[color:var(--tx2)] hover:bg-white/5',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

const primaryButton = [
  'admin-button admin-button-primary rounded-md px-3 py-1 text-xs font-semibold',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

const dangerButton = [
  'admin-button rounded-md border border-rose-400/40',
  'px-3 py-1 text-xs text-rose-200 hover:bg-rose-500/10',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

export const CatalogDetailPanel = ({
  entry,
  isOwner,
  isMine,
  busy,
  onPublish,
  onDeprecate,
  onSubmit,
  onApprove,
  onReject,
  onInstall,
  onDelete,
}: CatalogDetailPanelProps) => {
  const canManage = isMine || isOwner
  const isPrivateDraft = entry.visibility === 'private' && entry.status === 'draft'
  const canSubmit = canManage && (entry.status === 'draft' || entry.status === 'rejected')
  const inReview = entry.status === 'pending_approval'

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className="text-sm text-white">{entry.description || entry.name}</div>
        <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
          <dt className="text-[color:var(--tx3)]">Name</dt>
          <dd className="text-white">{entry.name}</dd>
          <dt className="text-[color:var(--tx3)]">Vendor</dt>
          <dd className="text-white">{entry.vendor ?? '—'}</dd>
          <dt className="text-[color:var(--tx3)]">Protocol</dt>
          <dd className="text-white">{entry.protocol}</dd>
          <dt className="text-[color:var(--tx3)]">Auth</dt>
          <dd className="text-white">{entry.authMethod}</dd>
          <dt className="text-[color:var(--tx3)]">Visibility</dt>
          <dd className="text-white">{entry.visibility}</dd>
          <dt className="text-[color:var(--tx3)]">Status</dt>
          <dd className="text-white">{entry.status}</dd>
        </dl>

        {entry.status === 'rejected' && entry.rejectionReason ? (
          <div
            className="mt-3 rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
            role="alert"
          >
            <span className="font-semibold">Rejected:</span> {entry.rejectionReason}
          </div>
        ) : null}

        {inReview ? (
          <div className="mt-3 rounded-md border border-[color:var(--sep)] bg-white/5 px-3 py-2 text-xs text-[color:var(--tx2)]">
            {isOwner
              ? 'Awaiting your review. Approve to publish it to the public store, or reject with a reason.'
              : 'Submitted to the public store. Awaiting a superuser review.'}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {entry.status === 'published' ? (
            <button
              className={primaryButton}
              data-testid="catalog-install"
              disabled={busy}
              onClick={onInstall}
              type="button"
            >
              Install
            </button>
          ) : null}

          {isPrivateDraft ? (
            <button
              className={ghostButton}
              data-testid="catalog-publish"
              disabled={busy}
              onClick={onPublish}
              type="button"
            >
              Publish (private)
            </button>
          ) : null}

          {canSubmit ? (
            <button
              className={ghostButton}
              data-testid="catalog-submit"
              disabled={busy}
              onClick={onSubmit}
              type="button"
            >
              Submit to public store
            </button>
          ) : null}

          {isOwner && inReview ? (
            <>
              <button
                className={primaryButton}
                data-testid="catalog-approve"
                disabled={busy}
                onClick={onApprove}
                type="button"
              >
                Approve
              </button>
              <button
                className={dangerButton}
                data-testid="catalog-reject"
                disabled={busy}
                onClick={onReject}
                type="button"
              >
                Reject
              </button>
            </>
          ) : null}

          {canManage && entry.status === 'published' ? (
            <button
              className={ghostButton}
              disabled={busy}
              onClick={onDeprecate}
              type="button"
            >
              Deprecate
            </button>
          ) : null}

          {canManage ? (
            <button
              className={dangerButton}
              data-testid="catalog-delete"
              disabled={busy}
              onClick={onDelete}
              type="button"
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
