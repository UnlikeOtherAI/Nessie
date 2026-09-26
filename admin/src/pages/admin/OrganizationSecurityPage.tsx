import { TabBar } from '../../components/primitives/TabBar'
import { AUDIT_FILTER_PARAMS, AUDIT_PAGE_PARAMS } from '../../components/features/audit/audit-filters'
import type { SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useIsOwner } from '../../facades/auth/hooks'
import { useTabParam } from '../../navigation/useTabParam'
import { AuditLogPage } from '../AuditLogPage'
import { OrganizationPairedAgentsPage } from '../settings/OrganizationPairedAgentsPage'

const SECURITY_TABS = ['audit', 'programs'] as const

type SecurityTab = (typeof SECURITY_TABS)[number]

const TABS: ReadonlyArray<{ label: string; value: SecurityTab }> = [
  { label: 'Audit log', value: 'audit' },
  { label: 'Programs signed in as people', value: 'programs' },
]

// The audit log's filters and its page belong to that tab's list: the
// programs tab has no use for them, and coming back starts the trail afresh.
const TAB_OWNED_PARAMS = [...AUDIT_FILTER_PARAMS, ...AUDIT_PAGE_PARAMS] as const

/**
 * Admin › Security: what happened (the audit log) and what is holding
 * people's logins (the programs signed in as them, and whether pairing is
 * allowed at all). The page is not owner-only: the audit log keeps its owner
 * gate inside its tab, and an organisation administrator reaches the programs
 * list, Allow pairing and revocation as before — so it is the tab they land on.
 */
export const OrganizationSecurityPage = () => {
  const isOwner = useIsOwner()
  const [activeTab, setActiveTab] = useTabParam('tab', SECURITY_TABS, isOwner ? 'audit' : 'programs', {
    clears: TAB_OWNED_PARAMS,
  })
  const host: SettingsTabHostProps = {
    eyebrow: 'Organisation',
    tabs: (
      <TabBar
        ariaLabel="Security sections"
        items={TABS}
        onChange={setActiveTab}
        value={activeTab}
      />
    ),
    title: 'Security',
  }

  return activeTab === 'audit'
    ? <AuditLogPage host={host} />
    : <OrganizationPairedAgentsPage host={host} />
}
