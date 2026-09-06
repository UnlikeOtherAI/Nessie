/**
 * `aria-current="page"` for a sidebar-shaped row that carries the `active`
 * class — shared so every row (rail item, channel, DM, project, space, and the
 * feature trees that render their own sidebar shape) marks the current page the
 * same way instead of each file inventing its own.
 * `undefined`, not `"false"`, so the attribute is absent rather than present
 * with a false value on every unselected row.
 */
export const sidebarAriaCurrent = (active: boolean): 'page' | undefined =>
  active ? 'page' : undefined;
