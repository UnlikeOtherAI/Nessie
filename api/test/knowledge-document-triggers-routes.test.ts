import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import {
  documentTriggerDeliveryKey,
  type AuthorizedActionContext,
  type SpaceDocumentTriggersRecord,
} from '@nessie/schemas'

import { registerKnowledgeDocumentTriggerRoutes } from '../src/routes/knowledge-document-triggers.js'
import { seedDefaultPolicies } from '../src/services/policy-seed.js'

/**
 * The Finder's row badge and doorway (docs/standards/document-triggers.md →
 * "What a person sees"), through the real route against Postgres: the newest
 * review of each listed page a viewer may read — by an agent the viewer may
 * see, "sent" until its run completed and "reviewed" after — its thread only
 * for a viewer who may open it, a page the viewer cannot read never named,
 * and the doorway offered only by the Triggers routes' own owner gate.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('the Finder read gives each readable page its newest review, and the doorway only to owners', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `doc-reviews-${suffix}` } })
  const [owner, member] = await Promise.all(['Ondrej', 'Jana'].map((name) =>
    prisma.user.create({ data: { displayName: name, email: `doc-reviews-${name}-${suffix}@example.test` } })))
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { id: { in: [owner!.id, member!.id] } } })
    await prisma.$disconnect()
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, userId: owner!.id, role: 'owner' },
      { organizationId: organization.id, userId: member!.id, role: 'member' },
    ],
  })
  const project = await prisma.project.create({ data: { name: `Nessie ${suffix}`, organizationId: organization.id } })
  await prisma.projectMember.createMany({
    data: [owner!, member!].map((user) => ({ projectId: project.id, userId: user.id })),
  })
  await seedDefaultPolicies(prisma, organization.id, owner!.id)
  const team = await prisma.team.create({ data: { name: `Eng ${suffix}`, projectId: project.id } })
  const channel = (label: string, visibility: 'public' | 'protected') => prisma.channel.create({
    data: { label, slug: `${label}-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id, visibility },
  })
  const room = await channel('engineering', 'public')
  const leads = await channel('leads', 'protected')
  await prisma.channelMember.create({ data: { channelId: leads.id, userId: owner!.id } })
  const agent = await prisma.agent.create({ data: { name: 'CTO', organizationId: organization.id, visibility: 'team' } })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: room.id } })
  const space = await prisma.knowledgeSpace.create({
    data: { createdBy: owner!.id, name: 'Tech docs', organizationId: organization.id, projectId: project.id, visibility: 'project' },
  })
  const provider = createNativeKnowledgeProvider(prisma)
  const scope = {
    authorId: owner!.id, authorType: 'user' as const, createdBy: owner!.id,
    organizationId: organization.id, projectId: project.id, spaceId: space.id,
  }
  const spec = await provider.createPage({ ...scope, title: 'Login spec', body: '<p>v1</p>' })
  await provider.updatePage(spec.id, { ...scope, body: '<p>v2</p>' })
  const leadsOnly = await provider.createPage({ ...scope, title: 'Leads spec', body: '<p>v1</p>' })
  const unreviewed = await provider.createPage({ ...scope, title: 'Quiet page', body: '<p>v1</p>' })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id, type: 'document_changed', targetChannelId: room.id, scopeProjectId: project.id,
      config: { spaceId: space.id, instructions: { general: 'Review it.' } },
    },
  })
  // A second reviewer only the leads room binds: the member cannot see it.
  const hidden = await prisma.agent.create({ data: { name: 'Leads reviewer', organizationId: organization.id } })
  await prisma.agentBinding.create({ data: { agentId: hidden.id, channelId: leads.id } })
  const hiddenTrigger = await prisma.agentTrigger.create({
    data: {
      agentId: hidden.id, type: 'document_changed', targetChannelId: leads.id, scopeProjectId: project.id,
      config: { spaceId: space.id, instructions: { general: 'Review it too.' } },
    },
  })
  const deliver = async (
    pageId: string, versionNumber: number, channelId: string, at: Date,
    by: { agentId: string; triggerId: string } = { agentId: agent.id, triggerId: trigger.id },
  ) => {
    const version = await prisma.knowledgePageVersion.findFirstOrThrow({ where: { pageId, versionNumber } })
    const thread = await prisma.thread.create({
      data: { agentId: by.agentId, channelId, metadata: { pageId, triggerId: by.triggerId } },
    })
    const delivery = await prisma.agentTriggerDelivery.create({
      data: {
        triggerId: by.triggerId, dedupeKey: documentTriggerDeliveryKey(by.triggerId, pageId, version.id), source: 'document',
        status: 'delivered', deliveredAt: at,
        payload: {
          pageId, spaceId: space.id, projectId: project.id, taskId: null, kind: 'document', fireOn: 'save',
          fromVersionId: null, fromVersionNumber: null, toVersionId: version.id, toVersionNumber: versionNumber,
          versionsCoalesced: versionNumber, authorKinds: ['person'], bodyChars: 9, outcome: 'page_thread', threadId: thread.id,
        },
      },
    })
    return { ...thread, deliveryId: delivery.id }
  }
  await deliver(spec.id, 1, room.id, new Date(Date.now() - 60_000))
  const newest = await deliver(spec.id, 2, room.id, new Date(Date.now() - 30_000))
  // Its review ran to the end: the badge may say "Reviewed".
  await prisma.run.create({
    data: {
      agentId: agent.id, threadId: newest.id, triggerDeliveryId: newest.deliveryId, triggerId: trigger.id,
      status: 'completed', startedAt: new Date(), finishedAt: new Date(),
    },
  })
  // Newer still, by the reviewer the member cannot see.
  const hiddenReview = await deliver(spec.id, 2, leads.id, new Date(), { agentId: hidden.id, triggerId: hiddenTrigger.id })
  const leadsThread = await deliver(leadsOnly.id, 1, leads.id, new Date())
  // A run still going in its thread: sent, not yet reviewed.
  await prisma.run.create({
    data: { agentId: agent.id, threadId: leadsThread.id, triggerDeliveryId: leadsThread.deliveryId, status: 'running' },
  })

  let actor: AuthorizedActionContext = { actor: { actorId: member!.id, actorType: 'user', roles: ['member'] },
    actionContext: { requestId: randomUUID() }, tenant: { organizationId: organization.id } } as AuthorizedActionContext
  const app = Fastify({ logger: false })
  registerKnowledgeDocumentTriggerRoutes(app, {
    prisma,
    knowledgeProvider: provider,
    fileService: { usageForScope: async () => 0n },
    isProjectAccessibleToActor: async () => true,
    requireActorContext: () => actor,
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerKnowledgeDocumentTriggerRoutes>[1])
  t.after(() => app.close())
  const read = async (pageIds: string[]) => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/knowledge-base/spaces/${space.id}/document-triggers?pageIds=${pageIds.join(',')}`,
    })
    assert.equal(response.statusCode, 200, response.body)
    return (response.json() as { data: SpaceDocumentTriggersRecord }).data
  }

  const asMember = await read([spec.id, leadsOnly.id, unreviewed.id, randomUUID()])
  assert.equal(asMember.viewerCanCreateTriggers, false, 'a member is not offered the doorway')
  assert.equal(asMember.projectId, project.id)
  const byPage = new Map(asMember.reviews.map((review) => [review.pageId, review]))
  assert.equal(byPage.size, 2, 'only pages with a review, never an unknown id')
  assert.deepEqual(byPage.get(spec.id)?.agent, { id: agent.id, name: 'CTO' },
    'a newer review by an agent the member cannot see is passed over, not the badge taken away')
  assert.equal(byPage.get(spec.id)?.versionNumber, 2, 'the newest review')
  assert.equal(byPage.get(spec.id)?.state, 'reviewed', 'its run completed')
  assert.deepEqual(byPage.get(spec.id)?.thread, { id: newest.id, channelId: room.id })
  assert.equal(byPage.get(leadsOnly.id)?.thread, null, 'a thread in a room the member is not in: the badge, no door')
  assert.equal(byPage.get(leadsOnly.id)?.state, 'sent', 'its run has not finished: sent, never "reviewed"')

  actor = { ...actor, actor: { actorId: owner!.id, actorType: 'user', roles: ['owner'] } } as AuthorizedActionContext
  const asOwner = await read([leadsOnly.id, spec.id])
  assert.equal(asOwner.viewerCanCreateTriggers, true)
  const ownerByPage = new Map(asOwner.reviews.map((review) => [review.pageId, review]))
  assert.deepEqual(ownerByPage.get(leadsOnly.id)?.thread, { id: leadsThread.id, channelId: leads.id })
  assert.deepEqual([ownerByPage.get(spec.id)?.agent.name, ownerByPage.get(spec.id)?.state], ['Leads reviewer', 'sent'],
    'a viewer who may see the newer reviewer gets its review')
  assert.deepEqual(ownerByPage.get(spec.id)?.thread, { id: hiddenReview.id, channelId: leads.id })

  // A page the viewer cannot read is never named, even by its badge.
  await prisma.knowledgeSpace.update({ where: { id: space.id }, data: { visibility: 'private', createdBy: owner!.id } })
  actor = { ...actor, actor: { actorId: member!.id, actorType: 'user', roles: ['member'] } } as AuthorizedActionContext
  const refused = await app.inject({
    method: 'GET',
    url: `/api/knowledge-base/spaces/${space.id}/document-triggers?pageIds=${spec.id}`,
  })
  assert.equal(refused.statusCode, 403)
})
