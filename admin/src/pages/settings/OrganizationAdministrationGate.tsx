import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useCurrentOrganization } from '../../facades/organization/hooks'
import { SettingsPanel } from '../../components/shared/SettingsPanel'

/**
 * One client gate for the whole Organisation section. Its API counterpart
 * always rechecks before a protected read or write; this only keeps denied
 * viewers from issuing the roster queries in the first place.
 */
export const OrganizationAdministrationGate = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation('settings')
  const organization = useCurrentOrganization()
  const status = organization.data?.administration.status

  if (organization.isLoading) {
    return (
      <SettingsPanel eyebrow={t('organization.organisation')} title={t('organization.organisation')}>
        <p className="text-sm text-[color:var(--tx3)]">{t('organization.checkingAccess')}</p>
      </SettingsPanel>
    )
  }

  if (organization.isError) {
    return (
      <SettingsPanel eyebrow={t('organization.organisation')} title={t('organization.unavailable')}>
        <p className="text-sm text-[color:var(--tx2)]">
          {t('organization.accessLoadFailed')}
        </p>
      </SettingsPanel>
    )
  }

  if (status === 'unavailable') {
    return (
      <SettingsPanel eyebrow={t('organization.organisation')} title={t('organization.unavailable')}>
        <p className="text-sm text-[color:var(--tx2)]">
          {t('organization.accessCheckFailed')}
        </p>
      </SettingsPanel>
    )
  }

  if (status !== 'allowed') {
    return (
      <SettingsPanel eyebrow={t('organization.organisation')} title={t('organization.organisation')}>
        <p className="text-sm text-[color:var(--tx2)]">{t('organization.adminOnlyPage')}</p>
      </SettingsPanel>
    )
  }

  return <>{children}</>
}
