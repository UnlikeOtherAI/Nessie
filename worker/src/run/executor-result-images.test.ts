import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { resolveExecutorResultImages } from './executor-result-images.js'

const RUN_ID = '00000000-0000-4000-8000-0000000000a1'
const TOOL_CALL_ID = '00000000-0000-4000-8000-0000000000d1'
const COMMAND_ID = '00000000-0000-4000-8000-0000000000b1'
const ATTACHMENT_ID = '00000000-0000-4000-8000-0000000000e1'
const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`

const reference = (digest: string, byteLength = 13_715) => ({
  attachmentDigest: digest, byteLength, mimeType: 'image/png', type: 'image',
})

const resultWith = (...content: unknown[]) => ({
  output: JSON.stringify({ content, success: true }),
  toolCallRecordId: TOOL_CALL_ID,
})

const fakePrisma = (rows: Array<{ contentByteLength: number; contentDigest: string; id: string; mime: string }>) => {
  const commandQueries: unknown[] = []
  const attachmentQueries: unknown[] = []
  const prisma = {
    attachment: {
      findMany: async (query: { where: { contentDigest: { in: string[] }; executorCommandId: string } }) => {
        attachmentQueries.push(query.where)
        return query.where.executorCommandId === COMMAND_ID
          ? rows.filter((row) => query.where.contentDigest.in.includes(row.contentDigest))
          : []
      },
    },
    executorCommand: {
      findFirst: async (query: { where: { toolCall: { id: string; runId: string } } }) => {
        commandQueries.push(query.where)
        return query.where.toolCall.id === TOOL_CALL_ID && query.where.toolCall.runId === RUN_ID
          ? { id: COMMAND_ID }
          : null
      },
    },
  }
  return { attachmentQueries, commandQueries, prisma: prisma as unknown as PrismaClient }
}

const kept = { contentByteLength: 13_715, contentDigest: DIGEST, id: ATTACHMENT_ID, mime: 'image/png' }

test('a reference resolves to the attachment its own command kept, found through this run’s ToolCall', async () => {
  const { commandQueries, prisma } = fakePrisma([kept])
  const images = await resolveExecutorResultImages(prisma, RUN_ID, resultWith(reference(DIGEST)))
  assert.deepEqual([...images], [[DIGEST, { attachmentId: ATTACHMENT_ID, byteLength: 13_715, mimeType: 'image/png' }]])
  assert.deepEqual(commandQueries, [{ toolCall: { id: TOOL_CALL_ID, runId: RUN_ID } }])
})

test('a kept image of another size or type, or a digest nothing kept, resolves to nothing', async () => {
  const { prisma } = fakePrisma([{ ...kept, contentByteLength: 99 }, { ...kept, contentDigest: OTHER_DIGEST, mime: 'image/jpeg' }])
  const images = await resolveExecutorResultImages(
    prisma,
    RUN_ID,
    resultWith(reference(DIGEST), reference(OTHER_DIGEST), reference(`sha256:${'c'.repeat(64)}`)),
  )
  assert.equal(images.size, 0)
})

test('another run’s ToolCall finds no command, so none of its images resolve', async () => {
  const { prisma } = fakePrisma([kept])
  const images = await resolveExecutorResultImages(prisma, '00000000-0000-4000-8000-0000000000a2', resultWith(reference(DIGEST)))
  assert.equal(images.size, 0)
})

test('a result with no references, or no ToolCall, asks the database nothing', async () => {
  const { attachmentQueries, commandQueries, prisma } = fakePrisma([kept])
  await resolveExecutorResultImages(prisma, RUN_ID, resultWith({ text: 'no pictures', type: 'text' }))
  await resolveExecutorResultImages(prisma, RUN_ID, { output: 'The browser session is no longer available.' })
  await resolveExecutorResultImages(prisma, RUN_ID, { output: resultWith(reference(DIGEST)).output })
  assert.equal(commandQueries.length + attachmentQueries.length, 0)
})

test('a failed lookup or a malformed reference resolves nothing and never throws', async () => {
  const failing = {
    executorCommand: { findFirst: async () => { throw new Error('connection reset') } },
  } as unknown as PrismaClient
  assert.equal((await resolveExecutorResultImages(failing, RUN_ID, resultWith(reference(DIGEST)))).size, 0)
  const { prisma } = fakePrisma([kept])
  const malformed = resultWith({ attachmentDigest: 'sha256:short', byteLength: 1, mimeType: 'image/png', type: 'image' })
  assert.equal((await resolveExecutorResultImages(prisma, RUN_ID, malformed)).size, 0)
})
