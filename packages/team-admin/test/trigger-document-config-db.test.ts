import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'

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

// The author's read is asked of their live entitlement, and these fixtures are
// an unbound local install. Other files configure UOA at module scope under
// test-isolation=none, so each test scopes and restores the deployment mode.
const localIdentity = (t: TestContext): void => {
  for (const key of ['UOA_DOMAIN', 'UOA_CONFIG_URL']) {
    const previous = process.env[key]
    delete process.env[key]
    t.after(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
  }
}

const INSTRUCTIONS = { general: 'Review the edit, and say on the thread what changed.' }

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const user = (name: string) => prisma.user.create({ data: { displayName: name, email: `doc-config-${name}-${suffix}@example.test` } })
  const owner = await user('owner')
  const outsider = await user('outsider')
  const stranger = await user('stranger')
  const organization = await prisma.organization.create({ data: { name: `doc-config-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'owner', userId: outsider.id },
      { organizationId: organization.id, role: 'member', userId: stranger.id },
    ],
  })
  const project = await prisma.project.create({ data: { name: 'Nessie', organizationId: organization.id } })
  const other = await prisma.project.create({ data: { name: 'Elsewhere', organizationId: organization.id } })
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, userId: owner.id },
      { projectId: other.id, userId: owner.id },
      { projectId: project.id, userId: stranger.id },
    ],
  })
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
  const docsPage = await provider.createPage({ ...scope, body: '<p>D</p>', spaceId: docs.id, title: 'Docs page' })
  // Another person's private space in the same project: the owner may not
  // read it, so no refusal may say a word about it.
  const strangers = await prisma.knowledgeSpace.create({
    data: {
      createdBy: stranger.id, name: 'Stranger salary notes', organizationId: organization.id,
      projectId: project.id, visibility: 'private',
    },
    select: { id: true },
  })
  const strangerScope = { ...scope, authorId: stranger.id, createdBy: stranger.id, spaceId: strangers.id }
  const strangerFolder = await provider.createPage({ ...strangerScope, kind: 'folder', title: 'Stranger salary folder' })
  const strangerPage = await provider.createPage({ ...strangerScope, body: '<p>S</p>', title: 'Stranger salary review' })
  return {
    agentId: agent.id, docsId: docs.id, docsPageId: docsPage.id, engId: eng.id, foreignId: foreign.id,
    foreignPageId: foreignPage.id, looseId: loose.id, organizationId: organization.id, outsiderId: outsider.id,
    ownerId: owner.id, privateId: privateSpace.id, projectId: project.id, restrictedId: restricted.id,
    secretId: secret.id, specId: spec.id, specsId: specs.id, strangerFolderId: strangerFolder.id,
    strangerPageId: strangerPage.id, strangerSpaceId: strangers.id, techId: tech.id, scope,
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, outsider.id, stranger.id] } } })
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
  localIdentity(t)
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
  localIdentity(t)
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))

  assert.match((await refusalsOf(create(prisma, s, {}, { targetChannelId: s.secretId })))[0]!,
    /^targetChannelId: #secret is protected\. A document trigger's channel must be public/)
  assert.match((await refusalsOf(create(prisma, s, { spaceId: s.foreignId })))[0]!,
    /^spaceId: this space is in another project than #eng \(project Nessie\)/)
  assert.match((await refusalsOf(create(prisma, s, { spaceId: s.privateId })))[0]!,
    /^spaceId: this space is private, narrower than #eng/)
  assert.match((await refusalsOf(create(prisma, s, { spaceId: s.restrictedId })))[0]!,
    /^spaceId: this space holds restricted documents/)
  assert.deepEqual(await refusalsOf(create(prisma, s, { folderPageId: s.specId })),
    ['folderPageId: that page is a document, not a folder'])
  assert.deepEqual(await refusalsOf(create(prisma, s, { spaceId: s.techId, pageIds: [s.specId, s.docsPageId] })),
    ['pageIds[1]: that document is not in the space this trigger watches'])
  // A page of another project the owner reads and the agent does not: the agent is named, the page is not.
  assert.deepEqual(await refusalsOf(create(prisma, s, { spaceId: s.techId, pageIds: [s.foreignPageId] })), [
    'pageIds[0]: CTO cannot read this document\'s space; bind it to a channel of the project, or share the space with it',
  ])
  assert.deepEqual(await refusalsOf(create(prisma, s, { spaceId: s.techId, kinds: ['file'], pageIds: [s.specId] })),
    ['pageIds[0]: that page is a document, and this trigger watches file pages'])

  // What the person may not read, they are not told of: another person's
  // private space, its folder and its page are each "no such …", and nothing
  // refused ever carries a title or a space's name.
  const hidden = [
    ...await refusalsOf(create(prisma, s, { spaceId: s.strangerSpaceId })),
    ...await refusalsOf(create(prisma, s, { folderPageId: s.strangerFolderId })),
    ...await refusalsOf(create(prisma, s, { spaceId: s.techId, pageIds: [s.strangerPageId] })),
  ]
  assert.deepEqual(hidden, [
    'spaceId: no such document space in this organisation',
    'folderPageId: no such folder',
    'pageIds[0]: no such document',
  ])
  const everyRefusal = [
    ...hidden,
    ...await refusalsOf(create(prisma, s, { spaceId: s.privateId })),
    ...await refusalsOf(create(prisma, s, { spaceId: s.foreignId })),
    ...await refusalsOf(create(prisma, s, { folderPageId: s.specId })),
  ].join('\n')
  assert.doesNotMatch(everyRefusal, /Stranger|salary|Private notes|Foreign|Login spec|Tech docs/)
  assert.deepEqual((await refusalsOf(create(prisma, s, { instructions: undefined }))), [
    'instructions: give the agent standing instructions, at least {"general": "…"}',
  ])
  assert.deepEqual(await refusalsOf(create(prisma, s, {}, { targetThreadId: randomUUID(), nextRunAt: new Date().toISOString() })), [
    'targetThreadId: a document trigger opens one review thread per document in its channel; give targetChannelId only',
    'nextRunAt: a document trigger runs when a document changes, not on a schedule',
  ])
  // The person setting it up must be able to read the space: an owner outside
  // the project cannot, and is told of no space at all.
  assert.deepEqual(await refusalsOf(create(prisma, s, { spaceId: s.techId }, {}, s.outsiderId)), [
    'spaceId: no such document space in this organisation',
  ])
  assert.deepEqual(await refusalsOf(create(prisma, s, {}, {}, s.outsiderId)), [
    'spaceId: project Nessie has no Documents space you can read; name the space to watch',
  ])
  assert.match((await refusalsOf(create(prisma, s, {}, {}, null)))[0]!, /set up, changed and resumed by a person/)
  assert.equal(await prisma.agentTrigger.count({ where: { agentId: s.agentId } }), 0, 'nothing refused was written')

  // An edit of what it watches, with no person behind it, is refused; a rename is not.
  const trigger = await create(prisma, s, { spaceId: s.techId })
  assert.ok(trigger)
  const scope = { organizationId: s.organizationId, triggerId: trigger.id }
  assert.match((await refusalsOf(updateAgentTrigger(prisma, scope, { config: { labels: ['Spec'] } })))[0]!,
    /^config: a document trigger is set up, changed and resumed by a person/)
  assert.equal((await updateAgentTrigger(prisma, scope, { name: 'Renamed' }))?.name, 'Renamed')
  // An editor who cannot read the space it would now watch is told of no space.
  assert.deepEqual(
    await refusalsOf(updateAgentTrigger(prisma, scope, { config: { spaceId: s.strangerSpaceId } }, {
      editor: { userId: s.ownerId },
    })),
    ['spaceId: no such document space in this organisation'],
  )

  // A resume resolves the stored config as a create would, asking the person
  // resuming it: with nobody behind it, by someone who cannot read the space,
  // or once the space went narrower than the channel, it is refused.
  const row = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id }, include: { agent: true } })
  assert.equal(await documentTriggerResumeRefusal(prisma, row, { userId: s.ownerId }), null)
  assert.match(await documentTriggerResumeRefusal(prisma, row, null) ?? '', /cannot be resumed here: a document trigger/)
  assert.match(await documentTriggerResumeRefusal(prisma, row, { userId: s.outsiderId }) ?? '',
    /^Edit this document trigger before resuming it — spaceId: no such document space in this organisation\.$/)
  await prisma.knowledgeSpace.update({ where: { id: s.techId }, data: { visibility: 'channel' } })
  assert.match(await documentTriggerResumeRefusal(prisma, row, { userId: s.ownerId }) ?? '',
    /^Edit this document trigger before resuming it — spaceId: this space is channel, narrower than #eng/)
})

const pendingJobs = (prisma: PrismaClient, triggerId: string) => prisma.$queryRaw<Array<{ key: string; delayed: boolean }>>(Prisma.sql`
  SELECT idempotency_key AS key, enqueued_at > now() + interval '30 seconds' AS delayed
    FROM queue_jobs
   WHERE topic = ${TRIGGER_DOCUMENT_DISPATCH_TOPIC} AND payload->>'triggerId' = ${triggerId}
`)

runDatabaseTest('a watched save opens one quiet window; everything else opens none', async (t) => {
  localIdentity(t)
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
