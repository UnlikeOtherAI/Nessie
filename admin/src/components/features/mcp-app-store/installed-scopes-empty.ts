import type { McpCatalogStatus } from '@nessie/schemas'

/**
 * What the "Installed scopes" column says when nothing is installed yet.
 *
 * It used to say «Pick a catalog entry and click "Install"» in every state, but
 * the Install button only renders for a published, non-managed entry
 * (`CatalogDetailPanel`). Someone who has just created a connector is looking at
 * a draft, so the copy pointed at a button that is not on the screen — the next
 * step is "Publish (private)", which the message never mentioned. The message
 * now names the step that actually unblocks the person, so the conditions here
 * mirror that button exactly.
 */

export type InstalledScopesEmptyState = {
  status: McpCatalogStatus
  managedByIntegration: boolean
  locked: boolean
  /** Owners/admins may install a locked entry; members may not. */
  isElevated: boolean
}

export const installedScopesEmptyMessage = ({
  status,
  managedByIntegration,
  locked,
  isElevated,
}: InstalledScopesEmptyState): string => {
  if (managedByIntegration) {
    return 'Not installed here. This connector is managed by its integration — turn it on from Integrations and it installs itself.'
  }
  switch (status) {
    case 'draft':
      return 'Nothing installed yet. This connector is still a draft — click "Publish (private)" first, and an Install button appears.'
    case 'pending_approval':
      return 'Nothing installed yet. This connector is awaiting review for the public store — Install unlocks once a superuser approves it.'
    case 'rejected':
      return 'Nothing installed yet. This connector was rejected for the public store — address the reason above, then submit it again.'
    case 'deprecated':
      return 'Nothing installed. This connector is deprecated and takes no new installs.'
    case 'published':
      return locked && !isElevated
        ? 'Nothing installed yet. Your organisation’s admins locked this connector — ask an admin to install it for you.'
        : 'Nothing installed yet. Click "Install" on the connector to add it at a scope.'
  }
}
