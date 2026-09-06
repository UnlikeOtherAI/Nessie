import type { BoardTaskRecord } from '../../../../facades/boards/hooks'
import type { AssignableUser } from '../../../../facades/tasks/hooks'
import type { BoardSourceProvider } from '../../../../facades/board-sources/hooks'

/**
 * Who a board is filtered to, as one closed vocabulary.
 *
 * Everything here is a *view* over the board's own pool — no board read is
 * re-issued and no filter is saved on the `Board`, because `BoardFilter` is
 * part of the board's shared definition and "my issues" cannot be: one
 * person narrowing the board to themselves would narrow it for the whole
 * project.
 *
 * `remote:` is the reason this is a vocabulary rather than a user id. A
 * mirrored item can carry an assignee the provider knows and Nessie does not
 * (`BoardSourceIdentityLink` resolved nothing), and that person has no user
 * id to filter by — only the provider's own id for them. Keying on their
 * display name instead would merge two Linear members who share one.
 */
export type AssigneeFilter =
  | 'all'
  | 'me'
  | 'unassigned'
  | `user:${string}`
  | `remote:${string}`

export const ALL_ASSIGNEES: AssigneeFilter = 'all'

/**
 * `remoteAssigneeDisplay` is written by the sync only when no identity link
 * resolved (`board-source-apply.ts`), so a non-null display name *is* the
 * "not mapped into Nessie" signal — the same one the card's `RemotePersonPill`
 * already draws. A mapped remote person carries an `assigneeUserId` instead
 * and belongs under their Nessie entry, never in both.
 */
const unmappedAssignee = (task: BoardTaskRecord) => {
  const link = task.externalLink
  if (!link?.remoteAssigneeDisplay) return null
  return {
    displayName: link.remoteAssigneeDisplay,
    // The provider scopes the id, so the provider is part of the key.
    externalId: link.remoteAssigneeExternalId ?? link.remoteAssigneeDisplay,
    provider: link.provider,
  }
}

export const remoteAssigneeValue = (
  provider: BoardSourceProvider,
  externalId: string,
): AssigneeFilter => `remote:${provider}:${externalId}`

export type RemoteAssigneeOption = {
  value: AssigneeFilter
  label: string
  provider: BoardSourceProvider
}

/**
 * The people this board can be filtered to: every colleague who could hold a
 * card, plus every provider person actually holding one.
 *
 * The two halves are gathered differently on purpose. Colleagues come from the
 * assignable list, so the control offers the whole team rather than only
 * whoever happens to have a card open right now. Unmapped people come from the
 * board itself — there is no roster of them to read, and an unmapped person
 * with nothing on this board is an option that would filter to nothing.
 */
export const assigneeFilterOptions = (
  tasks: BoardTaskRecord[],
  people: AssignableUser[],
): { people: AssignableUser[]; remote: RemoteAssigneeOption[] } => {
  const remote = new Map<string, RemoteAssigneeOption>()
  for (const task of tasks) {
    const found = unmappedAssignee(task)
    if (!found) continue
    const value = remoteAssigneeValue(found.provider, found.externalId)
    if (!remote.has(value)) {
      remote.set(value, { value, label: found.displayName, provider: found.provider })
    }
  }
  return {
    people,
    remote: [...remote.values()].sort((a, b) => a.label.localeCompare(b.label)),
  }
}

/**
 * Does this card survive the filter? `unassigned` means nobody at all — not a
 * colleague, not an agent, and not a provider person the card is already
 * naming, which would otherwise read as "unassigned" purely because Nessie
 * cannot resolve them.
 */
export const matchesAssigneeFilter = (
  task: BoardTaskRecord,
  filter: AssigneeFilter,
  currentUserId: string | null,
): boolean => {
  if (filter === 'all') return true
  if (filter === 'me') return Boolean(currentUserId) && task.assigneeUserId === currentUserId
  if (filter === 'unassigned') {
    return !task.assigneeUserId && !task.assigneeAgentId && !unmappedAssignee(task)
  }
  if (filter.startsWith('user:')) return task.assigneeUserId === filter.slice('user:'.length)
  const found = unmappedAssignee(task)
  return found !== null && remoteAssigneeValue(found.provider, found.externalId) === filter
}

/** A stored or hand-typed value that no longer names anything falls back to `all`. */
export const parseAssigneeFilter = (raw: string | null): AssigneeFilter => {
  if (!raw) return ALL_ASSIGNEES
  if (raw === 'me' || raw === 'unassigned' || raw === 'all') return raw
  if (raw.startsWith('user:') || raw.startsWith('remote:')) return raw as AssigneeFilter
  return ALL_ASSIGNEES
}
