import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import { nessieMcpTools } from '../src/mcp/server.js'
import { McpScopeError } from '../src/mcp/scopes.js'
import type { McpToolContext } from '../src/mcp/tool-context.js'

// "Agents draft; only a human may publish" is a rule this product enforces for
// its own agents. An MCP credential resolves as the human who approved it, so
// the rule survives only because publishing has its own scope — one a person
// ticks deliberately. These pin that: writing never implies publishing.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const tool = (name: string) => {
  const found = nessieMcpTools().find((candidate) => candidate.name === name)
  assert.ok(found, `${name} is not registered`)
  return found
}

type Seed = { organizationId: string; projectId: string; spaceId: string; userId: string }

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `pub ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
  const user = await prisma.user.create({
    data: { displayName: 'Author', email: `pub-${randomUUID()}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: org.id, role: 'owner', userId: user.id },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: user.id,
      name: 'Handbook',
      organizationId: org.id,
      projectId: project.id,
      visibility: 'organization',
    },
  })
  return { organizationId: org.id, projectId: project.id, spaceId: space.id, userId: user.id }
}

const contextFor = (
  prisma: PrismaClient,
  s: Seed,
  scopes: McpToolContext['scopes'],
): McpToolContext => ({
  actorContext: AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: s.userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: s.organizationId, projectId: s.projectId },
  }),
  authSecret: 'test-secret',
  checkPolicy: async () => ({ allowed: true, reasonCode: 'ALLOWED' }),
  getTask: async () => null,
  isProjectAccessibleToActor: async () => true,
  knowledge: {
    buildViewer: async () => ({
      bypass: true,
      userId: s.userId,
      visibleAgentIds: new Set<string>(),
    }) as never,
    provider: createNativeKnowledgeProvider(prisma, {}),
  },
  prisma,
  scopes,
})

test('publishing is not implied by writing', () => {
  const publish = tool('nessie_doc_publish')
  assert.rejects(
    () => publish.run({ scopes: ['documents_read', 'documents_write'] } as never, {}),
    McpScopeError,
  )
})

runDatabaseTest('a write-scoped agent cannot publish its own draft', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const writer = contextFor(prisma, s, ['documents_read', 'documents_write'])
    const created = await tool('nessie_doc_create').run(writer, {
      spaceId: s.spaceId,
      title: 'Draft',
    }) as { page: { id: string; status: string } }
    assert.equal(created.page.status, 'draft')

    const refused = await tool('nessie_doc_publish').run(writer, {
      pageId: created.page.id,
    }).catch((error: unknown) => error)
    assert.ok(refused instanceof McpScopeError)
    assert.equal(refused.required, 'documents_publish')

    const stored = await prisma.knowledgePage.findUniqueOrThrow({
      select: { status: true },
      where: { id: created.page.id },
    })
    assert.equal(stored.status, 'draft', 'the draft must still be a draft')
  } finally {
    await prisma.organization.delete({ where: { id: s.organizationId } })
    await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
    await prisma.$disconnect()
  }
})

runDatabaseTest('with the scope granted, publishing works', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const writer = contextFor(prisma, s, ['documents_read', 'documents_write'])
    const created = await tool('nessie_doc_create').run(writer, {
      spaceId: s.spaceId,
      title: 'Ready',
    }) as { page: { id: string } }

    const publisher = contextFor(prisma, s, [
      'documents_read',
      'documents_write',
      'documents_publish',
    ])
    const published = await tool('nessie_doc_publish').run(publisher, {
      pageId: created.page.id,
    }) as { error?: string; page?: { status: string } }

    assert.equal(published.error, undefined, `publish failed: ${published.error}`)
    assert.equal(published.page?.status, 'published')
  } finally {
    await prisma.organization.delete({ where: { id: s.organizationId } })
    await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
    await prisma.$disconnect()
  }
})

runDatabaseTest('publishing is refused when the policy engine says so', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const writer = contextFor(prisma, s, ['documents_read', 'documents_write'])
    const created = await tool('nessie_doc_create').run(writer, {
      spaceId: s.spaceId,
      title: 'Gated',
    }) as { page: { id: string } }

    // The scope says the person allowed this agent to publish; the policy
    // engine still decides whether that person may publish at all.
    const denied: McpToolContext = {
      ...contextFor(prisma, s, ['documents_read', 'documents_write', 'documents_publish']),
      checkPolicy: async () => ({ allowed: false, reasonCode: 'NO_MATCHING_ALLOW' }),
    }
    const refused = await tool('nessie_doc_publish').run(denied, {
      pageId: created.page.id,
    }) as { error?: string }
    assert.match(String(refused.error), /denied/i)

    const stored = await prisma.knowledgePage.findUniqueOrThrow({
      select: { status: true },
      where: { id: created.page.id },
    })
    assert.equal(stored.status, 'draft')
  } finally {
    await prisma.organization.delete({ where: { id: s.organizationId } })
    await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
    await prisma.$disconnect()
  }
})
