import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { attributionFromActorContext, type PgRealtimeTransport } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'

import { fileServiceFor } from '../../src/run/file-service.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'

/**
 * A run that can reach a spreadsheet, seeded the way production seeds one.
 *
 * The agent *creates* the space, which is what gives it an explicit grant
 * under the knowledge access model — the same arm that puts an agent in its own
 * documents home. A second space is seeded at the `restricted` tier so the
 * humans-only rule can be asserted against the real predicate rather than a
 * stub of it.
 *
 * The realtime transport is a recorder: presence is ephemeral and unrecoverable
 * by design, so the only way to prove an agent announced itself is to watch the
 * lane it publishes on.
 */

export type PublishedFrame = { event: string; pageId: string; data: unknown }

export type SpreadsheetFixture = {
  prisma: PrismaClient
  context: BuiltinToolRuntimeContext
  organizationId: string
  projectId: string
  teamId: string
  spaceId: string
  restrictedSpaceId: string
  agentId: string
  userId: string
  runId: string
  published: PublishedFrame[]
  cleanup: () => Promise<void>
}

export const seedSpreadsheetRun = async (
  label: string,
): Promise<SpreadsheetFixture> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Dana', email: `${label}-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `${label}-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `channel-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `sheet-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: {
      name: `Analyst ${suffix.slice(0, 6)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'running', threadId: thread.id },
  })
  const message = await prisma.message.create({
    data: { content: 'work the numbers', role: 'user', threadId: thread.id, userId: user.id },
  })

  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: agent.id,
      name: `Numbers ${suffix.slice(0, 6)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      visibility: 'project',
    },
  })
  const restricted = await prisma.knowledgeSpace.create({
    data: {
      createdBy: agent.id,
      name: `Payroll ${suffix.slice(0, 6)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      visibility: 'project',
      sensitivityTier: 'restricted',
    },
  })

  const published: PublishedFrame[] = []
  const realtimeTransport = {
    publishDocumentEphemeral: async (
      pageId: string,
      _organizationId: string,
      event: string,
      data: unknown,
    ) => {
      published.push({ event, pageId, data })
      return { inlined: true }
    },
    publishSse: async () => undefined as never,
    publishSseEphemeral: async () => undefined as never,
  } as unknown as PgRealtimeTransport

  const actorContext = {
    // Deliberately no `effectiveUserId`: this is an autonomous shared agent
    // working as itself, which is the arm the space rules answer differently
    // (an agent grant, a restricted-tier refusal) and the one the tools are
    // most often reached through.
    actionContext: {
      requestId: `${label}-${suffix}`,
      teamId: team.id,
    },
    actor: { actorId: agent.id, actorType: 'agent', roles: [] },
    tenant: { organizationId: organization.id, projectId: project.id, teamId: team.id },
  } as unknown as RunExecuteJobPayload['actorContext']

  const context = {
    agentId: agent.id,
    agentKind: 'shared',
    actorContext,
    channel: {
      id: channel.id,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      systemChannelType: null,
    },
    prisma,
    realtimeTransport,
    run: {
      id: run.id,
      messageId: message.id,
      threadId: thread.id,
      // The version writer needs somebody to attribute the indexing job to;
      // an agent working for nobody cannot embed what it wrote.
      originatingUserId: user.id,
      principalUserId: user.id,
    },
    toolCallId: `call-${suffix}`,
    ledgerIdentity: null,
  } as unknown as BuiltinToolRuntimeContext

  return {
    prisma,
    context,
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    spaceId: space.id,
    restrictedSpaceId: restricted.id,
    agentId: agent.id,
    userId: user.id,
    runId: run.id,
    published,
    cleanup: async () => {
      const files = fileServiceFor(prisma)
      const attachments = await prisma.attachment.findMany({
        where: { organizationId: organization.id },
        select: { id: true },
      })
      for (const attachment of attachments) {
        await files
          .delete(attachment.id, organization.id, attributionFromActorContext(actorContext))
          .catch(() => undefined)
      }
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: user.id } })
      await prisma.$disconnect()
    },
  }
}

/** The JSON a tool answered with; every handler returns a JSON string. */
export const answerOf = <T = Record<string, unknown>>(
  result: { output?: string; outputPreview?: string },
): T => JSON.parse(result.output ?? result.outputPreview ?? '{}') as T
