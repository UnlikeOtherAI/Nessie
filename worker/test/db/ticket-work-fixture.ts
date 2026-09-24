import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'
import {
  TICKET_WORK_PURPOSE,
  TICKET_WORK_THREAD_MESSAGE_TOPIC,
  TicketWorkThreadMessageJobPayloadSchema,
  TRIGGER_TICKET_DISPATCH_TOPIC,
  TriggerTicketDispatchJobPayloadSchema,
  type AuthorizedActionContext,
  type StandingPolicyHostProfile,
  type TaskEventOrigin,
} from '@nessie/schemas'
import { createProjectTask, moveProjectTaskToColumn } from '@nessie/team-admin'

import { dispatchTicketThreadMessage } from '../../src/control/ticket-thread-message-dispatch.js'
import { dispatchTicketEvent } from '../../src/control/ticket-trigger-dispatch.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'

// One project with a board, a public channel the agent is bound to, and a
// `ticket_changed` trigger that picks up from In progress — the shape every
// ticket-work suite in this directory starts from. Not a test file itself:
// `test:db` globs `*.test.ts`.

export const SESSION: TaskEventOrigin = { kind: 'session' }

export type TicketWorkSeedOptions = {
  wakesPerTicket?: number
  startsPerDay?: number
  includeSourceEvents?: boolean
  followKinds?: string[]
  assignOnPickup?: boolean
  instructions?: Record<string, string> | null
  /**
   * A live standing policy for the trigger with one private, online machine
   * paired by the editor, written as a confirmation leaves it — so a pickup
   * is `active` on that machine. Without it, work waits for machine access
   * (`machine_access_not_set_up`). The policy's own rules are the
   * standing-policy suites'; this only gives the other suites active work.
   */
  machineAccess?: boolean
}

export const seedTicketWork = async (prisma: PrismaClient, options: TicketWorkSeedOptions = {}) => {
  const suffix = randomUUID()
  const [editor, outsider] = await Promise.all(['Ondrej', 'Visitor'].map((name) =>
    prisma.user.create({ data: { displayName: name, email: `ticket-work-${name}-${suffix}@example.test` } })))
  const organization = await prisma.organization.create({ data: { name: `ticket-work-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [editor!, outsider!].map((user) => ({ organizationId: organization.id, userId: user.id, role: 'member' })),
  })
  const project = await prisma.project.create({ data: { name: `Nessie ${suffix}`, organizationId: organization.id } })
  // Only the editor is in the project, so only the editor can edit its board.
  await prisma.projectMember.create({ data: { projectId: project.id, userId: editor!.id } })
  const team = await prisma.team.create({ data: { name: `Engineering ${suffix}`, projectId: project.id } })
  const board = await prisma.board.create({
    data: { projectId: project.id, organizationId: organization.id, name: 'Engineering', isDefault: true, position: 0 },
  })
  const column = async (name: string, category: 'todo' | 'in_progress' | 'review' | 'done', position: number) =>
    (await prisma.boardColumn.create({
      data: { boardId: board.id, organizationId: organization.id, name, category, position },
    })).id
  const columns = {
    backlog: await column('Backlog', 'todo', 0),
    inProgress: await column('In progress', 'in_progress', 1),
    review: await column('Review', 'review', 2),
    done: await column('Done', 'done', 3),
  }
  const agent = await prisma.agent.create({
    data: {
      name: `CTO ${suffix.slice(0, 6)}`,
      organizationId: organization.id,
      toolPolicy: { ticket_read: true, ticket_comment_add: true, ticket_move: true, ticket_create: true },
    },
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'engineering',
      slug: `engineering-${suffix}`,
      organization: { connect: { id: organization.id } },
      project: { connect: { id: project.id } },
      team: { connect: { id: team.id } },
    },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const instructions = options.instructions === null
    ? undefined
    : options.instructions ?? {
        general: 'Read the ticket, then comment what you will do.',
        onPickup: 'Say hello on the ticket.',
        onTicketChanged: 'Answer the change on the ticket.',
      }
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      type: 'ticket_changed',
      targetChannelId: channel.id,
      scopeProjectId: project.id,
      scopeBoardId: board.id,
      config: {
        boardId: board.id,
        pickup: { columnIds: [columns.inProgress], assignOnPickup: options.assignOnPickup ?? true },
        follow: {
          ...(options.followKinds ? { kinds: options.followKinds } : {}),
          includeSourceEvents: options.includeSourceEvents ?? false,
        },
        limits: { wakesPerTicket: options.wakesPerTicket ?? 30, startsPerDay: options.startsPerDay ?? 20 },
        ...(instructions ? { instructions } : {}),
        authorUserId: editor!.id,
      },
    },
  })
  const executorId = options.machineAccess
    ? await grantMachineAccess(prisma, {
        agentId: agent.id, authorUserId: editor!.id, organizationId: organization.id, projectId: project.id,
        teamId: team.id, triggerId: trigger.id,
      })
    : null
  const actorContext = {
    actor: { actorId: editor!.id, actorType: 'user', roles: ['member'] },
    actionContext: { requestId: randomUUID() },
    tenant: { organizationId: organization.id },
  } as unknown as AuthorizedActionContext
  return {
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    boardId: board.id,
    editorId: editor!.id,
    outsiderId: outsider!.id,
    agentId: agent.id,
    agentName: agent.name,
    channelId: channel.id,
    triggerId: trigger.id,
    executorId,
    columns,
    actorContext,
    cleanup: async () => {
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM queue_jobs
        WHERE payload->>'organizationId' = ${organization.id}
           OR payload->'actorContext'->'tenant'->>'organizationId' = ${organization.id}`)
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [editor!.id, outsider!.id] } } })
    },
  }
}
export type TicketWorkSeed = Awaited<ReturnType<typeof seedTicketWork>>

