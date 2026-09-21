import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { createFileService, getStorage } from '@nessie/runtime'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import { McpScopeError } from '../src/mcp/scopes.js'
import { nessieMcpTools } from '../src/mcp/server.js'
import type { McpToolContext } from '../src/mcp/tool-context.js'
import { getTask } from '../src/services/tasks.js'

// A task's comments and files through the MCP server, against a real
// database. Each tool is an adapter over the function the comment and
// attachment routes call; what is pinned here is the adapter's own share —
// the scope gate, the reach check, the 10 MiB ceiling on an inline upload,
// linking at store time, the words an agent reads when a comment cannot
// reach a mirrored ticket's provider, and the realtime event that refreshes
// an open dialog.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const tool = (name: string) => {
  const found = nessieMcpTools().find((candidate) => candidate.name === name)
  assert.ok(found, `${name} is not registered`)
  return found
}

const READ_TOOLS = [
  'nessie_task_comment_list',
  'nessie_task_attachment_list',
  'nessie_task_attachment_get',
]
const WRITE_TOOLS = [
  'nessie_task_comment_add',
  'nessie_task_comment_update',
  'nessie_task_comment_delete',
  'nessie_task_attachment_add',
  'nessie_task_attachment_remove',
]

const refusesScope = async (name: string, scopes: McpToolContext['scopes'], required: string) => {
  await assert.rejects(
    () => tool(name).run({ scopes } as never, { taskId: randomUUID() }),
    (error: unknown) => {
      assert.ok(error instanceof McpScopeError, `${name} did not check its scope first`)
      assert.equal(error.required, required, `${name} asked for the wrong scope`)
      return true
    },
  )
}

test('every comment and attachment tool refuses without its scope', async () => {
  for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) {
    await refusesScope(name, [], READ_TOOLS.includes(name) ? 'boards_read' : 'boards_write')
  }
  // A read scope never lends a write, and a write scope never lends a read.
  for (const name of WRITE_TOOLS) await refusesScope(name, ['boards_read'], 'boards_write')
  for (const name of READ_TOOLS) await refusesScope(name, ['boards_write'], 'boards_read')
})

test('the Markdown and inline-image convention is in the descriptions agents read', () => {
  for (const name of ['nessie_task_get', 'nessie_task_update', 'nessie_task_comment_add']) {
    const { description } = tool(name)
    assert.match(description, /Markdown/, `${name} must say descriptions and comments are Markdown`)
    assert.match(description, /!\[alt\]\(\/api\/attachments\/<attachmentId>\)/, `${name} must show the image syntax`)
    assert.match(description, /nessie_task_attachment_add/, `${name} must name the upload tool`)
  }
})

