import type { ConnectedMailSource } from '@nessie/schemas'

import { connectionAnchorId } from '../../lib/connection-anchor'

export const connectedMailSettingsPath = (account: {
  id: string
  scope: 'personal' | 'shared'
  source: ConnectedMailSource
}): string => {
  const sharedMailbox = account.source === 'mailbox' && account.scope === 'shared'
  const root = sharedMailbox ? '/settings/organization?tab=agents' : '/settings/connections'
  return `${root}#${connectionAnchorId(account.id)}`
}
