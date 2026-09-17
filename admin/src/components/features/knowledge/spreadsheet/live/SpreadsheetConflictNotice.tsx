import { faRotate, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Notice } from '../../../../primitives/Notice'

/**
 * The one line a structural rebase is allowed to say, and only when something
 * was actually lost.
 *
 * A structural conflict is the normal cost of two people editing one grid, and
 * the client repairs it without asking: it undoes, applies what it missed,
 * re-issues its own edits at their moved indexes and sends again. Announcing
 * *that* would train people to ignore the line. What has to be said is the
 * case where the repair could not carry something over — the row a person was
 * typing into no longer exists, or the batch was a paste, whose content the
 * contract does not record.
 *
 * Dismissible, and replaced rather than stacked: the newest failure is the one
 * a person can still act on.
 */
export const SpreadsheetConflictNotice = ({
  message,
  onDismiss,
  testId = 'spreadsheet-conflict-notice',
  tone = 'warning',
}: {
  message: string
  onDismiss: () => void
  testId?: string
  /** `danger` is the refusal case: the batch is gone and the page reloaded. */
  tone?: 'danger' | 'warning'
}) => (
  <Notice
    className="mx-3 mt-2 flex items-center gap-3"
    data-testid={testId}
    role="status"
    size="sm"
    tone={tone}
  >
    <FontAwesomeIcon icon={faRotate} />
    <span className="min-w-0 flex-1">{message}</span>
    <button
      aria-label="Dismiss"
      className="text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
      data-testid="spreadsheet-conflict-dismiss"
      onClick={onDismiss}
      type="button"
    >
      <FontAwesomeIcon icon={faXmark} />
    </button>
  </Notice>
)
