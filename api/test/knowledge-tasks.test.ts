import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { CreatePageInput, KnowledgePageRecord, KnowledgeProvider } from '@nessie/knowledge'
import { registerKnowledgeTaskRoutes } from '../src/routes/knowledge-tasks.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'
const taskId = '00000000-0000-4000-8000-000000000007'
const docsSpaceId = '00000000-0000-4000-8000-000000000008'
const folderId = '00000000-0000-4000-8000-000000000009'
const pageId = '00000000-0000-4000-8000-000000000010'
const versionId = '00000000-0000-4000-8000-000000000011'

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: userId, roles: ['owner'] },
  tenant: { organizationId, projectId },
  actionContext: { requestId: 'req-kb-tasks-test' },
}

const policyRow = (effect: 'allow' | 'deny') => ({
  id: '00000000-0000-4000-8000-000000000099',
  scope: 'organization',
  scopeId: organizationId,
  resourceType: 'knowledge_page',
  action: 'create',
  effect,
  priority: 10,
  conditions: null,
  actorType: 'role',
  actorId: '*',
})

const makePage = (input: Partial<KnowledgePageRecord> = {}): KnowledgePageRecord => ({
  id: pageId,
  spaceId: docsSpaceId,
  title: 'Ticket note',
  summary: null,
  metadata: null,
  kind: 'document',
  parentPageId: folderId,
  position: 0,
  status: 'draft',
  taskId,
  labels: [],
  latestVersion: {
    id: versionId,
    pageId,
    versionNumber: 1,
    body: '<p>hello</p>',
    bodyRef: null,
    authorType: 'user',
    authorId: userId,
    changeComment: null,
    createdAt: '2026-07-06T10:00:00.000Z',
  },
  publishedVersion: null,
  publishedVersionId: null,
  organizationId,
  projectId,
  teamId: null,
  channelId: null,
  threadId: null,
  userId: null,
  visibility: 'project',
  sensitivityTier: 'normal',
  privateToAgentId: null,
  createdBy: userId,
  deletedAt: null,
  createdAt: '2026-07-06T10:00:00.000Z',
  updatedAt: '2026-07-06T10:00:00.000Z',
  ...input,
})

type MakeAppOptions = {
  policyEffect?: 'allow' | 'deny'
  actorContextOverride?: AuthorizedActionContext
  task?: { id: string; title: string | null; projectId: string | null } | null
  existingMyDocsSpaceId?: string | null
  existingProjectDocsSpaceId?: string | null
  existingFolderId?: string | null
  createProviderPage?: KnowledgeProvider['createPage']
  fileServiceOverrides?: Partial<{
    store: () => Promise<{ attachment: { id: string }; bytesWritten: number }>
    delete: () => Promise<boolean>
  }>
}

