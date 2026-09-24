import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import { DocumentChangedStoredConfigSchema, TRIGGER_DOCUMENT_DISPATCH_TOPIC } from '@nessie/schemas'

import {
  documentTriggerOnPagePublished,
  documentTriggerOnVersionCreated,
} from '../src/document-trigger-enqueue.js'
import { TriggerConfigRefusalError } from '../src/trigger-config-refusal.js'
import { createAgentTrigger } from '../src/trigger-create.js'
import { documentTriggerResumeRefusal } from '../src/trigger-document-config.js'
import { updateAgentTrigger } from '../src/trigger-lifecycle.js'

/**
 * A `document_changed` trigger is resolved on the server and refused field by
 * field (docs/standards/document-triggers.md): the project from its public
 * target channel, the space by id — named, implied by a folder or pages, or
 * the project's Documents space — readable by the whole channel, by the agent
 * and by the person setting it up. A save it watches opens one quiet window.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const INSTRUCTIONS = { general: 'Review the edit, and say on the thread what changed.' }

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const user = (name: string) => prisma.user.create({ data: { displayName: name, email: `doc-config-${name}-${suffix}@example.test` } })
  const owner = await user('owner')
  const outsider = await user('outsider')
  const organization = await prisma.organization.create({ data: { name: `doc-config-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'owner', userId: outsider.id },
    ],
  })
  const project = await prisma.project.create({ data: { name: 'Nessie', organizationId: organization.id } })
  const other = await prisma.project.create({ data: { name: 'Elsewhere', organizationId: organization.id } })
  await prisma.projectMember.create({ data: { projectId: project.id, userId: owner.id } })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channel = (label: string, data: Record<string, unknown> = {}) =>
    prisma.channel.create({
      data: {
        label, organizationId: organization.id, projectId: project.id, slug: `${label}-${suffix}`,
        teamId: team.id, visibility: 'public', ...data,
      },
      select: { id: true },
    })
  const eng = await channel('eng')
  const secret = await channel('secret', { visibility: 'protected' })
  const agent = await prisma.agent.create({ data: { name: 'CTO', organizationId: organization.id, projectId: project.id } })
  for (const channelId of [eng.id, secret.id]) await prisma.agentBinding.create({ data: { agentId: agent.id, channelId } })
  const space = (name: string, data: Record<string, unknown> = {}) => prisma.knowledgeSpace.create({
    data: { createdBy: owner.id, name, organizationId: organization.id, projectId: project.id, visibility: 'project', ...data },
    select: { id: true },
  })
  const docs = await space('Project Documents', { metadata: { projectDocuments: true } })
  const tech = await space('Tech docs')
  const privateSpace = await space('Private notes', { visibility: 'private' })
  const restricted = await space('Payroll', { sensitivityTier: 'restricted' })
  const foreign = await prisma.knowledgeSpace.create({
    data: { createdBy: owner.id, name: 'Foreign', organizationId: organization.id, projectId: other.id, visibility: 'project' },
    select: { id: true },
  })
  const provider = createNativeKnowledgeProvider(prisma)
  const scope = {
    authorId: owner.id, authorType: 'user' as const, createdBy: owner.id,
    organizationId: organization.id, projectId: project.id,
  }
  const specs = await provider.createPage({ ...scope, kind: 'folder', spaceId: tech.id, title: 'Specs' })
  const spec = await provider.createPage({ ...scope, body: '<p>Login</p>', parentPageId: specs.id, spaceId: tech.id, title: 'Login spec' })
  const loose = await provider.createPage({ ...scope, body: '<p>Other</p>', spaceId: tech.id, title: 'Loose note' })
  const foreignPage = await provider.createPage({ ...scope, body: '<p>F</p>', projectId: other.id, spaceId: foreign.id, title: 'Foreign' })
  return {
    agentId: agent.id, docsId: docs.id, engId: eng.id, foreignId: foreign.id, foreignPageId: foreignPage.id,
    looseId: loose.id, organizationId: organization.id, outsiderId: outsider.id, ownerId: owner.id,
    privateId: privateSpace.id, projectId: project.id, restrictedId: restricted.id, secretId: secret.id,
    specId: spec.id, specsId: specs.id, techId: tech.id, scope,
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } })
    },
  }
}
type Seed = Awaited<ReturnType<typeof seed>>

const refusalsOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof TriggerConfigRefusalError, `expected a field-level refusal, got ${String(error)}`)
    return error.refusals.map(({ path, reason }) => `${path}: ${reason}`)
  }
  throw new Error('expected the trigger to be refused')
}

const create = (
  prisma: PrismaClient,
  s: Seed,
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  authorUserId: string | null = s.ownerId,
) => createAgentTrigger(prisma, s.agentId, {
  config: { instructions: INSTRUCTIONS, ...config },
  name: 'Review spec edits',
  targetChannelId: s.engId,
  type: 'document_changed',
  ...extra,
}, authorUserId ? { authorUserId } : {})

runDatabaseTest('a document trigger resolves its space on the server and stores it by id', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))

  // Nothing named: the project's Documents space.
  const plain = await create(prisma, s, {})
  assert.ok(plain)
  const plainRow = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: plain.id } })
  assert.equal(DocumentChangedStoredConfigSchema.parse(plainRow.config).spaceId, s.docsId)
  assert.equal(plainRow.scopeProjectId, s.projectId)
  assert.equal(plainRow.scopeBoardId, null)
  assert.equal(plainRow.targetThreadId, null, 'a document trigger has no fixed thread')

  // A folder implies its space.
  const folder = await create(prisma, s, { folderPageId: s.specsId, fireOn: 'publish', quietSeconds: 60 })
  assert.ok(folder)
  const stored = DocumentChangedStoredConfigSchema.parse(
    (await prisma.agentTrigger.findUniqueOrThrow({ where: { id: folder.id } })).config,
  )
  assert.equal(stored.spaceId, s.techId)
  assert.equal(stored.folderPageId, s.specsId)
  assert.equal(stored.fireOn, 'publish')
  assert.equal(stored.quietSeconds, 60)
  assert.deepEqual(stored.instructions, INSTRUCTIONS)
  assert.equal(folder.config?.['authorUserId'], undefined, 'authorship is recorded and never returned')

  // An edit names only what it changes; the space and folder resolve again as they were.
  const edited = await updateAgentTrigger(
    prisma,
    { organizationId: s.organizationId, triggerId: folder.id },
    { config: { labels: ['Spec'] } },
    { editor: { userId: s.ownerId } },
  )
  assert.ok(edited)
  const after = DocumentChangedStoredConfigSchema.parse(
    (await prisma.agentTrigger.findUniqueOrThrow({ where: { id: folder.id } })).config,
  )
  assert.deepEqual([after.spaceId, after.folderPageId, after.labels, after.fireOn], [s.techId, s.specsId, ['Spec'], 'publish'])
})

runDatabaseTest('every wrong field is refused on its own path, naming what is wrong', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))

  assert.match((await refusalsOf(create(prisma, s, {}, { targetChannelId: s.secretId })))[0]!,
    /^targetChannelId: #secret is protected\. A document trigger's channel must be public/)
  assert.match((await refusalsOf(create(prisma, s, { spaceId: s.foreignId })))[0]!,
    /^spaceId: space Foreign is in another project than #eng/)
  assert.match((await refusalsOf(create(prisma, s, { spaceId: s.privateId })))[0]!,
    /^spaceId: space Private notes is private, narrower than #eng/)
  assert.match((await refusalsOf(create(prisma, s, { spaceId: s.restrictedId })))[0]!,
    /^spaceId: space Payroll holds restricted documents/)
  assert.match((await refusalsOf(create(prisma, s, { folderPageId: s.specId })))[0]!,
    /^folderPageId: "Login spec" is a document, not a folder/)
  assert.deepEqual(await refusalsOf(create(prisma, s, { spaceId: s.techId, pageIds: [s.specId, s.foreignPageId] })),
    ['pageIds[1]: "Foreign" is not in space Tech docs'])
  assert.deepEqual(await refusalsOf(create(prisma, s, { spaceId: s.techId, kinds: ['file'], pageIds: [s.specId] })),
    ['pageIds[0]: "Login spec" is a document, and this trigger watches file pages'])
  assert.deepEqual((await refusalsOf(create(prisma, s, { instructions: undefined }))), [
    'instructions: give the agent standing instructions, at least {"general": "…"}',
  ])
  assert.deepEqual(await refusalsOf(create(prisma, s, {}, { targetThreadId: randomUUID(), nextRunAt: new Date().toISOString() })), [
    'targetThreadId: a document trigger opens one review thread per document in its channel; give targetChannelId only',
    'nextRunAt: a document trigger runs when a document changes, not on a schedule',
  ])
  // The person setting it up must be able to read the space: an owner outside the project cannot.
  assert.deepEqual(await refusalsOf(create(prisma, s, { spaceId: s.techId }, {}, s.outsiderId)), [
    'spaceId: you cannot read space Tech docs, so you cannot have an agent watch it',
  ])
  assert.match((await refusalsOf(create(prisma, s, {}, {}, null)))[0]!, /set up by a person/)
  assert.equal(await prisma.agentTrigger.count({ where: { agentId: s.agentId } }), 0, 'nothing refused was written')

  // A resume resolves the stored config as a create would: a space that went private is refused.
  const trigger = await create(prisma, s, { spaceId: s.techId })
  assert.ok(trigger)
  const row = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id }, include: { agent: true } })
  assert.equal(await documentTriggerResumeRefusal(prisma, row), null)
  await prisma.knowledgeSpace.update({ where: { id: s.techId }, data: { visibility: 'channel' } })
  assert.match(await documentTriggerResumeRefusal(prisma, row) ?? '', /^Edit this document trigger before resuming it — spaceId: space Tech docs is channel/)
})

const pendingJobs = (prisma: PrismaClient, triggerId: string) => prisma.$queryRaw<Array<{ key: string; delayed: boolean }>>(Prisma.sql`
  SELECT idempotency_key AS key, enqueued_at > now() + interval '30 seconds' AS delayed
    FROM queue_jobs
   WHERE topic = ${TRIGGER_DOCUMENT_DISPATCH_TOPIC} AND payload->>'triggerId' = ${triggerId}
`)

runDatabaseTest('a watched save opens one quiet window; everything else opens none', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => {
    await prisma.$executeRaw(Prisma.sql`DELETE FROM queue_jobs WHERE topic = ${TRIGGER_DOCUMENT_DISPATCH_TOPIC}
      AND payload->>'organizationId' = ${s.organizationId}`)
    await s.cleanup()
    await prisma.$disconnect()
  })
  const onSave = await create(prisma, s, { folderPageId: s.specsId })
  const onPublish = await create(prisma, s, { folderPageId: s.specsId, fireOn: 'publish' })
  const paused = await create(prisma, s, { folderPageId: s.specsId }, { enabled: false })
  assert.ok(onSave && onPublish && paused)
  const provider = createNativeKnowledgeProvider(prisma, {
    onVersionCreated: documentTriggerOnVersionCreated,
    onPagePublished: documentTriggerOnPagePublished,
  })

  await provider.updatePage(s.specId, { ...s.scope, body: '<p>Login v2</p>' })
  await provider.updatePage(s.specId, { ...s.scope, body: '<p>Login v3</p>' })
  const jobs = await pendingJobs(prisma, onSave.id)
  assert.deepEqual(jobs, [{ key: `doc:${onSave.id}:${s.specId}:pending`, delayed: true }],
    'two saves in the window are one job, delayed by the quiet window')
  assert.equal((await pendingJobs(prisma, onPublish.id)).length, 0, 'a publish trigger ignores saves')
  assert.equal((await pendingJobs(prisma, paused.id)).length, 0, 'a paused trigger ignores saves')

  // Outside the folder: nothing.
  await provider.updatePage(s.looseId, { ...s.scope, body: '<p>Other v2</p>' })
  assert.equal((await pendingJobs(prisma, onSave.id)).length, 1)

  // A publish opens the publish trigger's window.
  await provider.publishPage({ actorUserId: s.ownerId, organizationId: s.organizationId, pageId: s.specId })
  assert.deepEqual((await pendingJobs(prisma, onPublish.id)).map((job) => job.key), [`doc:${onPublish.id}:${s.specId}:pending`])
})