type Seed = { organizationId: string; projectId: string; userId: string; otherUserId: string; storagePath: string }

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `ta ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
  const [user, other] = await Promise.all(['Owner', 'Other'].map((displayName) =>
    prisma.user.create({ data: { displayName, email: `ta-${randomUUID()}@example.test` } })))
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: org.id, role: 'owner', userId: user!.id },
      { organizationId: org.id, role: 'owner', userId: other!.id },
    ],
  })
  await prisma.board.create({
    data: { name: 'Delivery', organizationId: org.id, position: 0, projectId: project.id },
  })
  return {
    organizationId: org.id,
    projectId: project.id,
    userId: user!.id,
    otherUserId: other!.id,
    storagePath: await mkdtemp(join(tmpdir(), 'mcp-task-activity-')),
  }
}

type Published = { event: string; data: Record<string, unknown> }

const contextFor = (
  prisma: PrismaClient,
  s: Seed,
  published: Published[],
  userId = s.userId,
): McpToolContext => ({
  actorContext: AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: s.organizationId, projectId: s.projectId },
  }),
  encryptionKeyRing: { activeVersion: 'test', keys: { test: 'mcp-task-activity-encryption-root' } },
  checkPolicy: async () => ({ allowed: true, reasonCode: 'ALLOWED' }),
  fileService: createFileService({
    prisma,
    storage: getStorage({ provider: 'filesystem', localPath: s.storagePath }),
    maxUploadBytes: 25 * 1024 * 1024,
  }),
  getTask: async (taskId) =>
    getTask(prisma, taskId, s.organizationId, undefined, userId, undefined) as never,
  isProjectAccessibleToActor: async () => true,
  knowledge: null,
  prisma,
  realtime: {
    publishWs: async (_scopes, input) => {
      published.push({ event: input.event, data: input.data as Record<string, unknown> })
      return {} as never
    },
  },
  scopes: ['boards_read', 'boards_write'],
})

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.organization.delete({ where: { id: s.organizationId } })
  await prisma.user.deleteMany({ where: { id: { in: [s.userId, s.otherUserId] } } })
  await rm(s.storagePath, { recursive: true, force: true })
}

const createTask = async (context: McpToolContext, projectId: string, title: string) => {
  const created = await tool('nessie_task_create').run(context, { projectId, title }) as { task: { id: string } }
  assert.ok(created.task, 'the task should have been created')
  return created.task.id
}

runDatabaseTest('an agent attaches a file, linked the moment it is stored, and 10 MiB+ is refused', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const published: Published[] = []
    const context = contextFor(prisma, s, published)
    const taskId = await createTask(context, s.projectId, 'Attach here')

    const added = await tool('nessie_task_attachment_add').run(context, {
      taskId,
      filename: 'notes.txt',
      mime: 'text/plain',
      contentBase64: Buffer.from('hello from an agent').toString('base64'),
    }) as { attachment?: { id: string }; markdown?: string; error?: string }
    assert.ok(added.attachment, `the file should have been attached: ${added.error}`)

    // Linked at store time: no unlinked upload is left waiting for a composer.
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: added.attachment.id } })
    assert.equal(row.taskId, taskId)
    assert.equal(row.uploaderId, s.userId, 'the granting person uploaded it')
    assert.equal(added.markdown, `![notes.txt](/api/attachments/${added.attachment.id})`)
    const events = await prisma.taskEvent.findMany({ where: { taskId, eventType: 'attachment_added' } })
    assert.equal(events.length, 1, 'the link is audited as a person\'s would be')
    assert.ok(
      published.some((event) => event.event === 'task.activity' && event.data.taskId === taskId),
      'an open dialog must hear about the new file',
    )

    // The bytes read back through the same tool family.
    const got = await tool('nessie_task_attachment_get').run(context, {
      taskId,
      attachmentId: added.attachment.id,
    }) as { contentBase64?: string }
    assert.equal(Buffer.from(got.contentBase64 ?? '', 'base64').toString('utf8'), 'hello from an agent')

    // Over the ceiling: refused in words, and nothing stored.
    const before = await prisma.attachment.count({ where: { organizationId: s.organizationId } })
    const tooLarge = await tool('nessie_task_attachment_add').run(context, {
      taskId,
      filename: 'big.bin',
      mime: 'application/octet-stream',
      contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
    }) as { code?: string; error?: string; retryable?: boolean }
    assert.equal(tooLarge.code, 'ATTACHMENT_TOO_LARGE')
    assert.match(String(tooLarge.error), /10 MiB/)
    assert.equal(tooLarge.retryable, false)
    assert.equal(await prisma.attachment.count({ where: { organizationId: s.organizationId } }), before)

    // The read the agent starts from now carries the file.
    const read = await tool('nessie_task_get').run(context, { taskId }) as {
      attachments: Array<{ id: string }>
      commentCount: number
      labels: unknown[]
    }
    assert.deepEqual(read.attachments.map((file) => file.id), [added.attachment.id])
    assert.equal(read.commentCount, 0)
    assert.deepEqual(read.labels, [])
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an agent marks a file removed with a reason; it stays readable and says who removed it', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const published: Published[] = []
    const context = contextFor(prisma, s, published)
    const taskId = await createTask(context, s.projectId, 'Remove from here')
    const added = await tool('nessie_task_attachment_add').run(context, {
      taskId,
      filename: 'draft.txt',
      mime: 'text/plain',
      contentBase64: Buffer.from('first draft').toString('base64'),
    }) as { attachment: { id: string } }

    assert.equal(
      tool('nessie_task_attachment_remove').description,
      'Mark a file on a task as removed. It stays downloadable and the list shows who removed it and why; '
        + 'give a reason when you have one.',
    )
    const removed = await tool('nessie_task_attachment_remove').run(context, {
      taskId,
      attachmentId: added.attachment.id,
      reason: 'Superseded by v2',
    }) as { removed?: boolean; attachment?: { removed: { byUserId: string; reason: string } } }
    assert.equal(removed.removed, true)
    assert.equal(removed.attachment?.removed.reason, 'Superseded by v2', 'the reason reaches the shared function')
    assert.equal(removed.attachment?.removed.byUserId, s.userId)
    assert.equal(await prisma.attachment.count({ where: { id: added.attachment.id } }), 1, 'nothing deleted')

    const listed = await tool('nessie_task_attachment_list').run(context, { taskId }) as {
      attachments: Array<{ id: string; removed: { reason: string } | null }>
    }
    assert.equal(listed.attachments[0]?.removed?.reason, 'Superseded by v2')

    const got = await tool('nessie_task_attachment_get').run(context, {
      taskId,
      attachmentId: added.attachment.id,
    }) as { contentBase64?: string; note?: string }
    assert.equal(Buffer.from(got.contentBase64 ?? '', 'base64').toString('utf8'), 'first draft')
    assert.match(
      String(got.note),
      new RegExp(`^This file was removed from the task on \\d{4}-\\d{2}-\\d{2} by user ${s.userId}: Superseded by v2$`),
    )

    const again = await tool('nessie_task_attachment_remove').run(context, {
      taskId,
      attachmentId: added.attachment.id,
    }) as { code?: string; error?: string }
    assert.equal(again.code, 'ATTACHMENT_ALREADY_REMOVED')
    assert.equal(again.error, 'That file is already marked as removed.')
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a comment on a read-only mirror stays in Nessie and says so', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const published: Published[] = []
    const context = contextFor(prisma, s, published)
    const taskId = await createTask(context, s.projectId, 'Mirrored from Linear')
    const connection = await prisma.boardSourceConnection.create({
      data: {
        externalAccountId: 'lin-user-1',
        organizationId: s.organizationId,
        ownerUserId: s.userId,
        provider: 'linear',
      },
    })
    const source = await prisma.boardSource.create({
      data: {
        connectionId: connection.id,
        container: {},
        containerKey: `team-${randomUUID()}`,
        createdByUserId: s.userId,
        name: 'Linear — Core',
        organizationId: s.organizationId,
        projectId: s.projectId,
        provider: 'linear',
        writeMode: 'read_only',
      },
    })
    await prisma.taskExternalLink.create({
      data: {
        externalId: 'ENG-1',
        externalKey: 'ENG-1',
        externalUrl: 'https://linear.app/acme/issue/ENG-1',
        organizationId: s.organizationId,
        sourceId: source.id,
        taskId,
      },
    })

    const added = await tool('nessie_task_comment_add').run(context, {
      taskId,
      body: 'Looked into it — **see the trace**.',
    }) as {
      comment?: { id: string; author: { kind: string; userId?: string }; external: unknown }
      note?: string
      origin?: { kind: string }
      propagated?: boolean
    }
    assert.ok(added.comment, 'the comment should have been added')
    assert.equal(added.propagated, false)
    assert.equal(added.note, 'This ticket mirrors Linear read-only; the comment stays in Nessie.')
    assert.equal(added.origin?.kind, 'mirrored')
    assert.equal(added.comment.external, null)
    assert.deepEqual(added.comment.author, { kind: 'user', userId: s.userId })
    assert.ok(
      published.some((event) => event.event === 'task.activity' && event.data.taskId === taskId),
      'an open dialog must hear about the new comment',
    )

    const listed = await tool('nessie_task_comment_list').run(context, { taskId }) as {
      comments: Array<{ id: string; body: string }>
      total: number
    }
    assert.equal(listed.total, 1)
    assert.equal(listed.comments[0]?.body, 'Looked into it — **see the trace**.')

    // Only its author can change it: another owner is refused in words.
    const stranger = contextFor(prisma, s, published, s.otherUserId)
    const refused = await tool('nessie_task_comment_update').run(stranger, {
      taskId,
      commentId: added.comment.id,
      body: 'Not mine to edit',
    }) as { code?: string; error?: string }
    assert.equal(refused.code, 'COMMENT_NOT_AUTHOR')
    assert.equal(refused.error, 'Only its author can change a comment.')

    const deleted = await tool('nessie_task_comment_delete').run(context, {
      taskId,
      commentId: added.comment.id,
    }) as { deleted?: boolean }
    assert.equal(deleted.deleted, true)
    const row = await prisma.taskComment.findUniqueOrThrow({ where: { id: added.comment.id } })
    assert.ok(row.deletedAt, 'the author deleted it')
    assert.match(tool('nessie_task_comment_delete').description, /its files are marked removed and stay downloadable/)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a task outside the credential\'s reach is refused before any write', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s, [])
    const taskId = await createTask(context, s.projectId, 'Somebody else\'s')
    const blind: McpToolContext = { ...context, getTask: async () => null }
    const refused = await tool('nessie_task_comment_add').run(blind, { taskId, body: 'Should not land' }) as {
      error?: string
    }
    assert.match(String(refused.error), /cannot reach|not found/i)
    assert.equal(await prisma.taskComment.count({ where: { taskId } }), 0)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})
