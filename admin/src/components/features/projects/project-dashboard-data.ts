/**
 * Pure derivations behind the project dashboard. Everything here is a plain
 * function over records the facades already fetch — no hooks, no fetching —
 * so the ordering/counting rules the four sections depend on are testable
 * without rendering React.
 */

// ─── Channels ───────────────────────────────────────────────────────────────

export type DashboardChannel = {
  id: string
  label: string
  type: 'standard' | 'dm'
  visibility: 'public' | 'protected' | 'private'
  projectId: string
  teamName: string
  unreadCount: number
  systemChannelType?: string | null
  archivedAt?: string | null
  // Additive server field (see the dashboard spec §7.2). Absent on any client
  // built before it lands, which is why every read goes through
  // `channelLastMessageMs` instead of touching the property directly.
  lastMessageAt?: string | null
}

export const CHANNEL_ROW_CAP = 8
export const MEMBER_ROW_CAP = 8
export const AGENT_ROW_CAP = 8

const parseMs = (value: string | null | undefined): number | null => {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Last-activity timestamp in ms, or `null` when the field is absent/empty. */
export const channelLastMessageMs = (channel: DashboardChannel): number | null =>
  parseMs(channel.lastMessageAt)

/**
 * The project's conversation rooms: non-archived, non-system standard channels.
 * Ordered unread-first (busiest first), then by recency, then alphabetically —
 * so with no `lastMessageAt` from the server the list is simply alphabetical.
 */
export const projectChannelRows = <T extends DashboardChannel>(
  channels: readonly T[],
  projectId: string,
): T[] =>
  channels
    .filter(
      (channel) =>
        channel.projectId === projectId
        && channel.type === 'standard'
        && !channel.archivedAt
        && !channel.systemChannelType,
    )
    .slice()
    .sort((a, b) => {
      const aUnread = a.unreadCount > 0
      const bUnread = b.unreadCount > 0
      if (aUnread !== bUnread) return aUnread ? -1 : 1
      if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount
      const aAt = channelLastMessageMs(a) ?? Number.NEGATIVE_INFINITY
      const bAt = channelLastMessageMs(b) ?? Number.NEGATIVE_INFINITY
      if (aAt !== bAt) return bAt - aAt
      return a.label.localeCompare(b.label)
    })

/**
 * Whether a channel row should name its team. A project whose channels all sit
 * under one team gains nothing from repeating that team on every row; a project
 * spanning teams needs it to tell two same-named rooms apart.
 */
export const showsChannelTeamName = (channels: readonly DashboardChannel[]): boolean =>
  new Set(channels.map((channel) => channel.teamName)).size > 1

// ─── Relative time ──────────────────────────────────────────────────────────

/**
 * Coarse age of a timestamp ("now", "4h", "3d", "2w"). Deliberately coarse:
 * the channel list is cached and only refreshed on mutations and realtime
 * message events, so minute-level precision would be a lie.
 */
export const formatRelativeAge = (
  value: string | null | undefined,
  now: number = Date.now(),
): string | null => {
  const ms = parseMs(value)
  if (ms === null) return null
  const minutes = Math.max(0, now - ms) / 60_000
  if (minutes < 60) return 'now'
  const hours = minutes / 60
  if (hours < 24) return `${Math.floor(hours)}h`
  const days = hours / 24
  if (days < 7) return `${Math.floor(days)}d`
  const weeks = days / 7
  if (weeks < 52) return `${Math.floor(weeks)}w`
  return `${Math.floor(days / 365)}y`
}

// ─── Work ───────────────────────────────────────────────────────────────────

export type DashboardTask = {
  status: string
  priority: string
  dueDate: string | null
  archivedAt: string | null
  iterationId: string | null
}

export type WorkCounts = {
  open: number
  overdue: number
  urgent: number
  failed: number
  awaitingApproval: number
}

// Terminal states: work that is finished, not work you can still act on.
const CLOSED_STATUSES = new Set(['done', 'cancelled'])

/**
 * The counts behind the Work chips. Only exceptions plus the `open` anchor —
 * every other status count would route to the same unfiltered board and say
 * nothing a person acts on.
 */
export const summarizeWork = (
  tasks: readonly DashboardTask[],
  now: number = Date.now(),
): WorkCounts => {
  const counts: WorkCounts = { open: 0, overdue: 0, urgent: 0, failed: 0, awaitingApproval: 0 }
  for (const task of tasks) {
    if (task.archivedAt || CLOSED_STATUSES.has(task.status)) continue
    counts.open += 1
    const due = parseMs(task.dueDate)
    if (due !== null && due < now) counts.overdue += 1
    if (task.priority === 'urgent') counts.urgent += 1
    if (task.status === 'failed') counts.failed += 1
    if (task.status === 'awaiting_approval') counts.awaitingApproval += 1
  }
  return counts
}

/**
 * A scrum board shows only the active sprint, so the chips must count the same
 * tasks the "Board →" link lands on — otherwise the dashboard says "Overdue 5"
 * and the board it opens shows two.
 */
export const scopeTasksToBoard = <T extends DashboardTask>(
  tasks: readonly T[],
  input: { isScrum: boolean; activeIterationId?: string | null },
): T[] =>
  input.isScrum
    ? tasks.filter((task) => task.iterationId === (input.activeIterationId ?? null))
    : tasks.slice()

// ─── Members ────────────────────────────────────────────────────────────────

export type DashboardMember = {
  userId: string
  displayName: string
  email: string
  role: string
}

const MEMBER_ROLE_RANK: Record<string, number> = { owner: 0, admin: 1, member: 2, viewer: 3 }

export const orderProjectMembers = <T extends DashboardMember>(members: readonly T[]): T[] =>
  members
    .slice()
    .sort((a, b) => {
      const rankA = MEMBER_ROLE_RANK[a.role] ?? 2
      const rankB = MEMBER_ROLE_RANK[b.role] ?? 2
      if (rankA !== rankB) return rankA - rankB
      return a.displayName.localeCompare(b.displayName)
    })

/**
 * Who sees "Manage →". Project membership carries its own roles, so a project
 * admin manages people without being an organisation owner; an organisation
 * owner may manage a project they are not a member of at all (no row of their
 * own in the list).
 */
export const canManageProjectMembers = (input: {
  isOrganizationOwner: boolean
  members: readonly DashboardMember[]
  userId: string | null | undefined
}): boolean => {
  if (input.isOrganizationOwner) return true
  const own = input.members.find((member) => member.userId === input.userId)
  return own?.role === 'owner' || own?.role === 'admin'
}

// ─── Agents ─────────────────────────────────────────────────────────────────

export type DashboardAgentStatus =
  | 'error'
  | 'waiting_approval'
  | 'executing'
  | 'thinking'
  | 'idle'
  | 'offline'

export type DashboardAgent = {
  id: string
  name: string
  role: string
  status: DashboardAgentStatus
  agentKind?: 'shared' | 'personal_assistant'
  channelIds: string[]
}

export type ProjectAgentRow<T extends DashboardAgent = DashboardAgent> = {
  agent: T
  // The project channel to open when the row is clicked.
  channelId: string
}

const AGENT_STATUS_RANK: Record<DashboardAgentStatus, number> = {
  error: 0,
  waiting_approval: 1,
  executing: 2,
  thinking: 3,
  idle: 4,
  offline: 5,
}

/**
 * The agents actually working in this project: those bound to one of its
 * channels. Personal assistants are excluded — a PA belongs to a person, not to
 * the project. Ordered by how much attention the agent needs.
 */
export const projectAgentRows = <T extends DashboardAgent>(
  agents: readonly T[],
  channels: readonly DashboardChannel[],
): ProjectAgentRow<T>[] => {
  const channelOrder = new Map(channels.map((channel, index) => [channel.id, index]))
  return agents
    .flatMap((agent) => {
      if (agent.agentKind === 'personal_assistant') return []
      const bound = agent.channelIds
        .filter((channelId) => channelOrder.has(channelId))
        .sort((a, b) => (channelOrder.get(a) ?? 0) - (channelOrder.get(b) ?? 0))
      const channelId = bound[0]
      return channelId ? [{ agent, channelId }] : []
    })
    .sort((a, b) => {
      const rankA = AGENT_STATUS_RANK[a.agent.status] ?? 4
      const rankB = AGENT_STATUS_RANK[b.agent.status] ?? 4
      if (rankA !== rankB) return rankA - rankB
      return a.agent.name.localeCompare(b.agent.name)
    })
}

/** Human label for an agent status dot. */
export const agentStatusLabel = (status: DashboardAgentStatus): string =>
  status === 'waiting_approval' ? 'waiting for approval' : status
