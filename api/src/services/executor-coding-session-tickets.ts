import type { PrismaClient } from '@prisma/client'
import { executorCodingSessionOwnerKey } from '@nessie/executor-manage'
import { ticketWorkCodingSessionContext, type ExecutorCodingSessionRecord } from '@nessie/schemas'
import { isProjectAccessibleToUser, ticketWorkThreadTitle } from '@nessie/team-admin'

/**
 * Which of a machine's reported sessions are a ticket's own
 * (docs/standards/ticket-work-machine-access.md → "What the screens show"):
 * a session a ticket's work started under its trigger's standing policy is
 * keyed by the ticket's owner context, which the executor page's context-less
 * keys never match. The work records that list a reported session id, and
 * whose owner key for this machine is exactly the session's, name its agent,
 * the policy's author, and the ticket — the ticket only for a reader who can
 * read its project.
 */

export type TicketSessionOwner = {
  agentId: string
  ticketWork: NonNullable<ExecutorCodingSessionRecord['ticketWork']>
}

export const loadTicketSessionOwners = async (
  prisma: PrismaClient,
  input: {
    executorId: string
    isOrganizationAdmin: boolean
    organizationId: string
    sessions: ReadonlyArray<{ ownerKey: string; sessionId: string }>
    viewerUserId: string
  },
): Promise<Map<string, TicketSessionOwner>> => {
  const owners = new Map<string, TicketSessionOwner>()
  if (input.sessions.length === 0) return owners
  const records = await prisma.agentTicketWork.findMany({
    where: {
      organizationId: input.organizationId,
      policyId: { not: null },
      sessionIds: { hasSome: input.sessions.map((session) => session.sessionId) },
    },
    orderBy: { startedAt: 'desc' },
    take: 100,
    select: {
      agentId: true, policyId: true, projectId: true, sessionIds: true, taskId: true,
      policy: { select: { authorUserId: true, author: { select: { displayName: true } } } },
      task: { select: { externalLink: { select: { externalKey: true } }, title: true } },
    },
  })
  const readable = new Map<string, boolean>()
  const canRead = async (projectId: string): Promise<boolean> => {
    if (!readable.has(projectId)) {
      readable.set(projectId, await isProjectAccessibleToUser(prisma, {
        isOrganizationAdmin: input.isOrganizationAdmin,
        organizationId: input.organizationId,
        userId: input.viewerUserId,
      }, projectId))
    }
    return readable.get(projectId) ?? false
  }
  for (const session of input.sessions) {
    const record = records.find((candidate) => candidate.sessionIds.includes(session.sessionId))
    if (!record?.policyId || !record.policy) continue
    const ownerKey = executorCodingSessionOwnerKey(input.executorId, {
      actorUserId: record.policy.authorUserId,
      agentId: record.agentId,
      contextId: ticketWorkCodingSessionContext(record.policyId, record.taskId),
    })
    // A record that names the id but not this owner is not the session's.
    if (ownerKey !== session.ownerKey) continue
    owners.set(session.sessionId, {
      agentId: record.agentId,
      ticketWork: {
        authorName: record.policy.author.displayName,
        ticket: await canRead(record.projectId)
          ? { projectId: record.projectId, taskId: record.taskId, title: ticketWorkThreadTitle(record.task) }
          : null,
      },
    })
  }
  return owners
}
