/**
 * Paging back through a forward-only list.
 *
 * Most lists page backwards on the server, from the `prevCursor` it returns.
 * A list the server filters row by row for the viewer — the DeepWater research
 * list keeps only the research this person may see — cannot find the page
 * before a given row, so it returns no `prevCursor`. For those, the admin
 * keeps the cursors of the pages already walked through in the URL beside the
 * current one (`<prefix>trail`, one entry per page before this one, oldest
 * first; the first page has no cursor and so no entry). Previous takes the
 * last of them, and Back and a reload land on the same page because the whole
 * walk is in the address.
 *
 * Pure, so the walk is tested without a router.
 */

export type PagedListParamNames = {
  cursor: string
  direction: string
  page: string
  scope: string
  trail: string
}

export const pagedListParamNames = (prefix: string): PagedListParamNames => ({
  cursor: `${prefix}cursor`,
  direction: `${prefix}direction`,
  page: `${prefix}page`,
  scope: `${prefix}scope`,
  trail: `${prefix}trail`,
})

/** Back to the first page: no cursor, no direction, no page, no trail. */
export const firstPageParams = (current: URLSearchParams, names: PagedListParamNames): URLSearchParams => {
  const updated = new URLSearchParams(current)
  updated.delete(names.cursor)
  updated.delete(names.direction)
  updated.delete(names.page)
  updated.delete(names.trail)
  return updated
}

/**
 * Next: the current page's cursor joins the trail (the first page has none to
 * add), and the server's `nextCursor` becomes the current one.
 */
export const trailForwardParams = (
  current: URLSearchParams,
  names: PagedListParamNames,
  next: { cursor: string; page: number; scope?: string },
): URLSearchParams => {
  const updated = new URLSearchParams(current)
  const here = current.get(names.cursor)
  if (here) updated.append(names.trail, here)
  updated.set(names.cursor, next.cursor)
  updated.set(names.page, String(next.page))
  updated.delete(names.direction)
  if (next.scope) updated.set(names.scope, next.scope)
  return updated
}

/**
 * Previous: the last cursor of the trail becomes the current one. From the
 * second page, or from an address whose trail does not match its page (edited
 * by hand, or cut short), Previous lands on the first page rather than a page
 * it cannot name.
 */
export const trailBackwardParams = (
  current: URLSearchParams,
  names: PagedListParamNames,
  page: number,
): URLSearchParams => {
  const trail = current.getAll(names.trail)
  const previous = trail.at(-1)
  if (page <= 1 || trail.length !== page - 1 || !previous) return firstPageParams(current, names)
  const updated = new URLSearchParams(current)
  updated.delete(names.trail)
  for (const cursor of trail.slice(0, -1)) updated.append(names.trail, cursor)
  updated.set(names.cursor, previous)
  updated.set(names.page, String(page - 1))
  updated.delete(names.direction)
  return updated
}

/**
 * The footer's count for a forward-only list. Such a list's pages are not all
 * the same length — the server leaves out rows the viewer may not see, and
 * reads only so many per request, so a page can be short or even empty while
 * there is more — so the rows before this page cannot be counted from its
 * number, and no "26–50" range is claimed. The page position is the footer's
 * own "Page 2 of 3".
 */
export const trailPageLabel = (count: number): string =>
  count === 0 ? 'None on this page' : count === 1 ? '1 on this page' : `${count} on this page`
