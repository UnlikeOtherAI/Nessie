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

test('a Markdown read records its page and private-source basis before attachment bytes enter the run', async () => {
  const sink = createConsumedSourceSink()
  const prisma = {
    knowledgePage: {
      findFirst: async () => ({
        id: PAGE_ID,
        kind: 'file',
        parentPageId: null,
        space: {
          channelId: null,
          organizationId: ORGANIZATION_ID,
          ownerAgentId: null,
          projectId: PROJECT_ID,
          teamId: null,
          userId: USER_ID,
          visibility: 'private',
        },
        spaceId: SPACE_ID,
        title: 'Private notes.md',
        versions: [{
          attachmentId: ATTACHMENT_ID,
          basisScopes: [
            { scopeId: 'private-channel', scopeType: 'channel' },
            { scopeId: 'private-project', scopeType: 'project' },
          ],
          disclosureSources: [{ sourceAuthorUserId: 'original-author', sourceChannelId: 'private-channel' }],
        }],
      }),
    },
  } as unknown as PrismaClient
  const fileService = {
    openStream: async () => ({
      attachment: { filename: 'extensionless', mime: 'text/markdown' },
      stream: Readable.from((async function* () {
        assert.deepEqual(sink.list(), [
          { scopeId: USER_ID, scopeType: 'user' },
          { scopeId: 'private-channel', scopeType: 'channel' },
          { scopeId: 'private-project', scopeType: 'project' },
        ])
        assert.deepEqual(sink.privateConversationSources(), [
          { sourceAuthorUserId: 'original-author', sourceChannelId: 'private-channel' },
        ])
        yield Buffer.from('classified body', 'utf8')
      })()),
    }),
  } as unknown as FileService

  const document = await readMarkdownDocument(
    prisma,
    fileService,
    ORGANIZATION_ID,
    PAGE_ID,
    {
      consumedSources: sink,
      disclosureViewer: {
        kind: 'user',
        scopes: [
          { scopeId: 'private-channel', scopeType: 'channel' },
          { scopeId: 'private-project', scopeType: 'project' },
        ],
        userId: USER_ID,
      },
    },
  )

  assert.equal(document?.content, 'classified body')
  assert.deepEqual(sink.list(), [
    { scopeId: USER_ID, scopeType: 'user' },
    { scopeId: 'private-channel', scopeType: 'channel' },
    { scopeId: 'private-project', scopeType: 'project' },
  ])
  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'original-author', sourceChannelId: 'private-channel' },
  ])
})

test('a live document load with unknown private lineage opens no attachment bytes', async () => {
  let opened = false
  const prisma = {
    knowledgePage: {
      findFirst: async () => ({
        id: PAGE_ID,
        kind: 'file',
        parentPageId: null,
        space: {
          channelId: null,
          organizationId: ORGANIZATION_ID,
          ownerAgentId: null,
          projectId: PROJECT_ID,
          teamId: null,
          userId: USER_ID,
          visibility: 'private',
        },
        spaceId: SPACE_ID,
        title: 'Restricted notes.md',
        versions: [{
          attachmentId: ATTACHMENT_ID,
          basisScopes: [{ scopeId: 'private-channel', scopeType: 'channel' }],
          disclosureSources: [{ sourceAuthorUserId: null, sourceChannelId: 'private-channel' }],
        }],
      }),
    },
  } as unknown as PrismaClient
  const fileService = {
    openStream: async () => { opened = true; return null },
  } as unknown as FileService

  const document = await readMarkdownDocument(
    prisma,
    fileService,
    ORGANIZATION_ID,
    PAGE_ID,
    {
      consumedSources: createConsumedSourceSink(),
      disclosureViewer: { agentId: 'agent-1', kind: 'agent', scopes: [] },
    },
  )

  assert.equal(document, null)
  assert.equal(opened, false)
})
