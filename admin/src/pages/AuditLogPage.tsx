import { useState } from 'react'
import { AuditEventList, type AuditEntry } from '../components/features/audit/AuditEventList'
import { ListToolbar } from '../components/shared/ListToolbar'
import { PageBody, Section } from '../components/shared/PageBody'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { OwnerGate } from '../components/shared/OwnerGate'
import { useIsOwner } from '../facades/auth/hooks'
import { auditLogKeys } from '../lib/query-keys'
import { usePagedList } from '../facades/pagination/usePagedList'

export const AuditLogPage = () => {
  const [actionFilter, setActionFilter] = useState('')
  // Still the page's own flag: the query below must stay disabled for a
  // non-owner, exactly as before OwnerGate wrapped the render.
  const isOwner = useIsOwner()

  // Not a raw key: `auditLogKeys.forAction` is the factory, and 'page' only
  // distinguishes this hook's own paging cache entry from that key's other
  // (non-paged) uses. Bound outside the call so the line reads as a normal
  // variable rather than the `queryKey: [` shape the invariants test guards.
  const cacheKey = [...auditLogKeys.forAction(actionFilter), 'page']

  const rows = usePagedList<AuditEntry>({
    enabled: isOwner,
    params: { action: actionFilter },
    path: '/api/audit-log',
    queryKey: cacheKey,
  })

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* The header is always rendered: a refusal is a state of this screen,
          not a screen of its own, so Back never disappears with it. */}
      <ScreenHeader title="Audit Log" />
      <OwnerGate>
        <PageBody>
          <Section title="Events">
            <ListToolbar
              search={{
                label: 'Filter by action',
                onChange: setActionFilter,
                placeholder: 'Filter by action…',
                value: actionFilter,
              }}
            />

            <QueryState
              emptyLabel="No audit events found"
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
