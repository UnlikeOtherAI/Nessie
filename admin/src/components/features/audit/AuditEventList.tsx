import type { AuditEntry } from '../../../facades/audit/hooks'
import { Pill } from '../../primitives/Pill'
import { Row, RowList } from '../../shared/RowList'
import { ActorName, shortId, useActorNames } from '../../shared/ActorName'
import { auditActionLabel, auditOutcome } from './audit-words'

/** The fields a row reads; an entry's page reads the rest. */
export type AuditEventRow = Pick<
  AuditEntry,
  'action' | 'actorId' | 'actorType' | 'createdAt' | 'id' | 'outcome' | 'resourceId' | 'resourceType'
>

export const auditEntryPath = (entryId: string): string =>
  `/admin/security/audit/${encodeURIComponent(entryId)}`

/**
 * The audit trail's rows, each opening its entry.
 *
 * Separated from the page so the actor line can be rendered — and pinned by a
 * test — without the owner gate and the paging around it. The page still owns
 * which events are shown; this owns how one reads: the action in words (its
 * exact code is on the entry's page), who did it, what it touched, and when.
 */
export const AuditEventList = ({ entries }: { entries: AuditEventRow[] }) => {
  const resolveActor = useActorNames()

  return (
    <RowList label="Audit events">
      {entries.map((entry) => {
        const outcome = auditOutcome(entry.outcome)
        const action = auditActionLabel(entry.action)
        return (
          <Row
            ariaLabel={`Open ${action}, ${new Date(entry.createdAt).toLocaleString()}`}
            href={auditEntryPath(entry.id)}
            key={entry.id}
            subtitle={
              <>
                <ActorName actor={resolveActor(entry.actorType, entry.actorId)} />
                {' → '}
                <span
                  title={entry.resourceId ? `${entry.resourceType} ${entry.resourceId}` : entry.resourceType}
                >
                  {entry.resourceType}
                  {entry.resourceId ? `:${shortId(entry.resourceId)}` : ''}
                </span>
              </>
            }
            title={
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[color:var(--tx)]" title={entry.action}>{action}</span>
                <Pill radius="chip" size="sm" tone={outcome.tone} uppercase={false}>
                  {outcome.label}
                </Pill>
              </span>
            }
            trailing={
              <span className="text-xs text-[color:var(--tx3)]">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            }
          />
        )
      })}
    </RowList>
  )
}
