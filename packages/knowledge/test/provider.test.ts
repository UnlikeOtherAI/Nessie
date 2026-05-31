import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma, type PrismaClient } from '@prisma/client'
import {
  buildNativeSourceRef,
  buildSpaceSourceRef,
  createNativeKnowledgeProvider,
  KnowledgeConflictError,
} from '../src/index.js'
import {
  KNOWLEDGE_PAGE_SCOPED_CONTENT_MAPPING,
  KNOWLEDGE_SPACE_SCOPED_CONTENT_MAPPING,
} from '../src/scoped-mappings.js'

const scopedColumns = {
  channelId: 'channel_id',
  organizationId: 'organization_id',
  privateToAgentId: 'private_to_agent_id',
  projectId: 'project_id',
  sensitivityTier: 'sensitivity_tier',
  teamId: 'team_id',
  threadId: 'thread_id',
  userId: 'user_id',
  visibility: 'visibility',
}

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000002'
const projectId = '00000000-0000-4000-8000-000000000003'
const spaceId = '00000000-0000-4000-8000-000000000004'
const pageId = '00000000-0000-4000-8000-000000000005'
const parentPageId = '00000000-0000-4000-8000-000000000006'
const now = new Date('2026-05-31T10:00:00.000Z')

type QueryArgs = {
  data?: Record<string, unknown>
  include?: unknown
  orderBy?: unknown
  select?: Record<string, unknown>
  where?: Record<string, unknown>
}

const versionConflictError = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`page_id`,`version_number`)',
    {
      clientVersion: 'test',
      code: 'P2002',
      meta: { target: ['page_id', 'version_number'] },
    },
  )

const pageRow = (
  input: {
    id?: string
    latestVersionNumber?: number
    organizationId?: string
    parentPageId?: string | null
    status?: 'draft' | 'published' | 'archived'
  } = {},
) => ({
  id: input.id ?? pageId,
  spaceId,
  title: 'Runbook',
  summary: 'Ops runbook',
  metadata: null,
  parentPageId: input.parentPageId ?? null,
  position: 0,
  status: input.status ?? 'draft',
  publishedVersionId: null,
  privateToAgentId: null,
  organizationId: input.organizationId ?? organizationId,
  projectId,
  teamId: null,
  channelId: null,
  threadId: null,
  userId: null,
  visibility: 'project',
  sensitivityTier: 'normal',
  createdBy: 'user-1',
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  labels: [{ name: 'ops', normalizedName: 'ops' }],
  versions: [{
    id: `version-${input.latestVersionNumber ?? 1}`,
    pageId: input.id ?? pageId,
    versionNumber: input.latestVersionNumber ?? 1,
    body: '# Runbook',
    bodyRef: null,
    authorType: 'user',
    authorId: 'user-1',
    changeComment: null,
    createdAt: now,
  }],
  publishedVersion: null,
})

test('native provider declares governed first-party capabilities', () => {
  const provider = createNativeKnowledgeProvider({} as PrismaClient)

  assert.equal(provider.kind, 'first_party')
  assert.deepEqual(provider.capabilities, {
    canWrite: true,
    canIncrementalSync: false,
    supportsNativeSearch: true,
    supportsServerSideACL: true,
    supportsVersionHistory: true,
    supportsHierarchicalPages: true,
    supportsDeterministicSearch: true,
  })
})

test('knowledge models satisfy the shared scoped-content contract', () => {
  assert.deepEqual(KNOWLEDGE_SPACE_SCOPED_CONTENT_MAPPING.columns, scopedColumns)
  assert.deepEqual(KNOWLEDGE_PAGE_SCOPED_CONTENT_MAPPING.columns, scopedColumns)
  assert.equal(KNOWLEDGE_SPACE_SCOPED_CONTENT_MAPPING.deletedAtColumn, 'deleted_at')
  assert.equal(KNOWLEDGE_PAGE_SCOPED_CONTENT_MAPPING.deletedAtColumn, 'deleted_at')
})

test('native source refs are stable and version-addressable', () => {
  assert.equal(
    buildNativeSourceRef('page-1', 'version-2'),
    'kb://first-party/pages/page-1/versions/version-2',
  )
  assert.equal(buildNativeSourceRef('page-1', null), 'kb://first-party/pages/page-1')
  assert.equal(buildSpaceSourceRef('space-1'), 'kb://first-party/spaces/space-1')
})

