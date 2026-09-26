import { Pill } from '../../primitives/Pill'
import { useTranslation } from 'react-i18next'
import { Row, RowList } from '../../shared/RowList'
import { ActorName, shortId, useActorNames } from '../../shared/ActorName'

export type AuditEntry = {
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

/**
 * The audit trail's rows.
 *
 * Separated from the page so the actor line can be rendered — and pinned by a
 * test — without the owner gate and the paging around it. The page still owns
 * which events are shown; this owns how one reads.
 */
export const AuditEventList = ({ entries }: { entries: AuditEntry[] }) => {
  const { t, i18n } = useTranslation('operations')
  const resolveActor = useActorNames()

  return (
    <RowList label={t('audit.events')}>
      {entries.map((entry) => (
        <Row
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
            <span className="flex items-center gap-2">
              <span className="font-mono text-[color:var(--tx)]">{entry.action}</span>
              <Pill
                radius="chip"
                size="sm"
                tone={entry.outcome === 'success' ? 'success' : 'danger'}
              >
                {entry.outcome === 'success' ? t('audit.success') : t('audit.failure')}
              </Pill>
            </span>
          }
          trailing={
            <span className="text-xs text-[color:var(--tx3)]">
              {new Date(entry.createdAt).toLocaleString(i18n.resolvedLanguage ?? 'en-GB')}
            </span>
          }
        />
      ))}
    </RowList>
  )
}
