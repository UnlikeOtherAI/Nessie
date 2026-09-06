import { useState } from 'react'
import type {
  CommsCapabilityState,
  CommsConnectionSummary,
  GoogleCapabilityId,
} from '../../../lib/api-client'
import { Pill, type PillTone } from '../../../components/primitives/Pill'
import { FormError } from '../../../components/shared/FormActions'
import { Row, RowList } from '../../../components/shared/RowList'
import { sectionTitleClass } from '../settings-presentation'
import {
  useStartCommsConnection,
  useUpdateCommsCapabilities,
} from '../../../facades/connections/hooks'

/**
 * The Permissions section of a Google connection: one row per capability, with
 * what it lets an agent do in plain words, whether the provider granted it, and
 * the controls to grant or block it.
 *
 * Three states, deliberately distinct because their remedies differ:
 *   granted  — usable now
 *   declined — asked for on the last authorization and refused at Google's
 *              consent screen, so the fix is to ask again
 *   blocked  — granted at Google but switched off here. Google cannot revoke a
 *              single scope (only the whole grant), so this is a local gate
 *              enforced when a tool asks for a credential — and the copy says
 *              so rather than claiming the permission was revoked.
 */

const RISK_TONE: Record<CommsCapabilityState['risk'], PillTone> = {
  read: 'muted',
  write: 'accent',
  send: 'warning',
}

const RISK_LABEL: Record<CommsCapabilityState['risk'], string> = {
  read: 'Read',
  write: 'Write',
  send: 'Send',
}

const CapabilityRow = ({
  capability,
  connection,
  disabledCapabilities,
  busy,
  onBlockChange,
}: {
  capability: CommsCapabilityState
  connection: CommsConnectionSummary
  disabledCapabilities: GoogleCapabilityId[]
  busy: boolean
  onBlockChange: (next: GoogleCapabilityId[]) => void
}) => {
  const start = useStartCommsConnection()
  const [error, setError] = useState<string | null>(null)

  const grant = async () => {
    setError(null)
    // Opened synchronously inside the click, then pointed when the mutation
    // resolves: a `window.open` after an await is outside the gesture stack and
    // Safari and popup-strict Chrome block it.
    const popup = window.open('', '_blank', 'noopener,noreferrer')
    try {
      const result = await start.mutateAsync({
        provider: 'google',
        capabilities: [capability.id],
        connectionId: connection.id,
      })
      if (popup) {
        popup.location.href = result.authorizeUrl
      } else {
        window.open(result.authorizeUrl, '_blank', 'noopener,noreferrer')
      }
    } catch {
      popup?.close()
      setError('Could not start the permission request. Please try again.')
    }
  }

  const toggleBlock = () => {
    const next = capability.blocked
      ? disabledCapabilities.filter((entry) => entry !== capability.id)
      : [...disabledCapabilities, capability.id]
    onBlockChange(next)
  }

  return (
    <Row
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-[color:var(--tx)]">
            {capability.label}
          </span>
          <Pill radius="chip" size="sm" tone={RISK_TONE[capability.risk]} uppercase={false}>
            {RISK_LABEL[capability.risk]}
          </Pill>
          {capability.granted && !capability.blocked ? (
            <Pill radius="chip" size="sm" tone="success" uppercase={false}>
              Granted
            </Pill>
          ) : null}
          {capability.blocked ? (
            <Pill radius="chip" size="sm" tone="warning" uppercase={false}>
              Blocked here
            </Pill>
          ) : null}
          {capability.declined ? (
            <Pill radius="chip" size="sm" tone="danger" uppercase={false}>
              Declined at Google
            </Pill>
          ) : null}
        </span>
      }
      trailing={
        capability.granted ? (
          <button
            className="admin-button admin-button-secondary"
            disabled={busy}
            onClick={toggleBlock}
            type="button"
          >
            {capability.blocked ? 'Unblock' : 'Block'}
          </button>
        ) : (
          <button
            className="admin-button admin-button-primary"
            disabled={start.isPending}
            onClick={() => void grant()}
            type="button"
          >
            {start.isPending ? 'Opening…' : capability.declined ? 'Ask again' : 'Grant'}
          </button>
        )
      }
    >
      <p className="mt-1 text-xs leading-5 text-[color:var(--tx2)]">
        {capability.explains}
      </p>
      {capability.blocked ? (
        <p className="mt-1 text-[11px] leading-4 text-[color:var(--tx3)]">
          Blocked in Nessie. Google cannot hand back a single permission —
          disconnect this account to revoke it at Google.
        </p>
      ) : null}
      <FormError className="mt-1">{error}</FormError>
    </Row>
  )
}

export const ConnectionPermissions = ({
  connection,
  capabilities,
}: {
  connection: CommsConnectionSummary
  capabilities: CommsCapabilityState[]
}) => {
  const update = useUpdateCommsCapabilities()

  if (capabilities.length === 0) {
    return null
  }

  const disabledCapabilities = capabilities
    .filter((capability) => capability.blocked)
    .map((capability) => capability.id)

  return (
    <div className="mt-4" data-testid="connection-permissions">
      <h3 className={sectionTitleClass}>Permissions</h3>
      <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
        What an agent can do with this account. Each permission is asked for
        separately, so you can add one later without reconnecting.
      </p>
      <div className="mt-2">
        <RowList label="Permissions">
          {capabilities.map((capability) => (
            <CapabilityRow
              busy={update.isPending}
              capability={capability}
              connection={connection}
              disabledCapabilities={disabledCapabilities}
              key={capability.id}
              onBlockChange={(next) =>
                update.mutate({ id: connection.id, disabledCapabilities: next })
              }
            />
          ))}
        </RowList>
      </div>
    </div>
  )
}
