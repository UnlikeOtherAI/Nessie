/**
 * The two settings looks that are classes rather than components.
 *
 * The section-label look as a bare class, for the elements `SectionLabel`'s
 * `as` union cannot render — a `<dt>` inside a definition list, where a `<div>`
 * would break the list semantics. Everything else uses the primitive.
 */
export const sectionTitleClass =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const hoverCardClass = [
  'admin-card p-3 text-left',
  'hover:bg-[color:var(--main-hover)]',
].join(' ')
