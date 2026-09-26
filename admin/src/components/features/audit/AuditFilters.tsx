import { useMemo } from 'react'

import { useAuditSummary } from '../../../facades/audit/hooks'
import { useProjects, useTeams } from '../../../facades/projects/hooks'
import { TabBar } from '../../primitives/TabBar'
import { useActorNames } from '../../shared/ActorName'
import { Input, Select } from '../../shared/FormControls'
import { ListToolbar } from '../../shared/ListToolbar'
import {
  AUDIT_OUTCOME_FILTERS,
  auditWhereValue,
  hasAuditFilters,
  type AuditFilterValues,
  type AuditOutcomeFilter,
} from './audit-filters'
import { auditActionLabel } from './audit-words'

const OUTCOME_ITEMS: ReadonlyArray<{ label: string; value: AuditOutcomeFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Succeeded', value: 'success' },
  { label: 'Refused', value: 'denied' },
  { label: 'Failed', value: 'error' },
]

// The Who choice lists the most active actors first. A trail can hold
// thousands; the rest are still one doorway away, from any of their entries.
const MAX_ACTOR_OPTIONS = 100

type AuditFiltersProps = {
  enabled: boolean
  filters: AuditFilterValues
  onChange: (name: 'action' | 'actor' | 'from' | 'to', value: string) => void
  onClear: () => void
  onOutcome: (next: AuditOutcomeFilter) => void
  /** `team:<id>`, `project:<id>`, or '' for anywhere — one choice, one write. */
  onWhere: (where: string) => void
  /** The strip's value, owned by the page through `useTabParam`. */
  outcome: AuditOutcomeFilter
  total: number | undefined
}

/**
 * The five questions the trail is asked — who, what, whether it worked, when,
 * and where — over the filters the API already takes. Every choice is an exact
 * value the trail holds (the list filters by equality), so Who and What offer
 * what is there rather than a box that matches nothing when mistyped.
 */
export const AuditFilters = ({
  enabled,
  filters,
  onChange,
  onClear,
  onOutcome,
  onWhere,
  outcome,
  total,
}: AuditFiltersProps) => {
  const actions = useAuditSummary('action', enabled)
  const actors = useAuditSummary('actorId', enabled)
  const teams = useTeams()
  const projects = useProjects(enabled)
  const resolveActor = useActorNames()

  const actorOptions = useMemo(() => {
    const ids = (actors.data?.entries ?? []).slice(0, MAX_ACTOR_OPTIONS).map((entry) => entry.key)
    // An address naming an actor outside the list (an entry's doorway to a
    // rare one) still shows who it names.
    if (filters.actor && !ids.includes(filters.actor)) ids.unshift(filters.actor)
    // `service` asks every directory: an actor id alone does not say whether
    // it was a person, an agent or a named component.
    return ids.map((id) => ({ label: resolveActor('service', id).name, value: id }))
  }, [actors.data?.entries, filters.actor, resolveActor])

  const actionOptions = useMemo(() => {
    const codes = (actions.data?.entries ?? []).map((entry) => entry.key)
    if (filters.action && !codes.includes(filters.action)) codes.unshift(filters.action)
    return codes
      .map((code) => ({ label: auditActionLabel(code), value: code }))
      .sort((left, right) => left.label.localeCompare(right.label))
  }, [actions.data?.entries, filters.action])

  return (
    <div className="grid gap-3">
      <TabBar
        ariaLabel="Outcome"
        items={OUTCOME_ITEMS.filter((item) => AUDIT_OUTCOME_FILTERS.includes(item.value))}
        onChange={onOutcome}
        role="radiogroup"
        value={outcome}
      />
      <ListToolbar
        count={total === undefined ? undefined : `${total.toLocaleString('en-GB')} ${total === 1 ? 'entry' : 'entries'}`}
      >
        <Select
          aria-label="Who"
          className="max-w-[14rem]"
          onChange={(event) => onChange('actor', event.target.value)}
          size="compact"
          value={filters.actor}
        >
          <option value="">Anyone</option>
          {actorOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
        <Select
          aria-label="What"
          className="max-w-[16rem]"
          onChange={(event) => onChange('action', event.target.value)}
          size="compact"
          value={filters.action}
        >
          <option value="">Any action</option>
          {actionOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
        <Select
          aria-label="Where"
          className="max-w-[14rem]"
          onChange={(event) => onWhere(event.target.value)}
          size="compact"
          value={auditWhereValue(filters)}
        >
          <option value="">Anywhere</option>
          {(teams.data ?? []).length > 0 ? (
            <optgroup label="Teams">
              {(teams.data ?? []).map((team) => (
                <option key={team.id} value={`team:${team.id}`}>{team.name}</option>
              ))}
            </optgroup>
          ) : null}
          {(projects.data ?? []).length > 0 ? (
            <optgroup label="Projects">
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={`project:${project.id}`}>{project.name}</option>
              ))}
            </optgroup>
          ) : null}
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-[color:var(--tx3)]">
          From
          <Input
            aria-label="From"
            max={filters.to || undefined}
            onChange={(event) => onChange('from', event.target.value)}
            size="compact"
            type="date"
            value={filters.from}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-[color:var(--tx3)]">
          To
          <Input
            aria-label="To"
            min={filters.from || undefined}
            onChange={(event) => onChange('to', event.target.value)}
            size="compact"
            type="date"
            value={filters.to}
          />
        </label>
        {hasAuditFilters(filters) ? (
          <button className="text-sm text-[color:var(--lnk)] hover:underline" onClick={onClear} type="button">
            Clear filters
          </button>
        ) : null}
      </ListToolbar>
    </div>
  )
}
