import { faClockRotateLeft, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Notice } from '../../../primitives/Notice'

/**
 * “Saved a version before <action> — Restore”.
 *
 * Every automatic pre-destructive snapshot shows this, and the Restore in it
 * goes straight to the version the snapshot took — not to the history list. It
 * exists because this feature has **no approval gate**: an agent that deletes a
 * hundred rows does it immediately, and the honest way to make that safe is to
 * put the undo in the reader's eyeline at the moment it happens, rather than
 * asking them to go and look for it afterwards.
 *
 * Transient by design: it is dismissible, and the same version stays reachable
 * from History forever (there is no retention policy).
 */

export type SpreadsheetVersionSavedNotice = {
  /** What was about to happen, in the pane's own words: `delete 120 rows`. */
  action: string
  /** Who did it, when it was not the viewer. */
  actorName?: string
  versionId: string
  versionNumber: number
}

type Props = {
  notice: SpreadsheetVersionSavedNotice
  onDismiss: () => void
  onRestore: (versionId: string) => void
  pending?: boolean
}

export const SpreadsheetVersionSavedNoticeBar = ({
  notice,
  onDismiss,
  onRestore,
  pending = false,
}: Props) => (
  <Notice
    className="mx-3 mt-2 flex items-center gap-3"
    data-testid="spreadsheet-version-saved-notice"
    role="status"
    size="sm"
    tone="info"
  >
    <FontAwesomeIcon icon={faClockRotateLeft} />
    <span className="min-w-0 flex-1">
      Saved a version before {notice.action}
      {notice.actorName ? ` (${notice.actorName})` : ''} — v{notice.versionNumber}.
    </span>
    <button
      className="admin-button admin-button-secondary admin-button-compact"
      data-testid="spreadsheet-notice-restore"
      disabled={pending}
      onClick={() => onRestore(notice.versionId)}
      type="button"
    >
      Restore
    </button>
    <button
      aria-label="Dismiss"
      className="text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
      onClick={onDismiss}
      type="button"
    >
      <FontAwesomeIcon icon={faXmark} />
    </button>
  </Notice>
)
