import { Link } from 'react-router-dom'

import type { AuditEntry } from '../../../facades/audit/hooks'
import { useProjects, useTeams } from '../../../facades/projects/hooks'
import { ActorName, useActorNames } from '../../shared/ActorName'
import { KeyValueList, type KeyValueItem } from '../../shared/KeyValueList'
import { Section } from '../../shared/PageBody'
import { auditLogPath } from './audit-filters'
import { auditActionLabel, auditOutcome } from './audit-words'

/** A metadata value as text: a string as itself, anything else as indented JSON. */
const metadataValue = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : <pre className="whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>

/**
 * One audit entry, whole: what the row said in words, and the exact record
 * behind it — the action's code, the ids, the request it came from and the
 * details it was written with — because the trail's value is being able to
 * tie an entry to its subject precisely. Two doorways widen it again: the same
 * actor's entries, and every entry of the same action.
 */
export const AuditEntryDetails = ({ entry, enabled }: { enabled: boolean; entry: AuditEntry }) => {
  const resolveActor = useActorNames()
  const teams = useTeams()
  const projects = useProjects(enabled)
  const actor = resolveActor(entry.actorType, entry.actorId)
  const outcome = auditOutcome(entry.outcome)
  const teamName = teams.data?.find((team) => team.id === entry.teamId)?.name
  const projectName = projects.data?.find((project) => project.id === entry.projectId)?.name

  const facts: KeyValueItem[] = [
    { label: 'When', value: new Date(entry.createdAt).toLocaleString() },
    { label: 'Who', value: <ActorName actor={actor} /> },
    { label: 'What', value: auditActionLabel(entry.action) },
    { label: 'Outcome', value: outcome.label },
    ...(entry.reason ? [{ label: 'Why', value: entry.reason }] : []),
    { label: 'Record', mono: true, value: [entry.resourceType, entry.resourceId].filter(Boolean).join(' ') },
    ...(entry.teamId ? [{ label: 'Team', value: teamName ?? entry.teamId }] : []),
    ...(entry.projectId ? [{ label: 'Project', value: projectName ?? entry.projectId }] : []),
    ...(entry.channelId ? [{ label: 'Conversation', mono: true, value: entry.channelId }] : []),
  ]
  const technical: KeyValueItem[] = [
    { label: 'Action code', mono: true, value: entry.action },
    { label: 'Actor', mono: true, value: `${entry.actorType} ${entry.actorId}` },
    { label: 'Request', mono: true, value: entry.requestId },
    ...(entry.ipAddress ? [{ label: 'IP address', mono: true, value: entry.ipAddress }] : []),
    ...(entry.userAgent ? [{ label: 'Browser or app', value: entry.userAgent }] : []),
    { label: 'Entry', mono: true, value: entry.id },
  ]
  const metadata = Object.entries(entry.metadata ?? {})

  return (
    <>
      <Section title="What happened">
        <KeyValueList items={facts} />
      </Section>
      {metadata.length > 0 ? (
        <Section title="Details">
          <KeyValueList items={metadata.map(([key, value]) => ({ label: key, value: metadataValue(value) }))} />
        </Section>
      ) : null}
      <Section title="The record">
        <KeyValueList items={technical} />
      </Section>
      <Section title="Related">
        <ul className="grid gap-2 text-sm">
          <li>
            <Link className="text-[color:var(--lnk)] hover:underline" to={auditLogPath({ actor: entry.actorId })}>
              {`Everything ${actor.name} did`}
            </Link>
          </li>
          <li>
            <Link className="text-[color:var(--lnk)] hover:underline" to={auditLogPath({ action: entry.action })}>
              {`Every “${auditActionLabel(entry.action)}” entry`}
            </Link>
          </li>
        </ul>
      </Section>
    </>
  )
}
