import type { Prisma, PrismaClient } from '@prisma/client'
import type { TaskEventOrigin } from '@nessie/schemas'

import { listAccessibleProjectIds, type ProjectViewer } from './project-structure.js'

/**
 * Who is acting on a ticket's labels, comments or files.
 *
 * Deliberately not a request: the REST routes, the MCP tools and the worker's
 * `ticket_*` builtins all build one of these and call the same function, so a
 * refusal is decided once. `userId` is the member whose project entitlement is
 * checked and who owns the uploads being linked — the person for a route, the
 * person a personal assistant acts for, the requester behind a shared agent.
 * `agentId` is set when an agent performs the write, and makes the agent the
 * comment's author (a personal assistant acts *as* its person and leaves it
 * unset). `unattended` marks an agent run with no person behind it, whose
 * `TaskEvent.by` is `agent:<id>` rather than a user id.
 *
 * `origin` is the door the call came through, stamped by the layer that
 * authenticated it (docs/standards/ticket-work.md): a route's session or
 * credential, the worker's run, a source sync. It is never the caller's claim,
 * and absent means `system` — never `session` — so a caller that forgets it
 * can never start or steer ticket work.
 */
export type TaskActor = PersonTaskActor | AgentTaskActor

/** A ticket write with a person behind it: their reach, whoever performs it. */
export type PersonTaskActor = ProjectViewer & {
  agentId?: string | null
  unattended?: boolean
  origin?: TaskEventOrigin
}

/**
 * A ticket write with **no person behind it**: a `ticket.work` run, which acts
 * as its agent (docs/standards/ticket-work.md → "A `ticket.work` run acts as
 * the agent"). There is no member to check, so its reach is the agent's own
 * live binding — the projects of the live channels it is bound to, read on
 * every call — and never a person's membership, the trigger author's or the
 * mover's. Every event it writes names `agent:<id>` with the run.
 */
export type AgentTaskActor = {
  organizationId: string
  userId: null
  isOrganizationAdmin: false
  agentId: string
  unattended: true
  origin: Extract<TaskEventOrigin, { kind: 'agent' }>
}

/** The fields of a `TaskActor` that decide how a `TaskEvent` names its author. */
export type TaskEventAuthor = {
  userId: string | null
  agentId?: string | null
  unattended?: boolean
  origin?: TaskEventOrigin
}

/** The `by` a `TaskEvent` payload carries: a user id, or `agent:<id>` unattended. */
export const taskEventBy = (actor: Omit<TaskEventAuthor, 'origin'>): string => {
  if (actor.unattended && actor.agentId) return `agent:${actor.agentId}`
  if (actor.userId === null) {
    // An agent actor always names its agent; a write that names neither
    // would be credited to nobody.
    throw new Error('A ticket write with no person behind it names the agent that made it.')
  }
  return actor.userId
}

export const SYSTEM_TASK_EVENT_ORIGIN: TaskEventOrigin = { kind: 'system' }

/** `by` and `origin` together: every event an actor writes carries both. */
export const taskEventAuthorship = (
  actor: TaskEventAuthor,
): { by: string; origin: TaskEventOrigin } => ({
  by: taskEventBy(actor),
  origin: actor.origin ?? SYSTEM_TASK_EVENT_ORIGIN,
})

export type ProjectTaskVisibility = { accessibleProjectIds: string[]; actorUserId: string }

/**
 * The task list's visibility: the viewer's projects, projectless work, and
 * whatever they own or are assigned. Absent ⇒ organisation owner/admin.
 */
export const projectTaskVisibilityWhere = (visibility?: ProjectTaskVisibility) =>
  visibility
    ? {
        OR: [
          { projectId: { in: visibility.accessibleProjectIds } },
          { projectId: null },
          { ownerUserId: visibility.actorUserId },
          { assigneeUserId: visibility.actorUserId },
        ],
      }
    : {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A path id that is not a uuid names nothing; Postgres would 500 on the cast. */
export const isUuid = (value: string): boolean => UUID.test(value)

/**
 * The projects an agent with no person behind it reaches: those of the live
 * (neither deleted nor archived) channels it is bound to. A project of its
 * own is not reached this way — only a binding is.
 */
export const agentBoundProjectWhere = (agentId: string): Prisma.ProjectWhereInput => ({
  deletedAt: null,
  channels: { some: { deletedAt: null, archivedAt: null, agentBindings: { some: { agentId } } } },
})

const accessibleTaskWhere = async (
  prisma: PrismaClient,
  viewer: ProjectViewer | AgentTaskActor,
  taskId: string,
): Promise<Prisma.TaskWhereInput> => {
  if (viewer.userId === null) {
    return { id: taskId, organizationId: viewer.organizationId, project: agentBoundProjectWhere(viewer.agentId) }
  }
  const accessible = await listAccessibleProjectIds(prisma, viewer)
  return {
    id: taskId,
    organizationId: viewer.organizationId,
    AND: [
      // A task goes with its soft-deleted project, for admins too.
      { OR: [{ projectId: null }, { project: { deletedAt: null } }] },
      projectTaskVisibilityWhere(
        accessible === 'all'
          ? undefined
          : { accessibleProjectIds: accessible, actorUserId: viewer.userId },
      ),
    ],
  }
}

/**
 * The one question the comment, attachment and label doors ask about a task:
 * `getTask`'s visibility rule, lifted here so the attachment ACL, the routes
 * and the worker tools cannot answer it differently. Returns the columns every
 * caller needs next, or null for "no such task" and "not yours" alike.
 */
export const findAccessibleTask = async (
  prisma: PrismaClient,
  viewer: ProjectViewer | AgentTaskActor,
  taskId: string,
) => {
  if (!isUuid(taskId)) return null
  return prisma.task.findFirst({
    where: await accessibleTaskWhere(prisma, viewer, taskId),
    select: {
      id: true,
      organizationId: true,
      projectId: true,
      // The home board (null ⇒ the project's default): a ticket's labels are
      // that board's, so the label doors plan against it without a second read.
      boardId: true,
      detail: true,
      externalLink: {
        select: {
          sourceId: true,
          source: { select: { provider: true, writeMode: true } },
        },
      },
    },
  })
}

export type AccessibleTask = NonNullable<Awaited<ReturnType<typeof findAccessibleTask>>>

export const isTaskAccessibleToUser = async (
  prisma: PrismaClient,
  viewer: ProjectViewer,
  taskId: string,
): Promise<boolean> => {
  if (!isUuid(taskId)) return false
  return (await prisma.task.count({ where: await accessibleTaskWhere(prisma, viewer, taskId) })) > 0
}
