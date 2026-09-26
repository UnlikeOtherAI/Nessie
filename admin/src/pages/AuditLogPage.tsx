import { useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { faDownload, faShieldHalved } from '@fortawesome/free-solid-svg-icons'

import { AuditEventList } from '../components/features/audit/AuditEventList'
import { AuditFilters } from '../components/features/audit/AuditFilters'
import { AuditVerificationResult } from '../components/features/audit/AuditVerificationResult'
import {
  AUDIT_OUTCOME_FILTERS,
  AUDIT_PAGE_PARAMS,
  auditQueryParams,
  hasAuditFilters,
  readAuditFilters,
  withAuditFilter,
  withAuditWhere,
  withoutAuditFilters,
} from '../components/features/audit/audit-filters'
import { FormError } from '../components/shared/FormActions'
import { PageBody, Section } from '../components/shared/PageBody'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import type { SettingsTabHostProps } from '../components/shared/SettingsPanel'
import { OwnerGate } from '../components/shared/OwnerGate'
import { downloadAuditExport, useAuditLog, useAuditVerification } from '../facades/audit/hooks'
import { useIsOwner } from '../facades/auth/hooks'
import { useTabParam } from '../navigation/useTabParam'
import { useAuthSession } from '../providers/AuthSessionProvider'

/**
 * Security › Audit log: who did what, whether it worked, when and where — the
 * filters the API already takes, each in the address — every row opening its
 * entry, a copy of what the filters match (Export), and Verify integrity,
 * which answers in a sentence.
 */
export const AuditLogPage = ({ host }: { host?: SettingsTabHostProps }) => {
  // Still the page's own flag: every read below stays disabled for a
  // non-owner, exactly as before OwnerGate wrapped the render.
  const isOwner = useIsOwner()
  const { token } = useAuthSession()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [outcome, setOutcome] = useTabParam('outcome', AUDIT_OUTCOME_FILTERS, 'all', {
    clears: AUDIT_PAGE_PARAMS,
  })
  const filters = readAuditFilters(searchParams, outcome)
  const params = auditQueryParams(filters)
  const rows = useAuditLog(params, isOwner)

  const [verifyRequested, setVerifyRequested] = useState(false)
  const verification = useAuditVerification(verifyRequested)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // Every filter is a replace that carries the entry's state, like a tab: a
  // narrower trail is what this screen shows, not somewhere new to go Back from.
  const rewrite = (update: (current: URLSearchParams) => URLSearchParams) =>
    setSearchParams(update, { replace: true, state: location.state })

  const verify = () => {
    if (verifyRequested) void verification.refetch()
    else setVerifyRequested(true)
  }

  const exportTrail = async () => {
    setExportError(null)
    setExporting(true)
    try {
      await downloadAuditExport(params, token)
    } catch {
      setExportError('The export couldn’t be downloaded. Try again in a moment.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* The header is always rendered: a refusal is a state of this screen,
          not a screen of its own, so Back never disappears with it. */}
      <ScreenHeader
        actions={isOwner ? [
          {
            disabled: verification.isFetching,
            icon: faShieldHalved,
            id: 'verify-audit',
            label: verification.isFetching ? 'Verifying…' : 'Verify integrity',
            onSelect: verify,
            priority: 2,
          },
          {
            disabled: exporting,
            icon: faDownload,
            id: 'export-audit',
            label: exporting ? 'Exporting…' : 'Export',
            onSelect: () => void exportTrail(),
            priority: 1,
            title: hasAuditFilters(filters)
              ? 'Download every entry these filters match'
              : 'Download every entry',
          },
        ] : undefined}
        eyebrow={host?.eyebrow ?? 'Organisation'}
        tabs={host?.tabs}
        title={host?.title ?? 'Audit log'}
      />
      <OwnerGate>
        <PageBody>
          <AuditVerificationResult verification={verification} />
          <FormError>{exportError}</FormError>
          <Section title="Events">
            <AuditFilters
              enabled={isOwner}
              filters={filters}
              onChange={(name, value) => rewrite((current) => withAuditFilter(current, name, value))}
              onClear={() => rewrite(withoutAuditFilters)}
              onOutcome={setOutcome}
              onWhere={(where) => rewrite((current) => withAuditWhere(current, where))}
              outcome={outcome}
              total={rows.total}
            />

            <QueryState
              emptyLabel={hasAuditFilters(filters)
                ? 'Nothing in the trail matches these filters.'
                : 'Nothing has been recorded yet.'}
              errorLabel="Audit events could not be loaded."
              isEmpty={rows.items.length === 0}
              loadingLabel="Loading audit events…"
              query={rows.query}
            >
              {() => (
                <>
                  <AuditEventList entries={rows.items} />
                  <PaginationFooter
                    canNext={rows.canNext}
                    canPrevious={rows.canPrevious}
                    hideWhenSinglePage
                    label={rows.label}
                    onPageChange={rows.onPageChange}
                    onPageSizeChange={rows.onPageSizeChange}
                    page={rows.page}
                    pageCount={rows.pageCount}
                    pageSize={rows.pageSize}
                  />
                </>
              )}
            </QueryState>
          </Section>
        </PageBody>
      </OwnerGate>
    </section>
  )
}
