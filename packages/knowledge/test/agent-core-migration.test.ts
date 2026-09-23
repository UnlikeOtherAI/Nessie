import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createNativeKnowledgeProvider } from '../src/native-provider.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('a stale two-file core update commits neither required file', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `agent-core-cas-${suffix}` },
  })
  t.after(async () => {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.$disconnect()
  })
  const project = await prisma.project.create({
    data: { name: `agent-core-project-${suffix}`, organizationId: organization.id },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `Core agent ${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
    },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: agent.id,
      metadata: { agentDocs: true },
      name: `${agent.name} — Documents`,
      organizationId: organization.id,
      ownerAgentId: agent.id,
      projectId: project.id,
      visibility: 'private',
    },
  })

  const initialVersions = new Map<'identity' | 'working_rules', string>()
  for (const [role, filename] of [
    ['identity', 'AGENTS.md'],
    ['working_rules', 'personality.md'],
  ] as const) {
    const attachment = await prisma.attachment.create({
      data: {
        filename,
        kind: 'file',
        mime: 'text/markdown; charset=utf-8',
        organizationId: organization.id,
        sizeBytes: 7n,
        storageKey: `agent-core-test/${randomUUID()}`,
      },
    })
    const page = await prisma.knowledgePage.create({
      data: {
        createdBy: agent.id,
        documentRole: role,
        kind: 'file',
        organizationId: organization.id,
        projectId: project.id,
        sensitivityTier: space.sensitivityTier,
        spaceId: space.id,
        status: 'published',
        title: filename,
        visibility: space.visibility,
      },
    })
    const version = await prisma.knowledgePageVersion.create({
      data: {
        attachmentId: attachment.id,
        authorId: agent.id,
        authorType: 'agent',
        body: `<p>${role}</p>`,
        pageId: page.id,
        sourceContentHash: randomUUID().replaceAll('-', ''),
        versionNumber: 1,
      },
    })
    await prisma.knowledgePage.update({
      where: { id: page.id },
      data: { publishedVersionId: version.id },
    })
    await prisma.agentCoreDocument.create({
      data: { agentId: agent.id, pageId: page.id, role },
    })
    initialVersions.set(role, version.id)
  }
  await prisma.agentCoreDocumentMigration.create({
    data: {
      agentId: agent.id,
      documentCount: 2,
      organizationId: organization.id,
      sourceHash: randomUUID().replaceAll('-', ''),
    },
  })

  const draftText = new Map<string, string>()
  const drafts = []
  for (const [role, filename] of [
    ['identity', 'AGENTS.md'],
    ['working_rules', 'personality.md'],
  ] as const) {
    const attachment = await prisma.attachment.create({
      data: {
        filename,
        kind: 'file',
        mime: 'text/markdown; charset=utf-8',
        organizationId: organization.id,
        sizeBytes: 12n,
        storageKey: `agent-core-test/${randomUUID()}`,
      },
    })
    draftText.set(attachment.id, `${filename} replacement`)
    drafts.push({
      attachmentId: attachment.id,
      expectedPublishedVersionId: role === 'identity'
        ? initialVersions.get(role)
        : randomUUID(),
      role,
    })
  }
  const provider = createNativeKnowledgeProvider(prisma, {
    readMarkdownAttachment: async (attachmentId) => {
      const body = draftText.get(attachmentId)
      return body === undefined ? null : Readable.from([Buffer.from(body)])
    },
  })
  assert.ok(provider.updateAgentCoreDocuments)

  const result = await provider.updateAgentCoreDocuments({
    agentId: agent.id,
    authorId: randomUUID(),
    authorType: 'user',
    drafts,
    organizationId: organization.id,
    projectId: project.id,
    spaceId: space.id,
  })

  assert.deepEqual(result, { kind: 'stale' })
  assert.equal(
    await prisma.knowledgePageVersion.count({
      where: { page: { spaceId: space.id } },
    }),
    2,
    'preflight must reject the stale pair before appending either version',
  )
  const published = await prisma.agentCoreDocument.findMany({
    where: { agentId: agent.id },
    select: { role: true, page: { select: { publishedVersionId: true } } },
  })
  assert.deepEqual(
    new Map(published.map((entry) => [entry.role, entry.page.publishedVersionId])),
    initialVersions,
  )
})
