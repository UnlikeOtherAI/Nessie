import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  CoreDocumentIntegrityError,
  loadActiveAgentCoreDocuments,
} from '../src/agent-core-documents.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const spaceId = '00000000-0000-4000-8000-000000000003'

const digest = (value: string): string =>
  createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')

const coreRow = (
  role: 'identity' | 'working_rules',
  markdown: string,
  overrides: Record<string, unknown> = {},
) => ({
  page: {
    deletedAt: null,
    documentRole: role,
    id: `page-${role}`,
    kind: 'file',
    parentPageId: null,
    projectId: 'project-1',
    publishedVersion: {
      attachmentId: `attachment-${role}`,
      basisScopes: [{ scopeId: 'project-1', scopeType: 'project' }],
      disclosureSources: [],
      id: `version-${role}`,
      sourceContentHash: digest(markdown),
      versionNumber: 1,
    },
    sensitivityTier: 'normal',
    space: {
      deletedAt: null,
      id: spaceId,
      organizationId,
      ownerAgentId: agentId,
      projectId: 'project-1',
      sensitivityTier: 'normal',
      visibility: 'private',
    },
    title: role === 'identity' ? 'AGENTS.md' : 'personality.md',
    visibility: 'private',
    ...overrides,
  },
  role,
})

const prismaWith = (rows: unknown[]): PrismaClient => ({
  agentCoreDocument: { findMany: async () => rows },
  agentCoreDocumentMigration: { findUnique: async () => ({ documentCount: 2 }) },
} as unknown as PrismaClient)

test('core files are authorized and stamped before their bytes are opened', async () => {
  const content = {
    identity: 'You are a careful investigator.',
    working_rules: 'Be dry, concise, and candid.',
  }
  const events: string[] = []
  const documents = await loadActiveAgentCoreDocuments(
    prismaWith([
      coreRow('identity', content.identity),
      coreRow('working_rules', content.working_rules),
    ]),
    {
      agentId,
      authorize: async (document) => {
        events.push(`authorize:${document.role}`)
        assert.deepEqual(document.basisScopes, [{ scopeId: 'project-1', scopeType: 'project' }])
      },
      organizationId,
      readMarkdownAttachment: async (attachmentId) => {
        const role = attachmentId.endsWith('identity') ? 'identity' : 'working_rules'
        events.push(`read:${role}`)
        return Readable.from([content[role]])
      },
    },
  )

  for (const role of ['identity', 'working_rules'] as const) {
    assert.ok(events.indexOf(`authorize:${role}`) < events.indexOf(`read:${role}`))
  }
  assert.deepEqual(documents.map(({ role, title }) => ({ role, title })), [
    { role: 'identity', title: 'AGENTS.md' },
    { role: 'working_rules', title: 'personality.md' },
  ])
})

test('a required file outside its canonical name or home fails before any byte read', async () => {
  let opened = false
  await assert.rejects(
    loadActiveAgentCoreDocuments(
      prismaWith([
        coreRow('identity', 'identity', { title: 'Identity.md' }),
        coreRow('working_rules', 'style'),
      ]),
      {
        agentId,
        organizationId,
        readMarkdownAttachment: async () => {
          opened = true
          return Readable.from(['unexpected'])
        },
      },
    ),
    (error: unknown) => error instanceof CoreDocumentIntegrityError
      && /canonical home/.test(error.message),
  )
  assert.equal(opened, false)
})
