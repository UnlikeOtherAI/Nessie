import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import { resolveApprovalRequest } from '../src/services/approvals.js'
import { nessieMcpTools } from '../src/mcp/server.js'
import type { McpToolContext } from '../src/mcp/tool-context.js'

// "Agents draft; only a human may publish" is a rule this product enforces for
// its own agents by refusing an agent actor outright. A paired MCP credential
// resolves as the *human* who approved it, so that refusal cannot catch it —
// the rule would be walked past by exactly the caller it was written for.
//
// It used to be answered with a `documents_publish` scope, ticked once at
// pairing time. These pin the answer that replaced it: publishing opens an
// approval, the draft stays a draft until a person says otherwise, and the one
// person allowed to say so is the one whose account the credential borrows.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const tool = (name: string) => {
  const found = nessieMcpTools().find((candidate) => candidate.name === name)
  assert.ok(found, `${name} is not registered`)
  return found
}

type Seed = {
  credentialId: string
  organizationId: string
  projectId: string
  spaceId: string
  userId: string
}

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
  // A real credential row: the approval carries an FK to it, so a fake id would
  // fail at the write rather than at the assertion that matters.
  const credential = await prisma.agentAccessCredential.create({
    data: {
      expiresAt: new Date(Date.now() + 86_400_000),
      label: 'Claude Code',
      organizationId: org.id,
      projectId: project.id,
      scopes: ['documents_read', 'documents_write'],
      tokenHash: randomUUID(),
      tokenPrefix: 'nag1_test',
      tokenVersion: 0,
      userId: user.id,
    },
  })
  return {
    credentialId: credential.id,
    organizationId: org.id,
    projectId: project.id,
    spaceId: space.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed) => {
  await prisma.organization.delete({ where: { id: s.organizationId } })
  await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
  await prisma.$disconnect()
}

const contextFor = (prisma: PrismaClient, s: Seed): McpToolContext => ({
  actorContext: AuthorizedActionContextSchema.parse({
    // The credential marker is what the verifier puts here on a real call, and
    // it is what the tool pins the approval to.
    actionContext: { agentCredentialId: s.credentialId, requestId: randomUUID() },
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
  scopes: ['documents_read', 'documents_write'],
})

runDatabaseTest('publishing opens an approval and leaves the draft a draft', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_doc_create').run(context, {
      spaceId: s.spaceId,
      title: 'Draft',
    }) as { page: { id: string; status: string } }
    assert.equal(created.page.status, 'draft')

    const asked = await tool('nessie_doc_publish').run(context, {
      pageId: created.page.id,
    }) as { approvalId?: string; error?: string; status?: string }

    assert.equal(asked.error, undefined, `publish request failed: ${asked.error}`)
    assert.equal(asked.status, 'awaiting_approval')
    assert.ok(asked.approvalId, 'an approval id must come back for the agent to report')

    const stored = await prisma.knowledgePage.findUniqueOrThrow({
      select: { status: true },
      where: { id: created.page.id },
    })
    assert.equal(stored.status, 'draft', 'nothing may be published without a person')

    const approval = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: asked.approvalId as string },
    })
    assert.equal(approval.action, 'knowledge.page.publish')
    assert.equal(approval.status, 'pending')
    // The two halves of the one-of, and the pin.
    assert.equal(approval.agentId, null, 'a credential request has no Agent row')
    assert.equal(approval.agentAccessCredentialId, s.credentialId)
    assert.equal(
      approval.requiredApproverUserId,
      s.userId,
      'only the person whose account was borrowed may answer',
    )
    // Never the human: `resolveApprovalRequest` refuses a requester who answers
    // their own request, so naming them here would make the one person allowed
    // to decide the one person who cannot.
    assert.equal(approval.requesterId, s.credentialId)
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('asking twice for the same draft returns the request already open', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_doc_create').run(context, {
      spaceId: s.spaceId,
      title: 'Polled',
    }) as { page: { id: string } }

    const first = await tool('nessie_doc_publish').run(context, {
      pageId: created.page.id,
    }) as { approvalId?: string }
    const second = await tool('nessie_doc_publish').run(context, {
      pageId: created.page.id,
    }) as { approvalId?: string }

    assert.equal(second.approvalId, first.approvalId, 'a polling agent must not stack requests')
    const count = await prisma.approvalRequest.count({
      where: { action: 'knowledge.page.publish', organizationId: s.organizationId },
    })
    assert.equal(count, 1, 'exactly one approval for one draft')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('the borrowed account can approve, and that publishes', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_doc_create').run(context, {
      spaceId: s.spaceId,
      title: 'Ready',
    }) as { page: { id: string } }
    const asked = await tool('nessie_doc_publish').run(context, {
      pageId: created.page.id,
    }) as { approvalId: string }

    // The subtle half of the design. This person is the actor the credential
    // acts as, so if the approval had named *them* as requester the self-
    // approval guard would refuse here and the draft could never be published
    // by the only person entitled to publish it.
    const resolved = await resolveApprovalRequest(
      prisma,
      asked.approvalId,
      AuthorizedActionContextSchema.parse({
        actionContext: { requestId: randomUUID() },
        actor: { actorId: s.userId, actorType: 'user', roles: ['owner'] },
        tenant: { organizationId: s.organizationId, projectId: s.projectId },
      }),
      'approved',
    )
    assert.ok(resolved && !('error' in resolved && resolved.error), 'the owner must be able to approve')

    const stored = await prisma.knowledgePage.findUniqueOrThrow({
      select: { status: true },
      where: { id: created.page.id },
    })
    assert.equal(stored.status, 'published')
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('a policy refusal stops the request being opened at all', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_doc_create').run(context, {
      spaceId: s.spaceId,
      title: 'Gated',
    }) as { page: { id: string } }

    // The approval answers "did a person decide to publish this". It is not a
    // way around "may this account publish here at all", which the policy
    // engine still owns.
    const denied: McpToolContext = {
      ...context,
      checkPolicy: async () => ({ allowed: false, reasonCode: 'NO_MATCHING_ALLOW' }),
    }
    const refused = await tool('nessie_doc_publish').run(denied, {
      pageId: created.page.id,
    }) as { error?: string }
    assert.match(String(refused.error), /denied/i)

    const count = await prisma.approvalRequest.count({
      where: { action: 'knowledge.page.publish', organizationId: s.organizationId },
    })
    assert.equal(count, 0, 'a denied caller must not be able to fill an Approvals page')
  } finally {
    await cleanup(prisma, s)
  }
})