const makeApp = (options: MakeAppOptions = {}) => {
  const auditLogs: Array<Record<string, unknown>> = []
  const createPageCalls: CreatePageInput[] = []
  const spaceCreateCalls: Array<Record<string, unknown>> = []

  const defaultCreatePage: KnowledgeProvider['createPage'] = async (input) => {
    createPageCalls.push(input)
    return makePage({ title: input.title, taskId: input.taskId ?? null })
  }

  const txPrisma = {
    $executeRaw: async () => 0,
    knowledgeSpace: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        // Distinguish the "My Docs" (userId set) vs "Project Documents"
        // (no userId) lookups by the presence of a userId filter.
        if ('userId' in args.where) {
          return options.existingMyDocsSpaceId ? { id: options.existingMyDocsSpaceId } : null
        }
        return options.existingProjectDocsSpaceId ? { id: options.existingProjectDocsSpaceId } : null
      },
      create: async (args: { data: Record<string, unknown> }) => {
        spaceCreateCalls.push(args.data)
        return { id: args.data['userId'] ? docsSpaceId : docsSpaceId }
      },
    },
  }

  const prisma = {
    $queryRaw: async () => (options.policyEffect === 'deny' ? [policyRow('deny')] : [policyRow('allow')]),
    $transaction: async <T>(callback: (tx: typeof txPrisma) => Promise<T>) => callback(txPrisma),
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditLogs.push(data)
      },
    },
    projectMember: { findMany: async () => [{ projectId }] },
    agentBinding: { findMany: async () => [] },
    knowledgeSpaceMember: { findMany: async () => [] },
    task: {
      findFirst: async () =>
        options.task === null
          ? null
          : options.task ?? { id: taskId, title: 'Fix the thing', projectId },
    },
    knowledgePage: {
      findFirst: async () => (options.existingFolderId ? { id: options.existingFolderId } : null),
      findMany: async () => [],
    },
  } as unknown as PrismaClient

  const provider: KnowledgeProvider = {
    id: 'test',
    kind: 'first_party',
    capabilities: {
      canWrite: true,
      canIncrementalSync: false,
      supportsNativeSearch: true,
      supportsServerSideACL: true,
      supportsVersionHistory: true,
      supportsHierarchicalPages: true,
      supportsDeterministicSearch: true,
    },
    addFileVersion: async () => null,
    archivePage: async () => null,
    archiveSpace: async () => null,
    createPage: options.createProviderPage ?? defaultCreatePage,
    createSpace: async () => {
      throw new Error('createSpace should not be called directly by the tasks routes')
    },
    getPage: async () => null,
    getSpace: async () => ({
      id: docsSpaceId,
      name: 'Project Documents',
      description: null,
      metadata: { projectDocuments: true },
      writeRestricted: false,
      memberUserIds: [],
      memberAgentIds: [],
      organizationId,
      projectId,
      teamId: null,
      channelId: null,
      threadId: null,
      userId: null,
      visibility: 'project',
      sensitivityTier: 'normal',
      privateToAgentId: null,
      createdBy: userId,
      deletedAt: null,
      createdAt: '2026-07-06T10:00:00.000Z',
      updatedAt: '2026-07-06T10:00:00.000Z',
    }),
    listPages: async () => [],
    listSpaces: async () => ({ data: [], meta: { cursor: null, hasMore: false } }),
    listVersions: async () => [],
    movePage: async () => null,
    publishPage: async () => null,
    restoreVersion: async () => null,
    searchPages: async () => ({ data: [], meta: { cursor: null, hasMore: false } }),
    updatePage: async () => null,
    updateSpace: async () => null,
  }

  const fileService = {
    store: options.fileServiceOverrides?.store ?? (async () => ({
      attachment: { id: '00000000-0000-4000-8000-000000000012' },
      bytesWritten: 3,
    })),
    delete: options.fileServiceOverrides?.delete ?? (async () => true),
    openStream: async () => null,
    purgeKnowledgePageFiles: async () => undefined,
    checkQuota: async () => ({ allowed: true }),
    currentUsage: async () => ({ usedBytes: 0n, limitBytes: null }),
    usageForScope: async () => 0n,
  }

  const app = Fastify({ logger: false })
  registerKnowledgeTaskRoutes(app, {
    prisma,
    knowledgeProvider: provider,
    fileService,
    requireActorContext: () => options.actorContextOverride ?? actorContext,
  } as unknown as Parameters<typeof registerKnowledgeTaskRoutes>[1])

  return { app, auditLogs, createPageCalls, spaceCreateCalls }
}

test('POST /my-docs rejects a non-user actor', async () => {
  const agentActorContext: AuthorizedActionContext = {
    actor: { actorType: 'agent', actorId: '00000000-0000-4000-8000-000000000098', roles: [] },
    tenant: { organizationId, projectId },
    actionContext: { requestId: 'req-my-docs-agent' },
  }
  const { app } = makeApp({ actorContextOverride: agentActorContext })
  const response = await app.inject({ method: 'POST', url: '/api/knowledge-base/my-docs' })

  assert.equal(response.statusCode, 403)
  const payload = response.json() as { error: { code: string } }
  assert.equal(payload.error.code, 'ACTOR_TYPE_NOT_ALLOWED')
  await app.close()
})

test('POST /my-docs provisions a new personal space and audits its creation', async () => {
  const { app, auditLogs, spaceCreateCalls } = makeApp({ existingMyDocsSpaceId: null })
  const response = await app.inject({ method: 'POST', url: '/api/knowledge-base/my-docs' })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { data: { spaceId: string } }
  assert.equal(payload.data.spaceId, docsSpaceId)
  assert.equal(spaceCreateCalls.length, 1)
  assert.equal(spaceCreateCalls[0]?.['userId'], userId)
  assert.equal(spaceCreateCalls[0]?.['visibility'], 'private')
  assert.equal(auditLogs.length, 1)
  assert.equal(auditLogs[0]?.['action'], 'kb.space.created')
  await app.close()
})

