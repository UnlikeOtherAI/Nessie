const POPOVER_WIDTH = 260

// Confirm popover shown when clicking an unresolved wikilink in the read-only
// reader. Confirming opens the existing create-page flow (current space,
// title prefilled) — it never rewrites the document; the server resolves the
// link once a page with a matching title exists.
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
  const left = Math.min(Math.max(at.left, POPOVER_WIDTH / 2 + 8), window.innerWidth - POPOVER_WIDTH / 2 - 8)

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
        style={{
          top: `${at.top + 8}px`,
          left: `${left}px`,
          width: `${POPOVER_WIDTH}px`,
          transform: 'translateX(-50%)',
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
