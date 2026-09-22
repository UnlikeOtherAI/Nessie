import type { ReactNode } from 'react'

import { useCurrentOrganization } from '../../facades/organization/hooks'
import { SettingsPanel } from '../../components/shared/SettingsPanel'

/**
 * One client gate for the whole Organisation section. Its API counterpart
 * always rechecks before a protected read or write; this only keeps denied
 * viewers from issuing the roster queries in the first place.
 */
export const OrganizationAdministrationGate = ({ children }: { children: ReactNode }) => {
  const organization = useCurrentOrganization()
  const status = organization.data?.administration.status

  if (organization.isLoading) {
    return (
      <SettingsPanel eyebrow="Organisation" title="Organisation">
        <p className="text-sm text-[color:var(--tx3)]">Checking organisation access…</p>
      </SettingsPanel>
    )
  }

  if (organization.isError) {
    return (
      <SettingsPanel eyebrow="Organisation" title="Organisation unavailable">
        <p className="text-sm text-[color:var(--tx2)]">
          We couldn’t load your organisation access. Try again in a moment.
        </p>
      </SettingsPanel>
    )
  }

  if (status === 'unavailable') {
    return (
      <SettingsPanel eyebrow="Organisation" title="Organisation unavailable">
        <p className="text-sm text-[color:var(--tx2)]">
          We couldn’t check whether you’re an organisation admin. Try again in a moment.
        </p>
      </SettingsPanel>
    )
  }

  if (status !== 'allowed') {
    return (
      <SettingsPanel eyebrow="Organisation" title="Organisation">
        <p className="text-sm text-[color:var(--tx2)]">
          Only organisation admins can see this page.
        </p>
      </SettingsPanel>
    )
  }

  return <>{children}</>
}