test('native provider rejects publishing archived pages', async () => {
  const tx = {
    knowledgePage: {
      findFirst: async () => ({ id: pageId, spaceId, status: 'archived' }),
    },
  }
  const prisma = {
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => callback(tx),
  } as unknown as PrismaClient
  const provider = createNativeKnowledgeProvider(prisma)

  await assert.rejects(
    provider.publishPage({ organizationId, pageId }),
    (error) =>
      error instanceof KnowledgeConflictError &&
      error.message === 'Archived pages are read-only',
  )
})

test('native search re-fetch remains scoped to active pages in the caller organization', async () => {
  const findManyCalls: QueryArgs[] = []
  const prisma = {
    $queryRaw: async () => [
      { id: pageId, snippet: 'visible', updatedAt: now },
      { id: parentPageId, snippet: 'archived', updatedAt: now },
      { id: '00000000-0000-4000-8000-000000000007', snippet: 'foreign', updatedAt: now },
    ],
    knowledgePage: {
      findMany: async (args: QueryArgs) => {
        findManyCalls.push(args)
        return [pageRow({ id: pageId, organizationId, status: 'published' })]
      },
    },
  } as unknown as PrismaClient
  const provider = createNativeKnowledgeProvider(prisma)

  const result = await provider.searchPages({ organizationId, query: 'runbook' })

  assert.deepEqual(result.data.map((hit) => hit.page.id), [pageId])
  assert.deepEqual(findManyCalls[0]?.where, {
    id: { in: [
      pageId,
      parentPageId,
      '00000000-0000-4000-8000-000000000007',
    ] },
    organizationId,
    deletedAt: null,
    status: { not: 'archived' },
  })
  assert.notEqual(findManyCalls[0]?.where?.['organizationId'], otherOrganizationId)
})

test('native move cycle walk is scoped to the caller organization', async () => {
  const findFirstCalls: QueryArgs[] = []
  const tx = {
    knowledgePage: {
      findFirst: async (args: QueryArgs) => {
        findFirstCalls.push(args)
        const where = args.where ?? {}
        if (args.include) return pageRow({ parentPageId })
        if (where['id'] === pageId) return { id: pageId, spaceId, status: 'draft' }
        if (where['id'] === parentPageId && args.select?.['parentPageId']) {
          return { parentPageId: null }
        }
        if (where['id'] === parentPageId) return { id: parentPageId }
        return null
      },
      update: async () => pageRow({ parentPageId }),
    },
  }
  const prisma = {
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => callback(tx),
  } as unknown as PrismaClient
  const provider = createNativeKnowledgeProvider(prisma)

  const moved = await provider.movePage({
    organizationId,
    pageId,
    parentPageId,
    position: 1,
  })

  const cycleLookup = findFirstCalls.find(
    (call) =>
      call.where?.['id'] === parentPageId &&
      call.select?.['parentPageId'] === true,
  )
  assert.equal(moved?.parentPageId, parentPageId)
  assert.deepEqual(cycleLookup?.where, { id: parentPageId, organizationId })
})

test('native update retries append-only version creation after a version-number race', async () => {
  const createAttempts: number[] = []
  let transactionCount = 0
  const prisma = {
    $transaction: async <T>(callback: (client: unknown) => Promise<T>) => {
      transactionCount += 1
      const latestVersionNumber = transactionCount === 1 ? 1 : 2
      const tx = {
        knowledgePage: {
          findFirst: async (args: QueryArgs) =>
            args.include
              ? pageRow({ latestVersionNumber: createAttempts.at(-1) ?? latestVersionNumber })
              : { id: pageId, spaceId, status: 'draft' },
          update: async () => pageRow(),
        },
        knowledgePageVersion: {
          findFirst: async () => ({ versionNumber: latestVersionNumber }),
          create: async (args: QueryArgs) => {
            const versionNumber = args.data?.['versionNumber']
            assert.equal(typeof versionNumber, 'number')
            createAttempts.push(versionNumber)
            if (createAttempts.length === 1) throw versionConflictError()
            return {
              id: `version-${versionNumber}`,
              pageId,
              versionNumber,
              body: args.data?.['body'] ?? null,
              bodyRef: args.data?.['bodyRef'] ?? null,
              authorType: args.data?.['authorType'] ?? 'user',
              authorId: args.data?.['authorId'] ?? 'user-1',
              changeComment: args.data?.['changeComment'] ?? null,
              createdAt: now,
            }
          },
        },
      }
      return callback(tx)
    },
  } as unknown as PrismaClient
  const provider = createNativeKnowledgeProvider(prisma)

  const updated = await provider.updatePage(pageId, {
    organizationId,
    authorId: 'user-1',
    authorType: 'user',
    body: '# Updated',
  })

  assert.equal(updated?.latestVersion?.versionNumber, 3)
  assert.deepEqual(createAttempts, [2, 3])
  assert.equal(transactionCount, 2)
})
