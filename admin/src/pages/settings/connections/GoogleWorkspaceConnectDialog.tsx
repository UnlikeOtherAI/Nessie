import { useState } from 'react'

import { useStartCommsConnection } from '../../../facades/connections/hooks'
import { Dialog } from '../../../components/shared/Dialog'
import { FormError } from '../../../components/shared/FormActions'
import {
  GOOGLE_WORKSPACE_CAPABILITIES,
  googleWorkspaceStartInput,
} from './google-workspace-connect'
import type { GoogleCapabilityId } from '../../../lib/api-client'

export const GoogleWorkspaceConnectDialog = ({ onClose, open }: { onClose: () => void; open: boolean }) => {
  const start = useStartCommsConnection()
  const [selected, setSelected] = useState<GoogleCapabilityId[]>(['calendar.read'])
  const [error, setError] = useState<string | null>(null)

  const toggle = (capability: GoogleCapabilityId) => {
    setSelected((current) => current.includes(capability)
      ? current.filter((entry) => entry !== capability)
      : [...current, capability])
  }

  const connect = async () => {
    setError(null)
    try {
      const result = await start.mutateAsync(googleWorkspaceStartInput(selected))
      window.location.assign(result.authorizeUrl)
    } catch {
      setError('Google could not start the connection. Try again.')
    }
  }

  return (
    <Dialog
      description="Choose only what you want your agents to use. This does not grant Gmail access."
      dismissDisabled={start.isPending}
      onClose={onClose}
      open={open}
      title="Connect Google Calendar and Meet"
    >
      <div className="grid gap-3 p-4">
        <fieldset className="grid gap-2">
          <legend className="text-sm font-semibold text-[color:var(--tx)]">Permissions</legend>
          {GOOGLE_WORKSPACE_CAPABILITIES.map((capability) => (
            <label className="flex gap-3 rounded border border-[color:var(--sep)] p-3" key={capability.id}>
              <input checked={selected.includes(capability.id)} onChange={() => toggle(capability.id)} type="checkbox" />
              <span>
                <span className="block text-sm font-medium text-[color:var(--tx)]">{capability.label}</span>
                <span className="mt-1 block text-xs text-[color:var(--tx2)]">{capability.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <FormError>{error}</FormError>
        <div className="flex justify-end">
          <button
            className="admin-button admin-button-primary"
            data-testid="connect-google-calendar-meet"
            disabled={selected.length === 0 || start.isPending}
            onClick={() => void connect()}
            type="button"
          >
            {start.isPending ? 'Opening Google…' : 'Continue with Google'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