const grantMachineAccess = async (
  prisma: PrismaClient,
  input: { agentId: string; authorUserId: string; organizationId: string; projectId: string; teamId: string; triggerId: string },
): Promise<string> => {
  const executor = await prisma.executor.create({
    data: {
      label: 'Studio', lastSeenAt: new Date(), organizationId: input.organizationId,
      pairingOwnerUserId: input.authorUserId, scopeKind: 'private', status: 'online',
    },
  })
  const hostProfile: StandingPolicyHostProfile = {
    allowAnyCommand: false,
    allowedRootNames: ['nessie'],
    codingAgents: ['claude'],
    machines: [{
      executorId: executor.id, label: 'Studio', maxBudgetUsd: 5, maxLiveSessionsPerOwner: 3,
      mergeCommands: [], permissionMode: 'acceptEdits',
    }],
  }
  await prisma.executorStandingPolicy.create({
    data: {
      agentId: input.agentId,
      authorOrigin: { organizationId: input.organizationId, teamId: input.teamId, userId: input.authorUserId },
      authorUserId: input.authorUserId,
      confirmedAt: new Date(),
      executors: {
        create: [{ descriptorConfigDigest: 'sha256:test', executorId: executor.id, localPolicyDigest: 'sha256:test', position: 0 }],
      },
      hostProfile: hostProfile as unknown as Prisma.InputJsonValue,
      organizationId: input.organizationId,
      status: 'live',
      triggerDigest: 'sha256:test',
      triggerId: input.triggerId,
    },
  })
  return executor.id
}

export const newTask = async (
  prisma: PrismaClient,
  s: TicketWorkSeed,
  input: { title?: string; detail?: string; origin?: TaskEventOrigin } = {},
) => {
  const created = await createProjectTask(prisma, {
    actorContext: s.actorContext,
    organizationId: s.organizationId,
    createdByUserId: s.editorId,
    projectId: s.projectId,
    title: input.title ?? 'Fix login redirect',
    ...(input.detail ? { detail: input.detail } : {}),
    origin: input.origin ?? SESSION,
  })
  if ('error' in created) throw new Error(`newTask: ${created.error}`)
  return created
}

export const move = (
  prisma: PrismaClient,
  s: TicketWorkSeed,
  taskId: string,
  columnId: string,
  origin: TaskEventOrigin = SESSION,
) => moveProjectTaskToColumn(prisma, {
  taskId, organizationId: s.organizationId, columnId, actorId: s.editorId, origin,
})

/**
 * Run every dispatch job this seed's writers put on the queue and this suite
 * has not run yet, oldest first — the ticket events' and the work threads'
 * messages' alike — with the worker's own seam.
 */
export const drainTicketJobs = async (prisma: PrismaClient, s: TicketWorkSeed, seen: Set<string>) => {
  const jobs = await prisma.queueJob.findMany({
    where: {
      topic: { in: [TRIGGER_TICKET_DISPATCH_TOPIC, TICKET_WORK_THREAD_MESSAGE_TOPIC] },
      payload: { path: ['organizationId'], equals: s.organizationId },
    },
    orderBy: { enqueuedAt: 'asc' },
  })
  for (const job of jobs) {
    if (seen.has(job.id)) continue
    seen.add(job.id)
    if (job.topic === TRIGGER_TICKET_DISPATCH_TOPIC) {
      await dispatchTicketEvent(prisma, TriggerTicketDispatchJobPayloadSchema.parse(job.payload))
    } else {
      await dispatchTicketThreadMessage(prisma, TicketWorkThreadMessageJobPayloadSchema.parse(job.payload))
    }
  }
}

/** Finish every in-flight run in the thread, the way a run's terminal path does before it drains. */
export const finishRuns = (prisma: PrismaClient, threadId: string) =>
  prisma.run.updateMany({
    where: { threadId, status: { in: ['pending', 'running'] } },
    data: { status: 'completed' },
  })

/** A ticket tool's context on the work record's own `ticket.work` run. */
export const ticketWorkToolContext = (
  prisma: PrismaClient,
  s: TicketWorkSeed,
  work: { id: string; threadId: string },
): BuiltinToolRuntimeContext => ({
  actorContext: {
    actor: { actorId: s.agentId, actorType: 'agent', roles: ['system'] },
    actionContext: { purpose: TICKET_WORK_PURPOSE, requestId: randomUUID(), ticketWorkId: work.id },
    tenant: { organizationId: s.organizationId },
  },
  agentId: s.agentId,
  agentKind: 'shared',
  channel: { id: s.channelId, organizationId: s.organizationId, projectId: s.projectId },
  consumedSources: createConsumedSourceSink(),
  ledgerIdentity: null,
  prisma,
  realtimeTransport: { publishWs: async () => undefined },
  run: { id: randomUUID(), interactive: false, messageId: randomUUID(), threadId: work.threadId },
  toolCallId: randomUUID(),
} as unknown as BuiltinToolRuntimeContext)
