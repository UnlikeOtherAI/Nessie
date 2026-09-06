import { PROVIDER_LABEL } from '../../../../facades/board-sources/hooks'
import type { AssignableUser } from '../../../../facades/tasks/hooks'
import { Select } from '../../../shared/FormControls'
import type { AssigneeFilter, RemoteAssigneeOption } from './board-assignee-filter'

type BoardAssigneeFilterProps = {
  value: AssigneeFilter
  onChange: (next: AssigneeFilter) => void
  people: AssignableUser[]
  remote: RemoteAssigneeOption[]
  /** Absent while the session is still loading; "My issues" waits for it. */
  currentUserId: string | null
}

/**
 * Narrow the board to one person's cards.
 *
 * Native `<select>` with real `<optgroup>`s rather than a bespoke menu: the
 * list is one flat choice, it can run to a whole team, and the platform
 * already gives it type-ahead, keyboard and screen-reader grouping that a
 * hand-rolled popup would have to re-earn.
 *
 * The provider people sit in their own group and say which provider they came
 * from, because they are not colleagues: nobody in Nessie answers to that
 * name, and flattening them in with the team would quietly claim they do.
 */
export const BoardAssigneeFilter = ({
  value,
  onChange,
  people,
  remote,
  currentUserId,
}: BoardAssigneeFilterProps) => (
  <Select
    aria-label="Filter board by assignee"
    className="max-w-[220px]"
    data-board-assignee-filter
    onChange={(event) => onChange(event.target.value as AssigneeFilter)}
    size="compact"
    value={value}
  >
    <option value="all">All assignees</option>
    {currentUserId ? <option value="me">My issues</option> : null}
    <option value="unassigned">Unassigned</option>
    {people.length > 0 ? (
      <optgroup label="People">
        {people.map((person) => (
          <option key={person.id} value={`user:${person.id}`}>
            {person.displayName}
          </option>
        ))}
      </optgroup>
    ) : null}
    {remote.length > 0 ? (
      <optgroup label="Not in Nessie">
        {remote.map((person) => (
          <option key={person.value} value={person.value}>
            {person.label} · {PROVIDER_LABEL[person.provider]}
          </option>
        ))}
      </optgroup>
    ) : null}
  </Select>
)
