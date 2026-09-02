import { Dialog } from '../../shared/Dialog'

type LeaveMode = 'close' | 'navigate'

type DocumentStreamLeaveConfirmProps = {
  /** Cancel the exit: stay where you are, dialog still open. */
  onCancel: () => void
  /** Take the exit and let the agent keep writing. */
  onProceed: () => void
  /** Cancel the run: nothing is saved. */
  onStop: () => void
  mode: LeaveMode
  stopPending?: boolean
  title: string | null
}

/**
 * The choices are worded around what actually happens, which is the point:
 * hiding the popup or leaving the page does **not** stop the run — the document
 * keeps being written server-side and comes back on the chip. Only Stop
 * cancels, and cancelling saves nothing (§4.7). Offering "leave" and "discard"
 * as if they were the same thing would make one of the two a lie.
 *
 * Renders on `<Dialog blocking>` rather than `ConfirmDialog`: this is the
 * sanctioned nesting (docs/navigation/overview.md §7) — a confirm over the already-open
 * document popup — but its three actions (Cancel / Stop and discard / the
 * mode's own "keep writing" verb) don't fit `ConfirmDialog`'s two-button
 * cancel/confirm shape.
 */
const COPY: Record<
  LeaveMode,
  { body: string; cancel: string; heading: string; proceed: string }
> = {
  close: {
    body: 'Hiding it keeps the agent writing — it comes back on the chip below the conversation. Stopping cancels the run, and nothing is saved.',
    cancel: 'Cancel',
    heading: 'This document is still being written',
    proceed: 'Keep writing',
  },
  navigate: {
    body: 'Leaving keeps the agent writing — the document still saves to the knowledge base. Stopping cancels the run, and nothing is saved.',
    cancel: 'Stay here',
    heading: 'A document is still being written',
    proceed: 'Leave — it keeps writing',
  },
}

export const DocumentStreamLeaveConfirm = ({
  mode,
  onCancel,
  onProceed,
  onStop,
  stopPending = false,
  title,
}: DocumentStreamLeaveConfirmProps) => {
  const copy = COPY[mode]

  return (
    <Dialog blocking description={title ?? undefined} onClose={onCancel} open title={copy.heading}>
      <p className="text-sm text-[color:var(--tx3)]">{copy.body}</p>

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        <button
          className="admin-button admin-button-secondary admin-button-compact"
          data-testid="document-stream-leave-cancel"
          onClick={onCancel}
          type="button"
        >
          {copy.cancel}
        </button>
        <button
          className="admin-button admin-button-danger admin-button-compact"
          data-testid="document-stream-leave-stop"
          disabled={stopPending}
          onClick={onStop}
          type="button"
        >
          Stop and discard
        </button>
        <button
          className="admin-button admin-button-primary admin-button-compact"
          data-testid="document-stream-leave-proceed"
          onClick={onProceed}
          type="button"
        >
          {copy.proceed}
        </button>
      </div>
    </Dialog>
  )
}
