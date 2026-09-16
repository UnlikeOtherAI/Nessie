import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

// `folder` became a real KnowledgePageKind, and every page the old
// `metadata.folder` convention flagged had to become one. The backfill is the
// part that cannot be re-run in production, so it is tested against the exact
// SQL that shipped rather than against a re-implementation of it: the file is
// read off disk and executed, and the assertions are about what it did to rows
// that look like the pre-migration world.
//
// It runs inside a transaction that is always rolled back. The statements are
// deliberately unscoped — they are the migration, verbatim — so committing
// them would rewrite rows belonging to whatever else shares this database.

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/migrations')

const backfillSql = readFileSync(
  resolve(migrationsDir, '20260916120001_knowledge_folder_backfill/migration.sql'),
  'utf8',
)

const enumSql = readFileSync(
  resolve(migrationsDir, '20260916120000_knowledge_folder_kind/migration.sql'),
  'utf8',
)

// Strip comments and split into executable statements.
const backfillStatements = backfillSql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0)

test('the enum value is added in its own migration, before anything uses it', () => {
  // Postgres refuses to use a new enum value in the transaction that added it,
  // and Prisma runs one migration per transaction. The two must stay separate
  // files or the backfill fails on every fresh database.
  assert.match(enumSql, /ALTER TYPE "KnowledgePageKind" ADD VALUE IF NOT EXISTS 'folder'/)
  assert.doesNotMatch(enumSql, /^(?!--).*UPDATE knowledge_pages/m)
  // Asserted against the executable statements, not the file: the comments
  // name ALTER TYPE precisely to explain why it is not here.
  assert.equal(
    backfillStatements.some((statement) => /ALTER TYPE/i.test(statement)),
    false,
  )
})

test('the backfill only claims flagged pages, and never empties one with content', () => {
  assert.match(backfillSql, /SET kind = 'folder'/)
  assert.match(backfillSql, /metadata->>'folder' = 'true'/)
  // Scoped to documents: a file node is not a folder however it was flagged.
  assert.match(backfillSql, /WHERE kind = 'document'/)
  // The guard that makes the DELETE safe. Without both halves a flagged page
  // that carried a real body or an attachment would be silently emptied.
  assert.match(backfillSql, /v\.body IS NULL OR length\(v\.body\) = 0/)
  assert.match(backfillSql, /v\.attachment_id IS NULL/)
  assert.match(backfillSql, /DELETE FROM knowledge_page_chunks/)
})

runDatabaseTest('the backfill converts flagged pages and leaves everything else alone', async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `folder-kind-${suffix}` } })

  try {
    const project = await prisma.project.create({
      data: { name: `project-${suffix}`, organizationId: organization.id },
    })
    const author = await prisma.user.create({
      data: { displayName: 'Author', email: `author-${suffix}@example.test` },
    })
    const space = await prisma.knowledgeSpace.create({
      data: {
        createdBy: author.id,
        name: `space-${suffix}`,
        organizationId: organization.id,
        projectId: project.id,
        visibility: 'organization',
      },
    })

    // Three pages in the shape the world was in before the migration: every
    // one of them is `kind: 'document'`, because that was the only kind a
    // folder could have had.
    const seedPage = async (
      title: string,
      metadata: Record<string, unknown> | null,
      body: string | null,
    ) => {
      const page = await prisma.knowledgePage.create({
        data: {
          createdBy: author.id,
          kind: 'document',
          metadata: metadata ?? undefined,
          organizationId: organization.id,
          projectId: project.id,
          spaceId: space.id,
          title,
        },
      })
      const version = await prisma.knowledgePageVersion.create({
        data: {
          authorId: author.id,
          authorType: 'user',
          body,
          pageId: page.id,
          versionNumber: 1,
        },
      })
      return { pageId: page.id, versionId: version.id }
    }

    // The ordinary case: flagged, and the empty version createPage wrote for it.
    const flaggedEmpty = await seedPage('Contracts', { folder: true }, '')
    // The case the guard exists for: flagged, but carrying a real body.
    const flaggedWithBody = await seedPage('Odd one', { folder: true }, '<p>real</p>')
    // Not flagged, and it has a child. Under the old convention the admin drew
    // this as a folder; it is a document with sub-pages and stays one.
    const unflaggedParent = await seedPage('Plan', null, '<p>plan</p>')
    await prisma.knowledgePage.create({
      data: {
        createdBy: author.id,
        kind: 'document',
        organizationId: organization.id,
        parentPageId: unflaggedParent.pageId,
        projectId: project.id,
        spaceId: space.id,
        title: 'Appendix',
      },
    })
    await prisma.knowledgePage.update({
      where: { id: flaggedEmpty.pageId },
      data: { publishedVersionId: flaggedEmpty.versionId, status: 'published' },
    })

    class Rollback extends Error {}
    const observed = await prisma
      .$transaction(async (tx) => {
        for (const statement of backfillStatements) {
          await tx.$executeRawUnsafe(statement)
        }
        const pages = await tx.knowledgePage.findMany({
          where: { spaceId: space.id },
          select: {
            id: true,
            kind: true,
            status: true,
            publishedVersionId: true,
            title: true,
            _count: { select: { versions: true } },
          },
        })
        // The verification query the migration's PR must run, narrowed to this
        // fixture: a flagged page that kept real content.
        const withContent = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT p.id::text AS id FROM knowledge_pages p
           WHERE p.kind = 'folder'
             AND p.space_id = ${space.id}::uuid
             AND EXISTS (SELECT 1 FROM knowledge_page_versions v
                          WHERE v.page_id = p.id
                            AND (v.body <> '' OR v.attachment_id IS NOT NULL))
        `
        throw Object.assign(new Rollback('rollback'), { pages, withContent })
      })
      .catch((error: unknown) => {
        if (error instanceof Rollback) {
          return error as Rollback & {
            pages: Array<{
              id: string
              kind: string
              status: string
              publishedVersionId: string | null
              title: string
              _count: { versions: number }
            }>
            withContent: Array<{ id: string }>
          }
        }
        throw error
      })

    const byId = new Map(observed.pages.map((page) => [page.id, page]))

    const converted = byId.get(flaggedEmpty.pageId)
    assert.equal(converted?.kind, 'folder', 'a flagged page becomes a folder')
    assert.equal(converted?._count.versions, 0, 'its empty version is dropped')
    assert.equal(converted?.status, 'published', 'a folder has no draft state')
    assert.equal(converted?.publishedVersionId, null, 'a folder points at no version')

    const guarded = byId.get(flaggedWithBody.pageId)
    assert.equal(guarded?.kind, 'folder')
    assert.equal(
      guarded?._count.versions,
      1,
      'a flagged page carrying real content keeps it — it is reported, never emptied',
    )
    assert.deepEqual(
      observed.withContent.map((row) => row.id),
      [flaggedWithBody.pageId],
      'and it is exactly what the verification query lists for a human to decide',
    )

    const untouched = byId.get(unflaggedParent.pageId)
    assert.equal(untouched?.kind, 'document', 'having children is not being a folder')
    assert.equal(untouched?._count.versions, 1, 'and its body survives')

    // The rollback really happened: nothing the statements did is committed.
    const afterRollback = await prisma.knowledgePage.findUnique({
      where: { id: flaggedEmpty.pageId },
      select: { kind: true },
    })
    assert.equal(afterRollback?.kind, 'document')
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } }).catch(() => undefined)
    await prisma.user
      .deleteMany({ where: { email: { endsWith: `-${suffix}@example.test` } } })
      .catch(() => undefined)
    await prisma.$disconnect()
  }
})
