import { useRef, type ReactNode } from 'react'
import { Dialog } from './Dialog'

/**
 * Confirm-then-act, on the shared {@link Dialog} shell.
 *
 * Four destructive actions in the admin still asked for confirmation through
 * the browser's own `window.confirm` — unthemed, unfocusable, and unstyleable,
 * with an "OK" button that says nothing about what it will destroy — while two
 * other flows (`DocumentStreamLeaveConfirm`, `UoaBillingCancellationDialog`)
 * had each hand-rolled a themed one. This is the shared answer: the shell's
 * Escape, focus trap, focus restore and `role="dialog"` come for free, and the
 * confirm control carries the same `admin-button-danger` treatment those two
 * already use.
 *
 * `window.confirm` is synchronous and this is not: a call site holds the
 * pending target in state, renders the dialog from it, and performs the action
 * in `onConfirm` — never on the click that opens the dialog.
 */

type ConfirmDialogProps = {
  /**
   * The consequence sentence under the question. Optional because one of the
   * native confirms this replaced is a bare question ("Delete column "x"?")
   * and inventing a consequence for it would be new copy, not a conversion.
   */
  body?: ReactNode
  cancelLabel?: string
  /**
   * The sanctioned nesting (docs/navigation/overview.md §7): a confirm over an already
   * open modal renders in the blocking layer and outranks it for Back, rather
   * than competing with it in the plain modal layer. Off by default — every
   * call site converted so far replaces a standalone `window.confirm` with
   * nothing open beneath it.
   */
  blocking?: boolean
  confirmLabel: string
  /** Renders the confirm control as the danger action rather than the primary one. */
  destructive?: boolean
  /** Escape, the scrim and the close cross all land here, as does Cancel. */
  onCancel: () => void
  onConfirm: () => void
  open: boolean
  /**
   * Blocks a second confirm and the dismiss paths while the action runs.
   * `window.confirm` could not be double-fired because it blocked the thread;
   * this cannot rely on that, so a caller whose action is not synchronous must
   * pass its pending flag.
   */
  pending?: boolean
  title: string
}

export const ConfirmDialog = ({
  blocking = false,
  body,
  cancelLabel = 'Cancel',
  confirmLabel,
  destructive = false,
  onCancel,
  onConfirm,
  open,
  pending = false,
  title,
}: ConfirmDialogProps) => {
  // Focus opens on Cancel, not on the destructive control: a confirm reached by
  // keyboard must not be completable by pressing Enter on arrival.
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog
      blocking={blocking}
      dismissDisabled={pending}
      initialFocusRef={cancelRef}
      onClose={onCancel}
      open={open}
      title={title}
    >
      {body ? <div className="text-sm text-[color:var(--tx3)]">{body}</div> : null}

      <div className="flex justify-end gap-2 pt-5">
        <button
          ref={cancelRef}
          className="admin-button admin-button-secondary"
          data-testid="confirm-dialog-cancel"
          disabled={pending}
          onClick={onCancel}
          type="button"
        >
          {cancelLabel}
        </button>
        <button
          className={[
            'admin-button',
            destructive ? 'admin-button-danger' : 'admin-button-primary',
          ].join(' ')}
          data-testid="confirm-dialog-confirm"
          disabled={pending}
          onClick={onConfirm}
          type="button"
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
