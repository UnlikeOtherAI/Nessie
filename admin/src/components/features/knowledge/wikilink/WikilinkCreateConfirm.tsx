import { useRef } from 'react'
import { usePopoverPlacement } from '../../../../lib/popover-placement-hook'

const POPOVER_WIDTH = 260

// Confirm popover shown when clicking an unresolved wikilink in the read-only
// reader. Confirming opens the existing create-page flow (current space,
// title prefilled) — it never rewrites the document; the server resolves the
// link once a page with a matching title exists. Placement is D11's shared
// helper: the panel clamps against the reader's clipping box (not the window,
// read once) and follows the anchor when the shell reflows.
export const WikilinkCreateConfirm = ({
  at,
  onCancel,
  onConfirm,
  title,
}: {
  at: { top: number; left: number }
  onCancel: () => void
  onConfirm: () => void
  title: string
}) => {
  const panelRef = useRef<HTMLDivElement>(null)
  const placed = usePopoverPlacement({
    // `at` is the clicked link's centre-bottom in window coordinates.
    anchor: {
      kind: 'rect',
      rect: { bottom: at.top, left: at.left, right: at.left, top: at.top },
    },
    open: true,
    panelRef,
    placement: 'bottom-start',
  })

  return (
    <>
      <button
        aria-label="Dismiss"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onCancel}
        type="button"
      />
      <div
        className="fixed z-50 flex flex-col gap-2 rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3 text-sm shadow-[0_16px_40px_var(--scrim-strong)]"
        ref={panelRef}
        style={{
          width: `${POPOVER_WIDTH}px`,
          transform: 'translateX(-50%)',
          ...(placed
            ? { top: `${placed.top}px`, left: `${placed.left + POPOVER_WIDTH / 2}px` }
            : { top: 0, left: 0, visibility: 'hidden' as const }),
        }}
      >
        <p className="text-[color:var(--tx)]">Create page “{title}” in this space?</p>
        <div className="flex justify-end gap-2">
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary admin-button-compact"
            onClick={onConfirm}
            type="button"
          >
            Create
          </button>
        </div>
      </div>
    </>
  )
}
