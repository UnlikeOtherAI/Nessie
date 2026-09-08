import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const migrationSql = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260911110001_knowledge_page_version_disclosure_basis/migration.sql',
), 'utf8')

test('repairs only a provable agent version-to-run origin and keeps unknown private authors closed', () => {
  assert.match(migrationSql, /j\.topic = 'knowledge\.embed'/)
  assert.match(migrationSql, /j\.payload ->> 'versionId' = v\.id::text/)
  assert.match(migrationSql, /r\.agent_id::text = v\.author_id/)
  assert.match(migrationSql, /JOIN threads run_thread/)
  assert.match(migrationSql, /run_channel\.organization_id = p\.organization_id/)
  assert.match(migrationSql, /v\.author_type = 'agent'::"KnowledgeAuthorType"/)
  assert.match(migrationSql, /JOIN run_basis_scopes basis/)
  assert.match(migrationSql, /JOIN run_checkpoint_disclosure_sources source/)
  assert.match(migrationSql, /source_channel\.visibility = 'private'::"ChannelVisibility"/)
  assert.match(migrationSql, /basis\.scope_id, NULL, now\(\)/)
  assert.match(migrationSql, /ON CONFLICT \(version_id, source_channel_id, source_author_user_id\) DO NOTHING/)
  assert.match(migrationSql, /collapse_knowledge_version_unknown_source_author/)
  assert.doesNotMatch(migrationSql, /JOIN organization_members/)
})

runDatabaseTest('deleting multiple original authors preserves one unknown source marker', async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `version-disclosure-${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `team-${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `private-${suffix}`,
      organization: { connect: { id: organization.id } },
      project: { connect: { id: project.id } },
      team: { connect: { id: team.id } },
      slug: `private-${suffix.slice(0, 8)}`,
      type: 'standard',
      visibility: 'private',
    },
  })
  const [firstAuthor, secondAuthor] = await Promise.all([
    prisma.user.create({ data: { displayName: 'First', email: `first-${suffix}@example.test` } }),
    prisma.user.create({ data: { displayName: 'Second', email: `second-${suffix}@example.test` } }),
  ])
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: firstAuthor.id,
      name: `space-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      visibility: 'organization',
    },
  })
  const page = await prisma.knowledgePage.create({
    data: {
      createdBy: firstAuthor.id,
      organizationId: organization.id,
      projectId: project.id,
      spaceId: space.id,
      title: 'Restricted',
    },
  })
  const version = await prisma.knowledgePageVersion.create({
    data: {
      authorId: firstAuthor.id,
      authorType: 'user',
      body: 'restricted',
      pageId: page.id,
      versionNumber: 1,
    },
  })

  try {
    await prisma.knowledgePageVersionDisclosureSource.createMany({
      data: [firstAuthor.id, secondAuthor.id].map((sourceAuthorUserId) => ({
        organizationId: organization.id,
        sourceAuthorUserId,
        sourceChannelId: channel.id,
        versionId: version.id,
      })),
    })
    await prisma.user.delete({ where: { id: firstAuthor.id } })
    await prisma.user.delete({ where: { id: secondAuthor.id } })

    const sources = await prisma.knowledgePageVersionDisclosureSource.findMany({
      where: { versionId: version.id },
      select: { sourceAuthorUserId: true },
    })
    assert.deepEqual(sources, [{ sourceAuthorUserId: null }])
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } }).catch(() => undefined)
    await Promise.all([
      prisma.user.delete({ where: { id: firstAuthor.id } }).catch(() => undefined),
      prisma.user.delete({ where: { id: secondAuthor.id } }).catch(() => undefined),
    ])
    await prisma.$disconnect()
  }
})
