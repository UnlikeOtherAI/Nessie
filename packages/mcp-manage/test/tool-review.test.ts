import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { SetToolRegistryStatusRequestSchema } from '@nessie/schemas'
import {
  MCP_INSTANCE_ERROR_CODES,
  setToolRegistryEntriesStatus,
} from '../src/index.js'

/**
 * Owner review of discovered MCP tools.
 *
 * The defect this closes was a green-UI/dead-pipeline gap: a connector could
 * be installed, probed and shown as ACTIVE while every tool it projected sat
 * at `pending_review` with no way to approve it — so the tests that matter
 * assert the *pipeline*, not just the row. `selectedByWorker` below mirrors
 * the exact where-clause the worker uses to build an agent's toolset
 * (`worker/src/run/mcp-toolset.ts`), so an approval is only "done" here if it
 * would really reach an agent.
 */

type Row = {
  id: string
  organizationId: string
  handlerKind: string
  enabled: boolean
  status: string
  mcpInstanceId: string | null
}

/** The worker's toolset query, restated. Keep in sync with mcp-toolset.ts. */
const selectedByWorker = (row: Row, organizationId: string): boolean =>
  row.organizationId === organizationId
  && row.handlerKind === 'mcp'
  && row.enabled
  && row.status === 'active'

const makePrisma = (rows: Row[], managedInstanceIds: string[] = []) => {
  const prisma = {
    mcpServerInstance: {
      findFirst: async (args: { where: { id: string } }) =>
        managedInstanceIds.includes(args.where.id)
          ? {
              catalogEntry: {
                name: 'deep-water',
                organizationId: null,
                visibility: 'public',
                integratedProducts: [{ slug: 'deep-water' }],
              },
            }
          : null,
    },
    toolRegistryEntry: {
      findMany: async (args: {
        where: {
          handlerKind: string
          id: { in: string[] }
          organizationId: string
        }
      }) =>
        rows.filter(
          (row) =>
            row.handlerKind === args.where.handlerKind
            && args.where.id.in.includes(row.id)
            && row.organizationId === args.where.organizationId,
        ),
      updateMany: async (args: {
        data: { status: string }
        where: { id: { in: string[] }; organizationId: string }
      }) => {
        let count = 0
        for (const row of rows) {
          if (
            args.where.id.in.includes(row.id)
            && row.organizationId === args.where.organizationId
          ) {
            row.status = args.data.status
            count += 1
          }
        }
        return { count }
      },
    },
  } as unknown as PrismaClient
  return prisma
}

const sharedScopeRow = (id: string, instanceId = 'inst-1'): Row => ({
  enabled: true,
  handlerKind: 'mcp',
  id,
  mcpInstanceId: instanceId,
  organizationId: 'org-A',
  status: 'pending_review',
})

test('approval is what makes a shared-scope tool reachable by the worker', async () => {
  const rows = [sharedScopeRow('11111111-1111-4111-8111-111111111111')]
  const prisma = makePrisma(rows)

  // Precondition: the projection's gate really does hide it from agents.
  assert.equal(selectedByWorker(rows[0]!, 'org-A'), false)

  const result = await setToolRegistryEntriesStatus(prisma, {
    organizationId: 'org-A',
    status: 'active',
    toolRegistryEntryIds: [rows[0]!.id],
  })

  assert.deepEqual(result, { status: 'active', updatedIds: [rows[0]!.id] })
  assert.equal(selectedByWorker(rows[0]!, 'org-A'), true)
})

test('disabling takes a tool back out of the worker toolset', async () => {
  const rows = [sharedScopeRow('22222222-2222-4222-8222-222222222222')]
  rows[0]!.status = 'active'
  const prisma = makePrisma(rows)

  await setToolRegistryEntriesStatus(prisma, {
    organizationId: 'org-A',
    status: 'disabled',
    toolRegistryEntryIds: [rows[0]!.id],
  })

  assert.equal(selectedByWorker(rows[0]!, 'org-A'), false)
})

test('a connector\'s tools approve as one batch', async () => {
  const rows = [
    sharedScopeRow('33333333-3333-4333-8333-333333333331'),
    sharedScopeRow('33333333-3333-4333-8333-333333333332'),
    sharedScopeRow('33333333-3333-4333-8333-333333333333'),
  ]
  const prisma = makePrisma(rows)

  const result = await setToolRegistryEntriesStatus(prisma, {
    organizationId: 'org-A',
    status: 'active',
    toolRegistryEntryIds: rows.map((row) => row.id),
  })

  assert.equal(result.updatedIds.length, 3)
  assert.ok(rows.every((row) => selectedByWorker(row, 'org-A')))
})

test('an unapproved tool stays unapproved when it is not in the batch', async () => {
  const approved = sharedScopeRow('44444444-4444-4444-8444-444444444441')
  const skipped = sharedScopeRow('44444444-4444-4444-8444-444444444442')
  const prisma = makePrisma([approved, skipped])

  await setToolRegistryEntriesStatus(prisma, {
    organizationId: 'org-A',
    status: 'active',
    toolRegistryEntryIds: [approved.id],
  })

  // The destructive tool a reviewer deliberately unchecked must not ride along.
  assert.equal(skipped.status, 'pending_review')
  assert.equal(selectedByWorker(skipped, 'org-A'), false)
})

test('ids from another organization are refused for the whole set', async () => {
  const mine = sharedScopeRow('55555555-5555-4555-8555-555555555551')
  const theirs: Row = {
    ...sharedScopeRow('55555555-5555-4555-8555-555555555552'),
    organizationId: 'org-B',
  }
  const prisma = makePrisma([mine, theirs])

  await assert.rejects(
    () =>
      setToolRegistryEntriesStatus(prisma, {
        organizationId: 'org-A',
        status: 'active',
        toolRegistryEntryIds: [mine.id, theirs.id],
      }),
    /MCP_TOOL_REVIEW_NOT_REVIEWABLE|Every id must reference/,
  )
  // All-or-nothing: the in-scope row must not have been quietly approved.
  assert.equal(mine.status, 'pending_review')
})

test('first-party integration projections are refused', async () => {
  const row = sharedScopeRow('66666666-6666-4666-8666-666666666666', 'managed-1')
  const prisma = makePrisma([row], ['managed-1'])

  await assert.rejects(
    () =>
      setToolRegistryEntriesStatus(prisma, {
        organizationId: 'org-A',
        status: 'active',
        toolRegistryEntryIds: [row.id],
      }),
    (error: unknown) =>
      (error as { code?: string }).code
        === MCP_INSTANCE_ERROR_CODES.MANAGED_BY_INTEGRATION,
  )
  assert.equal(row.status, 'pending_review')
})

test('the request schema refuses pending_review as a verdict', () => {
  const id = '77777777-7777-4777-8777-777777777777'
  assert.equal(
    SetToolRegistryStatusRequestSchema.safeParse({
      status: 'pending_review',
      toolRegistryEntryIds: [id],
    }).success,
    false,
  )
  assert.equal(
    SetToolRegistryStatusRequestSchema.safeParse({
      status: 'active',
      toolRegistryEntryIds: [id],
    }).success,
    true,
  )
})

test('the request schema refuses an empty or non-uuid id list', () => {
  assert.equal(
    SetToolRegistryStatusRequestSchema.safeParse({
      status: 'active',
      toolRegistryEntryIds: [],
    }).success,
    false,
  )
  assert.equal(
    SetToolRegistryStatusRequestSchema.safeParse({
      status: 'active',
      toolRegistryEntryIds: ['not-a-uuid'],
    }).success,
    false,
  )
})
