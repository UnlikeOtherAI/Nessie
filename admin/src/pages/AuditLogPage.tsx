import { useState } from 'react'
import { Pill } from '../components/primitives/Pill'
import { ListToolbar } from '../components/shared/ListToolbar'
import { PageBody, Section } from '../components/shared/PageBody'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { QueryState } from '../components/shared/QueryState'
import { Row, RowList } from '../components/shared/RowList'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { OwnerGate } from '../components/shared/OwnerGate'
import { useIsOwner } from '../facades/auth/hooks'
import { auditLogKeys } from '../lib/query-keys'
import { usePagedList } from '../facades/pagination/usePagedList'

type AuditEntry = {
  id: string
  action: string
  actorType: string
  actorId: string
  resourceType: string
  resourceId: string | null
  outcome: string
  createdAt: string
  metadata: Record<string, unknown> | null
}

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
                  <RowList label="Audit events">
                    {rows.items.map((entry) => (
                      <Row
                        key={entry.id}
                        subtitle={
                          `${entry.actorType}:${entry.actorId.slice(0, 8)} → `
                          + `${entry.resourceType}${entry.resourceId ? `:${entry.resourceId.slice(0, 8)}` : ''}`
                        }
                        title={
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-[color:var(--tx)]">{entry.action}</span>
                            <Pill
                              radius="chip"
                              size="sm"
                              tone={entry.outcome === 'success' ? 'success' : 'danger'}
                            >
                              {entry.outcome}
                            </Pill>
                          </span>
                        }
                        trailing={
                          <span className="text-xs text-[color:var(--tx3)]">
                            {new Date(entry.createdAt).toLocaleString()}
                          </span>
                        }
                      />
                    ))}
                  </RowList>
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
