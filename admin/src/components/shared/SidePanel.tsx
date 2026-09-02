import type { ReactNode } from 'react'

/**
 * A panel that slides in beside the content rather than over it.
 *
 * `AddWidgetPanel` and `DashboardVersionsPanel` are the same shell written
 * twice — same width, same header row, same scroll body, same close glyph —
 * so this is that shell, once.
 *
 * It is **not** a dialog and must not become one. It does not trap focus,
 * because the content beside it stays live and usable; that is the whole
 * reason a surface reaches for a side panel instead of `Dialog`. A panel that
 * blocks the page behind it is a dialog, and `Dialog` already exists.
 */

type SidePanelProps = {
  children: ReactNode
  className?: string
  onClose: () => void
  title: string
}

export const SidePanel = ({ children, className, onClose, title }: SidePanelProps) => (
  <aside
    aria-label={title}
    className={[
      'flex w-80 shrink-0 flex-col border-l border-[color:var(--sep)] bg-[color:var(--panel)]',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')}
  >
    <div className="flex items-center justify-between gap-2 border-b border-[color:var(--sep)] px-3 py-2.5">
      <h2 className="text-sm font-semibold text-[color:var(--tx)]">{title}</h2>
      <button
        aria-label="Close"
        className={[
          'flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx3)]',
          'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
        ].join(' ')}
        onClick={onClose}
        type="button"
      >
        {/* The same 24-viewBox cross the dialog shell draws, so the two
            dismissals read as one gesture. */}
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>

    <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
  </aside>
)
