import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import { nessieMcpTools } from '../src/mcp/server.js'
import type { McpToolContext } from '../src/mcp/tool-context.js'

// Document writes, against a real database and the real provider.
//
// The properties worth pinning are the ones a tool could easily get wrong on
// its own: a write refused for a space the account cannot write, a draft that
// stays a draft, and a stale edit that is refused rather than silently taking
// the last write.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const tool = (name: string) => {
  const found = nessieMcpTools().find((candidate) => candidate.name === name)
  assert.ok(found, `${name} is not registered`)
  return found
}

type Seed = {
  organizationId: string
  projectId: string
  spaceId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `dw ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Author', email: `dw-${randomUUID()}@example.test` },
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
  return {
    organizationId: org.id,
    projectId: project.id,
    spaceId: space.id,
    userId: user.id,
  }
}

const contextFor = (
  prisma: PrismaClient,
  s: Seed,
  overrides: Partial<McpToolContext> = {},
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
    // A viewer that can reach everything in this org, which is what an owner
    // is; the point of these tests is the tool's behaviour, not the predicate,
    // which has its own coverage.
    buildViewer: async () => ({
      bypass: true,
      userId: s.userId,
      visibleAgentIds: new Set<string>(),
    }) as never,
    provider: createNativeKnowledgeProvider(prisma, {}),
  },
  prisma,
  scopes: ['documents_read', 'documents_write'],
  ...overrides,
})

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.organization.delete({ where: { id: s.organizationId } })
  await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
}

runDatabaseTest('an agent can create a document and read it back', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_doc_create').run(context, {
      body: '# Onboarding\n\nStart here.',
      spaceId: s.spaceId,
      title: 'Onboarding',
    }) as { error?: string; page?: { id: string; status: string } }

    assert.equal(created.error, undefined, `create failed: ${created.error}`)
    assert.ok(created.page)
    // Created as a draft: publication is a human act and no tool offers it.
    assert.equal(created.page.status, 'draft')

    const read = await tool('nessie_doc_get').run(context, {
      pageId: created.page.id,
    }) as { page?: { title: string } }
    assert.equal(read.page?.title, 'Onboarding')
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an agent can update a document it can reach', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_doc_create').run(context, {
      spaceId: s.spaceId,
      title: 'Before',
    }) as { page: { id: string } }

    const updated = await tool('nessie_doc_update').run(context, {
      pageId: created.page.id,
      title: 'After',
    }) as { error?: string; page?: { title: string } }

    assert.equal(updated.error, undefined, `update failed: ${updated.error}`)
    assert.equal(updated.page?.title, 'After')
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a stale edit is refused rather than taking the last write', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_doc_create').run(context, {
      spaceId: s.spaceId,
      title: 'Shared doc',
    }) as { page: { id: string; revision: number } }

    // Somebody else edits it while the agent is thinking.
    await tool('nessie_doc_update').run(context, {
      pageId: created.page.id,
      title: 'Changed by a colleague',
    })

    // The agent then writes against the revision it read.
    const stale = await tool('nessie_doc_update').run(context, {
      expectedRevision: created.page.revision,
      pageId: created.page.id,
      title: 'Based on stale reading',
    }) as { error?: string; retryable?: boolean }

    assert.match(String(stale.error), /changed since you read it/i)
    assert.equal(stale.retryable, true, 'the agent should re-read and re-apply')

    const stored = await prisma.knowledgePage.findUnique({
      select: { title: true },
      where: { id: created.page.id },
    })
    assert.equal(
      stored?.title,
      'Changed by a colleague',
      'the colleague\'s edit must survive the stale write',
    )
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a policy denial refuses the write', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const denied = contextFor(prisma, s, {
      checkPolicy: async () => ({ allowed: false, reasonCode: 'POLICY_DENIED' }),
    })
    const result = await tool('nessie_doc_create').run(denied, {
      spaceId: s.spaceId,
      title: 'Should not exist',
    }) as { error?: string }

    assert.match(String(result.error), /denied/i)
    const count = await prisma.knowledgePage.count({ where: { spaceId: s.spaceId } })
    assert.equal(count, 0, 'a denied policy must not have written anything')
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a document in a space the viewer cannot write is refused', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    // A private, write-restricted space with no members — the shape where the
    // predicate genuinely refuses. An organization-visible space would not:
    // that is writable by the organisation on purpose, and `writeRestricted`
    // is the switch that narrows it.
    const restricted = await prisma.knowledgeSpace.create({
      data: {
        createdBy: randomUUID(),
        name: 'Restricted',
        organizationId: s.organizationId,
        projectId: s.projectId,
        visibility: 'private',
        writeRestricted: true,
      },
    })

    const owner = contextFor(prisma, s)
    const created = await tool('nessie_doc_create').run(owner, {
      spaceId: restricted.id,
      title: 'Private note',
    }) as { page: { id: string } }

    const outsider = contextFor(prisma, s, {
      knowledge: {
        buildViewer: async () => ({
          bypass: false,
          memberSpaceIds: new Set<string>(),
          projectIds: new Set<string>(),
          userId: randomUUID(),
          visibleAgentIds: new Set<string>(),
        }) as never,
        provider: createNativeKnowledgeProvider(prisma, {}),
      },
    })

    const refused = await tool('nessie_doc_update').run(outsider, {
      pageId: created.page.id,
      title: 'Should not land',
    }) as { error?: string }
    assert.match(String(refused.error), /not found|cannot use/i)

    const stored = await prisma.knowledgePage.findUnique({
      select: { title: true },
      where: { id: created.page.id },
    })
    assert.equal(stored?.title, 'Private note')
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})
