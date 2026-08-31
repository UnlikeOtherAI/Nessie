import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import { readMarkdownDocument } from './knowledge-document-io.js'

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const PROJECT_ID = '00000000-0000-4000-8000-000000000002'
const USER_ID = '00000000-0000-4000-8000-000000000003'
const SPACE_ID = '00000000-0000-4000-8000-000000000004'
const PAGE_ID = '00000000-0000-4000-8000-000000000005'
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000006'

test('a markdown read records its space scope before attachment bytes enter the run', async () => {
  const sink = createConsumedSourceSink()
  const prisma = {
    knowledgePage: {
      findFirst: async () => ({
        id: PAGE_ID,
        kind: 'file',
        parentPageId: null,
        publishedVersion: null,
        space: {
          channelId: null,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          teamId: null,
          userId: USER_ID,
          visibility: 'private',
        },
        spaceId: SPACE_ID,
        title: 'Private notes.md',
        versions: [{ attachmentId: ATTACHMENT_ID }],
      }),
    },
  } as unknown as PrismaClient
  const fileService = {
    openStream: async () => ({
      stream: Readable.from((async function* () {
        assert.deepEqual(sink.list(), [{ scopeId: USER_ID, scopeType: 'user' }])
        yield Buffer.from('classified body', 'utf8')
      })()),
    }),
  } as unknown as FileService

  const document = await readMarkdownDocument(
    prisma,
    fileService,
    ORGANIZATION_ID,
    PAGE_ID,
    { consumedSources: sink },
  )

  assert.equal(document?.content, 'classified body')
  assert.deepEqual(sink.list(), [{ scopeId: USER_ID, scopeType: 'user' }])
})
