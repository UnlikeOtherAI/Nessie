/**
 * Pure derivations behind the project Overview. Everything here is a plain
 * function over records the facades already fetch — no hooks, no fetching —
 * so the ordering, counting and fallback rules the page depends on are
 * testable without rendering React.
 *
 * The Members and Agents derivations were removed with the cards that used
 * them: People is a navigation tile carrying its own count, and an agent is
 * reached through the channel it works in.
 */

// ─── Channels ───────────────────────────────────────────────────────────────

export type DashboardChannel = {
  id: string
  label: string
  type: 'standard' | 'dm'
  visibility: 'public' | 'protected' | 'private'
  projectId: string
  teamName: string
  // Optional: a record built for somebody outside the room omits it, because
  // unread is participation metadata. Sorting reads it as zero.
  unreadCount?: number
  systemChannelType?: string | null
  archivedAt?: string | null
  // Additive server field (see the dashboard spec §7.2). Absent on any client
  // built before it lands, which is why every read goes through
  // `channelLastMessageMs` instead of touching the property directly.
  lastMessageAt?: string | null
}

/**
 * How many recent documents the Documents column asks for. One constant,
 * imported by that column and by the Docs tile, so both resolve the same
 * `knowledgeKeys.recentPages(projectId, limit)` cache entry — a second limit
 * would be a second request for the same list.
 */
export const RECENT_PAGE_LIMIT = 12

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
      const aCount = a.unreadCount ?? 0
      const bCount = b.unreadCount ?? 0
      const aUnread = aCount > 0
      const bUnread = bCount > 0
      if (aUnread !== bUnread) return aUnread ? -1 : 1
      if (aCount !== bCount) return bCount - aCount
      const aAt = channelLastMessageMs(a) ?? Number.NEGATIVE_INFINITY
      const bAt = channelLastMessageMs(b) ?? Number.NEGATIVE_INFINITY
      if (aAt !== bAt) return bAt - aAt
      return a.label.localeCompare(b.label)
    })

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
  /** Optional: only the Work queue's stable tie-break reads it. */
  title?: string | null
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

/**
 * What a person is shown in the Work column, and why that list and not
 * another. Overview answers "where is the work at the moment", which for the
 * reader means their own tickets first:
 *
 *   `mine` — open tickets assigned to them. The only list they can act on
 *            without picking something up first.
 *   `todo` — nothing is theirs, so the project's unclaimed `inbox` tickets:
 *            what anyone could take next.
 *   `open` — nothing is theirs and nothing is unclaimed, so everything still
 *            open. A column that went blank while the project had ten tickets
 *            in flight would be read as "no work here".
 *
 * The focus is returned rather than inferred at the call site, because the
 * card names which of the three it is showing — an unlabelled list of somebody
 * else's tickets reads as yours.
 */
export type WorkFocus = 'mine' | 'todo' | 'open'

export type QueueTask = DashboardTask & {
  assigneeUserId: string | null
  updatedAt: string
}

export type WorkQueue<T> = {
  focus: WorkFocus
  /** How many the focus matched in total, before the cap. */
  matched: number
  tasks: T[]
}

export const WORK_ROW_CAP = 8

/** Most recently touched first — "latest" — then by title so the order is stable. */
const byRecency = <T extends QueueTask>(a: T, b: T): number => {
  const aAt = parseMs(a.updatedAt) ?? Number.NEGATIVE_INFINITY
  const bAt = parseMs(b.updatedAt) ?? Number.NEGATIVE_INFINITY
  if (aAt !== bAt) return bAt - aAt
  return (a.title ?? '').localeCompare(b.title ?? '')
}

export const isOpenTask = (task: DashboardTask): boolean =>
  !task.archivedAt && !CLOSED_STATUSES.has(task.status)

export const projectWorkQueue = <T extends QueueTask>(
  tasks: readonly T[],
  input: { limit?: number; userId: string | null | undefined },
): WorkQueue<T> => {
  const limit = input.limit ?? WORK_ROW_CAP
  const open = tasks.filter(isOpenTask)
  const mine = input.userId
    ? open.filter((task) => task.assigneeUserId === input.userId)
    : []
  const todo = open.filter((task) => task.status === 'inbox')

  const [focus, matched]: [WorkFocus, T[]] =
    mine.length > 0 ? ['mine', mine] : todo.length > 0 ? ['todo', todo] : ['open', open]

  return {
    focus,
    matched: matched.length,
    tasks: matched.slice().sort(byRecency).slice(0, limit),
  }
}

/**
 * Tickets in no sprint — what the Backlog section holds. Only meaningful on a
 * scrum project, where the board shows the active iteration and everything
 * else waits here.
 */
export const backlogTaskCount = (tasks: readonly DashboardTask[]): number =>
  tasks.filter((task) => isOpenTask(task) && task.iterationId === null).length
