import type { ReactNode } from 'react'

import { useCurrentOrganization } from '../../facades/organization/hooks'
import { SettingsPanel } from './settings-shared'

/**
 * One client gate for the whole Organization section. Its API counterpart
 * always rechecks before a protected read or write; this only keeps denied
 * viewers from issuing the roster queries in the first place.
 */
export const OrganizationAdministrationGate = ({ children }: { children: ReactNode }) => {
  const organization = useCurrentOrganization()
  const status = organization.data?.administration.status

  if (organization.isLoading) {
    return (
      <SettingsPanel eyebrow="Organization" title="Organization">
        <p className="text-sm text-[color:var(--tx3)]">Checking organisation access…</p>
      </SettingsPanel>
    )
  }

  if (organization.isError) {
    return (
      <SettingsPanel eyebrow="Organization" title="Organization unavailable">
        <p className="text-sm text-[color:var(--tx2)]">
          We could not load your organisation access. Try again shortly.
        </p>
      </SettingsPanel>
    )
  }

  if (status === 'unavailable') {
    return (
      <SettingsPanel eyebrow="Organization" title="Organization unavailable">
        <p className="text-sm text-[color:var(--tx2)]">
          UnlikeOtherAI could not confirm your organisation administrator access. Try again shortly.
        </p>
      </SettingsPanel>
    )
  }

  if (status !== 'allowed') {
    return (
      <SettingsPanel eyebrow="Organization" title="Organization">
        <p className="text-sm text-[color:var(--tx2)]">
          Organisation administrator access is required.
        </p>
      </SettingsPanel>
    )
  }

  return <>{children}</>
}
