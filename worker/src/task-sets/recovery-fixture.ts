import { randomUUID } from 'node:crypto'
import type { TestContext } from 'node:test'
import { PrismaClient, type TaskSet } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { taskSetJson } from '@nessie/team-admin'

/** Isolated tenant and two independent connections; no test registration. */
export const seedTaskSetRecoveryFixture = async (t: TestContext) => {
  const prisma = new PrismaClient()
  const second = new PrismaClient()
  const organization = await prisma.organization.create({ data: { name: `task-set-test-${randomUUID()}` } })
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, displayName: 'Fixture' } })
  await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: user.id } })
  const project = await prisma.project.create({ data: { name: 'Fixture', organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: 'Fixture', projectId: project.id } })
  const channel = await prisma.channel.create({ data: {
    organizationId: organization.id, projectId: project.id, teamId: team.id, label: 'Fixture', slug: randomUUID(),
  } })
  await prisma.channelMember.create({ data: { channelId: channel.id, userId: user.id } })
  const agent = await prisma.agent.create({ data: {
    organizationId: organization.id, ownerUserId: user.id, name: 'Fixture',
  } })
  const actor: AuthorizedActionContext = {
    actor: { actorType: 'user', actorId: user.id }, tenant: { organizationId: organization.id },
    actionContext: { requestId: randomUUID(), effectiveUserId: user.id },
  }
  const sets: string[] = []
  t.after(async () => {
    await prisma.queueJob.deleteMany({ where: { OR: sets.map((id) => ({ idempotencyKey: { startsWith: `task-set:${id}:` } })) } })
    await prisma.taskSet.deleteMany({ where: { id: { in: sets } } })
    await prisma.inferenceResourceAdmission.deleteMany({ where: { resource: { organizationId: organization.id } } })
    await prisma.localInferenceResource.deleteMany({ where: { organizationId: organization.id } })
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.user.delete({ where: { id: user.id } })
    await Promise.all([prisma.$disconnect(), second.$disconnect()])
  })
  const create = async (options: Partial<Pick<TaskSet, 'capacityKey' | 'maxParallelRequests' | 'maxAttempts'>> = {}) => {
    const thread = await prisma.thread.create({ data: { channelId: channel.id } })
    const set = await prisma.taskSet.create({ data: {
      organizationId: organization.id, ownerUserId: user.id, name: 'Fixture', objective: 'Enrich one item', instructions: 'Return JSON',
      executionAgentId: agent.id, executionThreadId: thread.id,
      processor: { provider: 'openai', model: 'fixture' }, capacityKey: randomUUID(), output: { kind: 'journal' },
      launchOrigin: taskSetJson(actor), disclosure: { classified: true, basisScopes: [], disclosureSources: [] },
      status: 'running', inputClosedAt: new Date(), nextAttemptAt: new Date(Date.now() - 1_000), totalItems: 2, ...options,
    } })
    sets.push(set.id)
    const one = await prisma.taskSetItem.create({ data: {
      taskSetId: set.id, sequence: 1, clientKey: 'first', prompt: 'Summarize', input: { row: 1 },
      disclosure: taskSetJson(set.disclosure),
    } })
    await prisma.taskSetItem.create({ data: {
      taskSetId: set.id, sequence: 2, clientKey: 'second', prompt: 'Use prior result', input: { row: 2 },
      dependencies: [one.id], disclosure: taskSetJson(set.disclosure),
    } })
    return set
  }
  return { prisma, second, create, user, organization, project, team, channel, agent, actor }
}
