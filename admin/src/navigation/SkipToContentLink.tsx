// docs/navigation/overview.md §12 — one skip link at the top of the shell, targeting
// the shell's own `<main>` (SHELL_MAIN_ID, given `tabIndex={-1}` so a
// non-heading element can still receive programmatic focus). Visually
// hidden until focused: Tailwind's `sr-only` clips it off-screen, and
// `focus:not-sr-only` restores it the moment keyboard focus lands, using
// theme tokens rather than a raw colour per CLAUDE.md → Theming.

export const SHELL_MAIN_ID = 'admin-shell-main'

export const SkipToContentLink = () => (
  <a
    className={[
      'sr-only focus:not-sr-only',
      'focus:fixed focus:left-2 focus:top-2 focus:z-[var(--layer-blocking)]',
      'focus:rounded-md focus:px-4 focus:py-2 focus:text-sm focus:font-medium',
      'focus:bg-[color:var(--accent)] focus:text-[color:var(--on-accent)]',
      'focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--accent)]',
    ].join(' ')}
    href={`#${SHELL_MAIN_ID}`}
  >
    Skip to content
  </a>
)
