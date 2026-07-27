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
  /** Owner or org admin — may lock/unlock and install despite a lock. */
  isElevated: boolean
  isMine: boolean
  managedByIntegration?: boolean
  busy: boolean
  onPublish: () => void
  onDeprecate: () => void
  onSubmit: () => void
  onApprove: () => void
  onReject: () => void
  onInstall: () => void
  onDelete: () => void
  onLockToggle: () => void
}

const ghostButton = [
  'admin-button border border-[color:var(--sep)]',
  'px-3 py-1 text-xs text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

const primaryButton = [
  'admin-button admin-button-primary admin-button-compact',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

const dangerButton = [
  'admin-button border border-[var(--danger-border)]',
  'px-3 py-1 text-xs text-[var(--danger-text)] hover:bg-[var(--danger-soft)]',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

export const CatalogDetailPanel = ({
  entry,
  isOwner,
  isElevated,
  isMine,
  managedByIntegration = false,
  busy,
  onPublish,
  onDeprecate,
  onSubmit,
  onApprove,
  onReject,
  onInstall,
  onDelete,
  onLockToggle,
}: CatalogDetailPanelProps) => {
  const canManage = isMine || isOwner
  const isPrivateDraft = entry.visibility === 'private' && entry.status === 'draft'
  const canSubmit = canManage && (entry.status === 'draft' || entry.status === 'rejected')
  const inReview = entry.status === 'pending_approval'

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
        <div className="text-sm text-[var(--tx)]">{entry.description || entry.name}</div>
        <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
          <dt className="text-[color:var(--tx3)]">Name</dt>
          <dd className="text-[var(--tx)]">{entry.name}</dd>
          <dt className="text-[color:var(--tx3)]">Vendor</dt>
          <dd className="text-[var(--tx)]">{entry.vendor ?? '—'}</dd>
          <dt className="text-[color:var(--tx3)]">Protocol</dt>
          <dd className="text-[var(--tx)]">{entry.protocol}</dd>
          <dt className="text-[color:var(--tx3)]">Auth</dt>
          <dd className="text-[var(--tx)]">{entry.authMethod}</dd>
          <dt className="text-[color:var(--tx3)]">Visibility</dt>
          <dd className="text-[var(--tx)]">{entry.visibility}</dd>
          <dt className="text-[color:var(--tx3)]">Status</dt>
          <dd className="text-[var(--tx)]">{entry.status}</dd>
        </dl>

        {entry.status === 'rejected' && entry.rejectionReason ? (
          <div
            className="mt-3 rounded-md border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger-text)]"
            role="alert"
          >
            <span className="font-semibold">Rejected:</span> {entry.rejectionReason}
          </div>
        ) : null}

        {entry.locked ? (
          <div
            className="mt-3 rounded-md border border-[color:var(--sep)] bg-[var(--overlay-weak)] px-3 py-2 text-xs text-[color:var(--tx2)]"
            data-testid="catalog-locked-note"
          >
            🔒 <span className="font-semibold">Locked by your organisation&apos;s admins.</span>{' '}
            {isElevated
              ? 'Members cannot install this connector; you can, or unlock it below.'
              : 'You cannot install this connector. Ask an admin if you need it.'}
          </div>
        ) : null}

        {inReview ? (
          <div className="mt-3 rounded-md border border-[color:var(--sep)] bg-[var(--overlay-weak)] px-3 py-2 text-xs text-[color:var(--tx2)]">
            {isOwner
              ? 'Awaiting your review. Approve to publish it to the public store, or reject with a reason.'
              : 'Submitted to the public store. Awaiting a superuser review.'}
          </div>
        ) : null}

        {managedByIntegration ? (
          <div
            className="mt-3 rounded-md border border-[color:var(--sep)] bg-[var(--overlay-weak)] px-3 py-2 text-xs text-[color:var(--tx2)]"
            data-testid="catalog-managed-note"
          >
            {entry.name === 'deep-water'
              ? 'Manage Deep Water from Integrations. Nessie supplies your SSO identity automatically; no personal Ledger credential is needed.'
              : `Manage ${entry.label} from Integrations. Nessie supplies your SSO identity and its dedicated app API key automatically; no personal connector credential is needed.`}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {entry.status === 'published' && !managedByIntegration ? (
            <button
              className={primaryButton}
              data-testid="catalog-install"
              disabled={busy || (entry.locked && !isElevated)}
              onClick={onInstall}
              type="button"
            >
              {entry.locked && !isElevated ? '🔒 Locked' : 'Install'}
            </button>
          ) : null}

          {isElevated && !managedByIntegration ? (
            <button
              className={ghostButton}
              data-testid="catalog-lock-toggle"
              disabled={busy}
              onClick={onLockToggle}
              type="button"
            >
              {entry.locked ? 'Unlock' : 'Lock for members'}
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

          {canManage && entry.status === 'published' && !managedByIntegration ? (
            <button
              className={ghostButton}
              disabled={busy}
              onClick={onDeprecate}
              type="button"
            >
              Deprecate
            </button>
          ) : null}

          {canManage && !managedByIntegration ? (
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
