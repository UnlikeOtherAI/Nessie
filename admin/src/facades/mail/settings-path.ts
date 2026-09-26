import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ConnectedMailSource } from '@nessie/schemas'

import { teamScopedPath } from '../../lib/admin-scope'
import { connectionAnchorId } from '../../lib/connection-anchor'
import { useApiClient } from '../../providers/ApiClientProvider'
import { mailboxConnectionKeys } from '../mailbox-connections/keys'
import { fetchMailboxConnections } from '../mailbox-connections/hooks'

export type MailSettingsTarget = {
  id: string
  scope: 'personal' | 'shared'
  source: ConnectedMailSource
}

const isSharedMailbox = (account: MailSettingsTarget): boolean =>
  account.source === 'mailbox' && account.scope === 'shared'

/**
 * Where a connected mail account is managed. A shared mailbox belongs to one
 * team and is managed on Company connections at that team's scope, so its
 * address names the team; without one it can only open the page itself.
 */
export const connectedMailSettingsPath = (
  account: MailSettingsTarget,
  sharedMailboxTeamId: string | null = null,
): string => {
  const root = !isSharedMailbox(account)
    ? '/settings/accounts'
    : sharedMailboxTeamId
      ? teamScopedPath('/admin/connections', sharedMailboxTeamId)
      : '/admin/connections'
  return `${root}#${connectionAnchorId(account.id)}`
}

/**
 * The same address, with a shared mailbox's team found when the doorway is
 * pressed. The mail surfaces carry no team for a mailbox, and reading the
 * mailbox list on every card and reader just in case somebody opens settings
 * would be a read for a click that almost never comes — so it is the cached
 * list when there is one, and one read when there is not. A read that fails
 * still opens the page, just without the team chosen.
 */
export const useConnectedMailSettingsPath = (): ((account: MailSettingsTarget) => Promise<string>) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useCallback(async (account: MailSettingsTarget) => {
    if (!isSharedMailbox(account)) return connectedMailSettingsPath(account)
    try {
      const { connections } = await queryClient.fetchQuery({
        queryFn: () => fetchMailboxConnections(apiClient),
        queryKey: mailboxConnectionKeys.list,
      })
      const teamId = connections.find((connection) => connection.id === account.id)?.teamId ?? null
      return connectedMailSettingsPath(account, teamId)
    } catch {
      return connectedMailSettingsPath(account)
    }
  }, [apiClient, queryClient])
}
