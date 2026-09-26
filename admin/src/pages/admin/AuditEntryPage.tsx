import { useNavigate, useParams } from 'react-router-dom'

import { AuditEntryDetails } from '../../components/features/audit/AuditEntryDetails'
import { auditActionLabel } from '../../components/features/audit/audit-words'
import { OwnerGate } from '../../components/shared/OwnerGate'
import { PageBody } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { ScreenHeader } from '../../components/shared/ScreenHeader'
import { useAuditEntry } from '../../facades/audit/hooks'
import { useIsOwner } from '../../facades/auth/hooks'
import { usePhoneNavigation } from '../../layouts/admin-shell/PhoneNavigationProvider'

/**
 * Admin › Security › one audit entry (`/admin/security/audit/:entryId`),
 * pushed from a row of the trail. Owner-only like the trail: the header stays
 * on every branch, so a refusal or a missing entry still has its way back.
 */
export const AuditEntryPage = () => {
  const { entryId } = useParams<{ entryId: string }>()
  const isOwner = useIsOwner()
  const entry = useAuditEntry(entryId, isOwner)
  const navigation = usePhoneNavigation()
  const navigate = useNavigate()
  // Back pops to the filtered trail the row was opened from; a cold link
  // lands on the trail itself.
  const back = () => {
    if (navigation) navigation.back({ fallback: '/admin/security' })
    else void navigate('/admin/security')
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        backLabel="Back to Security"
        eyebrow="Audit log"
        onBack={back}
        title={entry.data ? auditActionLabel(entry.data.action) : 'Audit entry'}
      />
      <OwnerGate>
        <PageBody>
          <QueryState
            errorLabel="This entry could not be loaded. It may not be in your organisation’s trail."
            loadingLabel="Loading the entry…"
            query={entry}
          >
            {() => (entry.data ? <AuditEntryDetails enabled={isOwner} entry={entry.data} /> : null)}
          </QueryState>
        </PageBody>
      </OwnerGate>
    </section>
  )
}
