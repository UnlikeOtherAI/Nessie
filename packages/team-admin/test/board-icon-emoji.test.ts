import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { BoardRecordSchema, UpdateBoardBodySchema } from '@nessie/schemas'

import { createBoard, listBoards, updateBoard } from '../src/index.js'

/**
 * A board's own glyph in the Projects sidebar.
 *
 * The field is nullable and `null` is a meaningful value — "back to the shared
 * board icon" — so the thing worth pinning is that clearing it is
 * distinguishable from not mentioning it. A `...(x ? {x} : {})` spread anywhere
 * on this path would silently turn every clear into a no-op, and the surface
 * would look like it had simply failed to save.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = { organizationId: string; projectId: string; userId: string }

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Icon tester', email: `board-icon-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `board-icon-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  return { organizationId: organization.id, projectId: project.id, userId: user.id }
}

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
}

test('the wire shape carries the icon, and tells "leave it" apart from "clear it"', () => {
  assert.deepEqual(UpdateBoardBodySchema.parse({ name: 'Dev' }), { name: 'Dev' })
  assert.deepEqual(UpdateBoardBodySchema.parse({ iconEmoji: null }), { iconEmoji: null })
  assert.deepEqual(UpdateBoardBodySchema.parse({ iconEmoji: '🐛' }), { iconEmoji: '🐛' })
  // Emoji only, and bounded: nothing here is a place to smuggle a paragraph.
  assert.equal(UpdateBoardBodySchema.safeParse({ iconEmoji: '' }).success, false)
  assert.equal(UpdateBoardBodySchema.safeParse({ iconEmoji: 'x'.repeat(33) }).success, false)
})

runDatabaseTest('a board keeps the icon it was made with, and can be reset to the default', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const project = { id: seeded.projectId, organizationId: seeded.organizationId }
    // `listBoards` lazily seeds the project's default board, which carries no
    // emoji: every board that existed before this field did wears the shared icon.
    const [defaultBoard] = await listBoards(prisma, project)
    assert.ok(defaultBoard)
    assert.equal(defaultBoard.iconEmoji, null)

    const created = await createBoard(prisma, project, { name: 'Bugs', iconEmoji: '🐛' })
    assert.ok('columns' in created)
    assert.equal(created.iconEmoji, '🐛')
    // The route parses what it returns, so the record has to satisfy the wire
    // schema rather than merely carry the field.
    assert.equal(BoardRecordSchema.parse(created).iconEmoji, '🐛')

    const renamed = await updateBoard(prisma, project.id, created.id, { name: 'Defects' })
    assert.ok('columns' in renamed)
    assert.equal(renamed.name, 'Defects')
    // An update that never mentions the icon leaves it alone.
    assert.equal(renamed.iconEmoji, '🐛')

    const changed = await updateBoard(prisma, project.id, created.id, { iconEmoji: '🚀' })
    assert.ok('columns' in changed)
    assert.equal(changed.iconEmoji, '🚀')

    const cleared = await updateBoard(prisma, project.id, created.id, { iconEmoji: null })
    assert.ok('columns' in cleared)
    assert.equal(cleared.iconEmoji, null)

    // And it survives the read every surface actually uses.
    const listed = await listBoards(prisma, project)
    assert.equal(listed.find((board) => board.id === created.id)?.iconEmoji, null)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
