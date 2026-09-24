import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'

import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { executeBuiltinTool } from '../../src/run/tools.js'
import { runDatabaseTest } from './support.js'
import { seedTicketWork, type TicketWorkSeed } from './ticket-work-fixture.js'

// `kb_page_diff` against Postgres (docs/standards/document-triggers.md →
// "Reading the change"): `kb_page_read`'s gates for the page and for each
// version, both versions recorded in the run's consumed-source sink before a
// word of either reaches the model, and hunks bounded at 12 000 characters.

/** An unattended run of the seed's agent in its channel: the agent reads with its own reach. */
const agentContext = (prisma: PrismaClient, s: TicketWorkSeed): BuiltinToolRuntimeContext => ({
  actorContext: {
    actor: { actorId: s.agentId, actorType: 'agent', roles: ['system'] },
    actionContext: { purpose: 'document_changed', requestId: randomUUID() },
    tenant: { organizationId: s.organizationId },
  },
  agentId: s.agentId,
  agentKind: 'shared',
  channel: { id: s.channelId, organizationId: s.organizationId, projectId: s.projectId },
  consumedSources: createConsumedSourceSink(),
  ledgerIdentity: null,
  prisma,
  realtimeTransport: { publishWs: async () => undefined },
  run: { id: randomUUID(), interactive: false, messageId: randomUUID(), threadId: randomUUID() },
  toolCallId: randomUUID(),
} as unknown as BuiltinToolRuntimeContext)

const seedPages = async (prisma: PrismaClient, s: TicketWorkSeed) => {
  const space = await prisma.knowledgeSpace.create({
    data: { createdBy: s.editorId, name: 'Tech docs', organizationId: s.organizationId, projectId: s.projectId, visibility: 'project' },
  })
  const provider = createNativeKnowledgeProvider(prisma)
  const scope = {
    authorId: s.editorId, authorType: 'user' as const, createdBy: s.editorId,
    organizationId: s.organizationId, projectId: s.projectId, spaceId: space.id,
  }
  return { space, provider, scope }
}

const versions = async (prisma: PrismaClient, pageId: string) =>
  (await prisma.knowledgePageVersion.findMany({ where: { pageId }, orderBy: { versionNumber: 'asc' }, select: { id: true } }))
    .map((version) => version.id)

runDatabaseTest('kb_page_diff shows the change as hunks and records both versions it read', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { provider, scope } = await seedPages(prisma, s)
  // Each version carries a basis of its own, which the agent passes (its own
  // channel, its organisation): reading the diff must record both.
  const page = await provider.createPage({
    ...scope, title: 'Login spec',
    body: '<p>Keep the redirect target.</p><p>Use the session cookie.</p><p>Log the outcome.</p>',
    basisScopes: [{ scopeType: 'channel', scopeId: s.channelId }],
  })
  await provider.updatePage(page.id, {
    ...scope,
    body: '<p>Keep the redirect target.</p><p>Use a signed token.</p><p>Log the outcome.</p>',
    basisScopes: [{ scopeType: 'organization', scopeId: s.organizationId }],
  })
  const [v1, v2] = await versions(prisma, page.id)
  const context = agentContext(prisma, s)
  const result = await executeBuiltinTool('kb_page_diff', { pageId: page.id, fromVersionId: v1, toVersionId: v2 }, context)
  assert.equal(result.success, true, result.output)
  assert.match(result.output, /from versionId=.* versionNumber=1 \(saved by a person\)/)
  assert.match(result.output, /1 lines added, 1 removed/)
  assert.match(result.output, /\n-Use the session cookie\.\n\+Use a signed token\./)
  assert.match(result.output, /\n Keep the redirect target\./, 'unchanged lines are context')
  const recorded = context.consumedSources!.list().map((scope) => `${scope.scopeType}:${scope.scopeId}`).sort()
  assert.ok(recorded.includes(`channel:${s.channelId}`), 'the older version\'s basis is recorded')
  assert.ok(recorded.includes(`organization:${s.organizationId}`), 'the newer version\'s basis is recorded')
})

runDatabaseTest('kb_page_diff refuses what kb_page_read refuses, for the page and for each version', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { provider, scope } = await seedPages(prisma, s)
  const page = await provider.createPage({ ...scope, title: 'Spec', body: '<p>One.</p>' })
  await provider.updatePage(page.id, { ...scope, body: '<p>Two.</p>' })
  const [v1, v2] = await versions(prisma, page.id)
  const other = await provider.createPage({ ...scope, title: 'Other', body: '<p>Other.</p>' })
  const [otherVersion] = await versions(prisma, other.id)
  const diff = (args: Record<string, unknown>) => executeBuiltinTool('kb_page_diff', args, agentContext(prisma, s))

  // A version of another page is not this page's.
  assert.match((await diff({ pageId: page.id, fromVersionId: otherVersion, toVersionId: v2 })).output,
    /Knowledge page version not found/)

  // A version whose own basis the agent does not pass — a channel it is not in — is refused, never diffed around.
  const privateChannel = await prisma.channel.create({
    data: {
      label: 'secret', slug: `secret-${randomUUID()}`, visibility: 'protected',
      organization: { connect: { id: s.organizationId } }, project: { connect: { id: s.projectId } },
      team: { connect: { id: s.teamId } },
    },
  })
  await provider.updatePage(page.id, {
    ...scope, body: '<p>Three, from a private room.</p>',
    basisScopes: [{ scopeType: 'channel', scopeId: privateChannel.id }],
  })
  const [, , v3] = await versions(prisma, page.id)
  const context = agentContext(prisma, s)
  const refused = await executeBuiltinTool('kb_page_diff', { pageId: page.id, fromVersionId: v1, toVersionId: v3 }, context)
  assert.match(refused.output, /You do not have access to this knowledge page\./)
  assert.doesNotMatch(refused.output, /private room/)
  assert.equal(context.consumedSources!.size(), 0, 'nothing is recorded for a refused read')

  // A restricted page is people-only, even in a space the agent reads.
  await prisma.knowledgePage.update({ where: { id: page.id }, data: { sensitivityTier: 'restricted' } })
  assert.match((await diff({ pageId: page.id, fromVersionId: v1, toVersionId: v2 })).output,
    /You do not have access to this knowledge page\./)
})

runDatabaseTest('kb_page_diff cuts a long change at 12 000 characters and says where the rest is', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTicketWork(prisma)
  t.after(async () => { await s.cleanup(); await prisma.$disconnect() })
  const { provider, scope } = await seedPages(prisma, s)
  const body = (word: string) => Array.from({ length: 600 }, (_, index) => `<p>Line ${index} ${word}</p>`).join('')
  const page = await provider.createPage({ ...scope, title: 'Long', body: body('before') })
  await provider.updatePage(page.id, { ...scope, body: body('after') })
  const [v1, v2] = await versions(prisma, page.id)
  const result = await executeBuiltinTool('kb_page_diff', { pageId: page.id, fromVersionId: v1, toVersionId: v2 }, agentContext(prisma, s))
  assert.match(result.output, /600 lines added, 600 removed/)
  assert.match(result.output, new RegExp(`it was cut at 12000 characters\\. Read the rest of the new version with kb_page_read\\(pageId="${page.id}", versionId="${v2}"\\)`))
  const hunks = result.output.slice(result.output.indexOf('@@'))
  assert.ok(hunks.length <= 12_000, `the hunks are ${hunks.length} characters`)
})
