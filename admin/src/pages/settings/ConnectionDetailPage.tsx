import { useNavigate, useParams } from 'react-router-dom'

import { QueryState } from '../../components/shared/QueryState'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { Pill } from '../../components/primitives/Pill'
import { useCommsConnections } from '../../facades/connections/hooks'
import {
  ConnectionCard,
  PROVIDER_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
} from './connections/ConnectionCard'
import {
  DEFAULT_CONNECTION_TAB,
  PROVIDER_TAB,
  connectedAccountsPath,
} from './connections/connection-tabs'

/**
 * One connected account: its permissions, the resources it syncs, and the two
 * ways to end it.
 *
 * Reached by opening a row in the Mail and calendar or Chat table, and Back
 * returns to the tab that lists it. The card renders without its own heading
 * here — the screen header already names the provider, its status and the
 * account, and saying all three twice was the defect the list rework set out
 * to remove.
 */
export const ConnectionDetailPage = () => {
  const navigate = useNavigate()
  const { connectionId } = useParams<{ connectionId?: string }>()
  const connections = useCommsConnections()
  const connection = (connections.data?.connections ?? []).find(
    (candidate) => candidate.id === connectionId,
  )

  const backToList = () => void navigate(
    connectedAccountsPath(connection ? PROVIDER_TAB[connection.provider] : DEFAULT_CONNECTION_TAB),
  )

  if (!connection) {
    // The header is rendered here too: loading, failure and not-found are
    // states of this screen, and a phone with no header has no Back at all.
    return (
      <SettingsPanel
        backLabel="Back to Connected accounts"
        eyebrow="Connected accounts"
        onBack={backToList}
        title="Connected account"
      >
        <QueryState
          className="py-12"
          emptyLabel="This connection could not be found. It may already have been disconnected."
          errorLabel="Could not load your connected accounts."
          isEmpty
          loadingLabel="Loading connection…"
          query={connections}
        >
          {() => null}
        </QueryState>
      </SettingsPanel>
    )
  }

  return (
    <SettingsPanel
      backLabel="Back to Connected accounts"
      eyebrow="Connected accounts"
      onBack={backToList}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          <Pill height="control" tone={STATUS_TONE[connection.status]} uppercase={false}>
            {STATUS_LABEL[connection.status]}
          </Pill>
          <p className="text-sm text-[color:var(--tx3)]">
            {PROVIDER_LABEL[connection.provider]} · team {connection.externalTenantId}
          </p>
        </div>
      }
      title={connection.externalUserId}
    >
      <div className="max-w-3xl">
        <ConnectionCard connection={connection} heading={false} />
      </div>
    </SettingsPanel>
  )
}
