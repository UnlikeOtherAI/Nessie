import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { TestContext } from 'node:test'
import { Prisma, PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import type { ExecutionDependencies } from '../run/execute/types.js'

export const taskSetFinalizationFixture = async (t: TestContext, count = 1) => {
  const prisma = new PrismaClient()
  const org = await prisma.organization.create({ data: { name: `task-set-finalize-${randomUUID()}` } })
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@task-set.test`, displayName: 'Owner' } })
  t.after(async () => {
    await prisma.$executeRaw(Prisma.sql`DELETE FROM queue_jobs WHERE payload->'actorContext'->'tenant'->>'organizationId' = ${org.id}`)
    await prisma.$executeRaw(Prisma.sql`DELETE FROM queue_jobs WHERE payload->>'taskSetId' IN
      (SELECT id::text FROM task_sets WHERE organization_id = ${org.id}::uuid)`)
    await prisma.taskSet.deleteMany({ where: { organizationId: org.id } })
    await prisma.organization.delete({ where: { id: org.id } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  })
  await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: 'owner' } })
  const project = await prisma.project.create({ data: { organizationId: org.id, name: 'Project' } })
  const team = await prisma.team.create({ data: { projectId: project.id, name: 'Team' } })
  const channel = await prisma.channel.create({ data: {
    organizationId: org.id, projectId: project.id, teamId: team.id, label: 'Private', slug: 'private', visibility: 'private',
    members: { create: { userId: user.id } },
  } })
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'General' } })
  const agent = await prisma.agent.create({ data: { organizationId: org.id, name: 'Processor', ownerUserId: user.id } })
  const receiver = await prisma.agent.create({ data: { organizationId: org.id, name: 'Receiver', ownerUserId: user.id } })
  await prisma.agentBinding.createMany({
    data: [agent, receiver].map((row) => ({ agentId: row.id, channelId: channel.id })),
  })
  const space = await prisma.knowledgeSpace.create({ data: {
    organizationId: org.id, projectId: project.id, teamId: team.id, name: 'Results', createdBy: user.id,
    visibility: 'private', members: { create: { organizationId: org.id, agentId: agent.id } },
  } })
  const disclosure = { classified: true as const,
    basisScopes: [{ scopeType: 'user', scopeId: user.id }], disclosureSources: [] }
  const origin = {
    actor: { actorType: 'user', actorId: user.id }, tenant: { organizationId: org.id, teamId: team.id },
    actionContext: { requestId: randomUUID(), effectiveUserId: user.id },
  }
  const set = await prisma.taskSet.create({ data: {
    organizationId: org.id, ownerUserId: user.id, executionAgentId: agent.id, executionThreadId: thread.id,
    name: 'Results', objective: 'Summarize every item', instructions: '', processor: { provider: 'test', model: 'test' },
    capacityKey: randomUUID(), output: { kind: 'journal' }, launchOrigin: origin, disclosure,
    status: 'running', inputClosedAt: new Date(), totalItems: count, completedItems: count, nextSequence: count + 1,
  } })
  if (count) await prisma.taskSetItem.createMany({ data: Array.from({ length: count }, (_, index) => ({
    taskSetId: set.id, sequence: index + 1, clientKey: String(index + 1), prompt: '', input: { id: index + 1 },
    disclosure, resultDisclosure: disclosure, result: `Result ${index + 1}`, status: 'completed',
  })) })
  let stored = 0
  let failOpen = false
  const bytes = new Map<string, Buffer>()
  const fileService = {
    store: async (input: Parameters<FileService['store']>[0]) => {
      const parts: Buffer[] = []
      for await (const chunk of input.body) parts.push(Buffer.from(chunk as Uint8Array))
      const body = Buffer.concat(parts)
      const attachment = await prisma.attachment.create({ data: {
        organizationId: org.id, filename: input.filename, mime: input.mime, kind: 'file',
        sizeBytes: BigInt(body.length), storageKey: randomUUID(),
      } })
      bytes.set(attachment.id, body); stored++
      return { attachment, bytesWritten: body.length }
    },
    openStream: async (id: string) => {
      if (failOpen) { failOpen = false; throw new Error('simulated crash after durable receipt') }
      const attachment = await prisma.attachment.findUnique({ where: { id } })
      return attachment ? { attachment, stream: Readable.from([bytes.get(id) ?? Buffer.alloc(0)]) } : null
    },
    delete: async () => undefined,
  } as unknown as FileService
  const deps = { prisma, fileService } as ExecutionDependencies & { fileService: FileService }
  return { prisma, deps, set, disclosure, origin, org, user, agent, receiver, channel, thread, space,
    stored: () => stored, crashAfterReceipt: () => { failOpen = true } }
}