test('POST /my-docs is idempotent — reuses an existing space and does not audit again', async () => {
  const existingSpaceId = '00000000-0000-4000-8000-000000000077'
  const { app, auditLogs, spaceCreateCalls } = makeApp({ existingMyDocsSpaceId: existingSpaceId })
  const response = await app.inject({ method: 'POST', url: '/api/knowledge-base/my-docs' })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { data: { spaceId: string } }
  assert.equal(payload.data.spaceId, existingSpaceId)
  assert.equal(spaceCreateCalls.length, 0)
  assert.equal(auditLogs.length, 0)
  await app.close()
})

test('GET /tasks/:taskId/pages 404s when the task does not exist in this org', async () => {
  const { app } = makeApp({ task: null })
  const response = await app.inject({
    method: 'GET',
    url: `/api/knowledge-base/tasks/${taskId}/pages`,
  })

  assert.equal(response.statusCode, 404)
  const payload = response.json() as { error: { code: string } }
  assert.equal(payload.error.code, 'TASK_NOT_FOUND')
  await app.close()
})

test('GET /tasks/:taskId/pages returns the page envelope shape', async () => {
  const { app } = makeApp({})
  const response = await app.inject({
    method: 'GET',
    url: `/api/knowledge-base/tasks/${taskId}/pages`,
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { data: unknown[] }
  assert.deepEqual(payload.data, [])
  await app.close()
})

test('POST /tasks/:taskId/pages creates a page bound to the ticket folder and taskId', async () => {
  const { app, auditLogs, createPageCalls } = makeApp({ existingFolderId: folderId })
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-base/tasks/${taskId}/pages`,
    payload: { title: 'Design notes', body: '<p>notes</p>' },
  })

  assert.equal(response.statusCode, 201)
  assert.equal(createPageCalls.length, 1)
  assert.equal(createPageCalls[0]?.taskId, taskId)
  assert.equal(createPageCalls[0]?.parentPageId, folderId)
  assert.equal(createPageCalls[0]?.spaceId, docsSpaceId)
  assert.equal(auditLogs.length, 1)
  assert.equal(auditLogs[0]?.['action'], 'kb.page.created')
  const payloadJson = response.json() as { data: { taskId: string | null } }
  assert.equal(payloadJson.data.taskId, taskId)
  await app.close()
})

test('POST /tasks/:taskId/pages denies before creating the page when policy denies', async () => {
  const { app, createPageCalls } = makeApp({ policyEffect: 'deny' })
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-base/tasks/${taskId}/pages`,
    payload: { title: 'Design notes' },
  })

  assert.equal(response.statusCode, 403)
  assert.equal(createPageCalls.length, 0)
  await app.close()
})

const buildMultipartPayload = (filename: string, content: string, mime: string, boundary: string): Buffer =>
  Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${mime}`,
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
    'utf8',
  )

test('POST /tasks/:taskId/files stores the upload and files it as a file-node under the ticket folder', async () => {
  const { app, auditLogs, createPageCalls } = makeApp({ existingFolderId: folderId })
  await app.register(multipart)
  await app.ready()

  const boundary = '----kbTaskFilesTestBoundary'
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-base/tasks/${taskId}/files`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: buildMultipartPayload('spec.txt', 'hello world', 'text/plain', boundary),
  })

  assert.equal(response.statusCode, 201)
  assert.equal(createPageCalls.length, 1)
  assert.equal(createPageCalls[0]?.kind, 'file')
  assert.equal(createPageCalls[0]?.taskId, taskId)
  assert.equal(createPageCalls[0]?.parentPageId, folderId)
  assert.equal(auditLogs.length, 1)
  assert.equal(auditLogs[0]?.['action'], 'kb.page.created')
  await app.close()
})

test('POST /tasks/:taskId/files rolls back the stored object when page creation fails', async () => {
  let deleted = false
  const { app } = makeApp({
    existingFolderId: folderId,
    createProviderPage: async () => {
      throw new Error('boom')
    },
    fileServiceOverrides: {
      delete: async () => {
        deleted = true
        return true
      },
    },
  })
  await app.register(multipart)
  await app.ready()

  const boundary = '----kbTaskFilesTestBoundary2'
  const response = await app.inject({
    method: 'POST',
    url: `/api/knowledge-base/tasks/${taskId}/files`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: buildMultipartPayload('spec.txt', 'hello world', 'text/plain', boundary),
  })

  assert.equal(response.statusCode, 400)
  assert.equal(deleted, true)
  await app.close()
})
