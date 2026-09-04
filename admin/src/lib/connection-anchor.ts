/** A stable in-page target for either a native or a live email connection. */
export const connectionAnchorId = (id: string): string => `connection-${id}`

/** One-shot navigation instruction consumed by the owning Settings surface. */
export const connectionAnchorHash = (id: string): string =>
  `#${connectionAnchorId(encodeURIComponent(id))}`

/**
 * The two mailbox scopes have separate homes. Keep route construction beside
 * the anchor contract so a chat doorway cannot point at a Settings DOM node
 * that is not mounted on its current route.
 */
export const mailboxConnectionHome = (input: { id: string; scope: 'user' | 'team' }): string =>
  input.scope === 'team'
    ? `/settings/organization?tab=agents${connectionAnchorHash(input.id)}`
    : `/settings/connections${connectionAnchorHash(input.id)}`
