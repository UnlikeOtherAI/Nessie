import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  approvalVisibilityWhere,
  getApprovalRequest,
  getPendingApprovalCount,
  listApprovalRequests,
} from '../src/services/approvals.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const memberId = '00000000-0000-4000-8000-000000000002'
const ownerId = '00000000-0000-4000-8000-000000000003'
const requesterId = '00000000-0000-4000-8000-000000000004'
const privateChannelId = '00000000-0000-4000-8000-000000000005'

const actorCtx = (actorId: string, roles: string[] = []): AuthorizedActionContext =>
  ({
    actor: { actorType: 'user', actorId, roles },
    tenant: { organizationId },
  }) as unknown as AuthorizedActionContext

/**
 * An approval row plus the channel facts the gate needs. `visibleTo` stands in
 * for the channel-membership subquery Postgres would run.
 */
type Row = {
  id: string
  organizationId: string
  channelId: string | null
  requesterId: string
  status: string
  reason: string
  taskId: string | null
  agentId: string
  visibleTo: string[]
  channelIsPublic: boolean
  createdAt: Date
  expiresAt: Date
  resolverId: string | null
  resolvedAt: Date | null
  resolution: string | null
  resolutionNote: string | null
  requiredApproverUserId: string | null
  requiredApproverRole: string | null
  continuationToken: string
  context: unknown
  action: string
  projectId: string | null
  teamId: string | null
  toolName: string | null
  runId: string | null
  updatedAt: Date
}

const makeRow = (overrides: Partial<Row> = {}): Row => ({
  id: overrides.id ?? 'approval-1',
  organizationId: overrides.organizationId ?? organizationId,
  channelId: overrides.channelId ?? null,
  requesterId: overrides.requesterId ?? requesterId,
  status: overrides.status ?? 'pending',
  reason: overrides.reason ?? 'Agent wants to send an email',
  taskId: overrides.taskId ?? null,
  agentId: overrides.agentId ?? '00000000-0000-4000-8000-0000000000a0',
  visibleTo: overrides.visibleTo ?? [],
  channelIsPublic: overrides.channelIsPublic ?? false,
  createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  expiresAt: overrides.expiresAt ?? new Date('2036-01-01T00:00:00Z'),
  resolverId: null,
  resolvedAt: null,
  resolution: null,
  resolutionNote: null,
  requiredApproverUserId: overrides.requiredApproverUserId ?? null,
  requiredApproverRole: null,
  continuationToken: 'token',
  context: null,
  action: 'send_email',
  projectId: null,
  teamId: null,
  toolName: overrides.toolName ?? null,
  runId: null,
  updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
})

// Evaluate the `where` the service builds against an in-memory row, mirroring
// how Postgres would resolve the channel-membership subquery.
const matches = (row: Row, where: Record<string, unknown>): boolean => {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND') {
      const clauses = value as Array<Record<string, unknown>>
      if (!clauses.every((clause) => matches(row, clause))) return false
      continue
    }
    if (key === 'OR') {
      const clauses = value as Array<Record<string, unknown>>
      if (!clauses.some((clause) => matches(row, clause))) return false
      continue
    }
    if (key === 'channel') {
      const clause = value as { OR?: Array<Record<string, unknown>> }
      const alternatives = clause.OR ?? []
      const ok = alternatives.some((alternative) => {
        if ('visibility' in alternative) {
          return row.channelId !== null && row.channelIsPublic
        }
        const membership = alternative.members as
          | { some?: { userId?: string } }
          | undefined
        const wantedUser = membership?.some?.userId
        return (
          row.channelId !== null
          && wantedUser !== undefined
          && row.visibleTo.includes(wantedUser)
        )
      })
      if (!ok) return false
      continue
    }
    if ((row as unknown as Record<string, unknown>)[key] !== value) return false
  }
  return true
}

const makePrisma = (rows: Row[]): PrismaClient =>
  ({
    approvalRequest: {
      findMany: async ({ where }: { where: Prisma.ApprovalRequestWhereInput }) =>
        rows.filter((row) => matches(row, where as Record<string, unknown>)),
      findFirst: async ({ where }: { where: Prisma.ApprovalRequestWhereInput }) =>
        rows.find((row) => matches(row, where as Record<string, unknown>)) ?? null,
      count: async ({ where }: { where: Prisma.ApprovalRequestWhereInput }) =>
        rows.filter((row) => matches(row, where as Record<string, unknown>)).length,
    },
  }) as unknown as PrismaClient

test('an owner has ordinary visibility over unpinned approvals', () => {
  const where = approvalVisibilityWhere(actorCtx(ownerId, ['owner']))
  assert.equal(matches(makeRow(), where as Record<string, unknown>), true)
})

test('a member does not see a private-channel approval they are not part of', async () => {
  const prisma = makePrisma([
    makeRow({ id: 'private', channelId: privateChannelId, visibleTo: [requesterId] }),
  ])
  const result = await listApprovalRequests(prisma, actorCtx(memberId))
  assert.deepEqual(result.data, [])
})

test('a member sees an approval in a private channel they belong to', async () => {
  const prisma = makePrisma([
    makeRow({ id: 'private', channelId: privateChannelId, visibleTo: [memberId] }),
  ])
  const result = await listApprovalRequests(prisma, actorCtx(memberId))
  assert.deepEqual(result.data.map((entry) => entry.id), ['private'])
})

test('a member sees an approval in a public channel', async () => {
  const prisma = makePrisma([
    makeRow({ id: 'public', channelId: privateChannelId, channelIsPublic: true }),
  ])
  const result = await listApprovalRequests(prisma, actorCtx(memberId))
  assert.deepEqual(result.data.map((entry) => entry.id), ['public'])
})

test('a member sees an approval they requested even without a channel', async () => {
  const prisma = makePrisma([
    makeRow({ id: 'mine', channelId: null, requesterId: memberId }),
  ])
  const result = await listApprovalRequests(prisma, actorCtx(memberId))
  assert.deepEqual(result.data.map((entry) => entry.id), ['mine'])
})

test('a channel-less approval requested by someone else stays hidden', async () => {
  const prisma = makePrisma([makeRow({ id: 'theirs', channelId: null })])
  const result = await listApprovalRequests(prisma, actorCtx(memberId))
  assert.deepEqual(result.data, [])
})

test('an owner sees a private-channel approval they are not a member of', async () => {
  const prisma = makePrisma([
    makeRow({ id: 'private', channelId: privateChannelId, visibleTo: [requesterId] }),
  ])
  const result = await listApprovalRequests(prisma, actorCtx(ownerId, ['owner']))
  assert.deepEqual(result.data.map((entry) => entry.id), ['private'])
})

test('a pinned approval is visible only to its exact approver', async () => {
  const prisma = makePrisma([
    makeRow({
      channelId: privateChannelId,
      channelIsPublic: true,
      requiredApproverUserId: memberId,
      visibleTo: [ownerId, requesterId],
    }),
  ])
  assert.deepEqual((await listApprovalRequests(prisma, actorCtx(memberId))).data.map((row) => row.id), ['approval-1'])
  assert.deepEqual((await listApprovalRequests(prisma, actorCtx(ownerId, ['owner']))).data, [])
  assert.deepEqual((await listApprovalRequests(prisma, actorCtx(requesterId))).data, [])
  assert.equal((await getApprovalRequest(prisma, 'approval-1', actorCtx(ownerId, ['owner']))), null)
  assert.equal((await getApprovalRequest(prisma, 'approval-1', actorCtx(memberId)))?.id, 'approval-1')
  assert.equal(await getPendingApprovalCount(prisma, actorCtx(ownerId, ['owner'])), 0)
  assert.equal(await getPendingApprovalCount(prisma, actorCtx(memberId)), 1)
})

test('fetching an inaccessible approval by id returns null, not its reason', async () => {
  const prisma = makePrisma([
    makeRow({ id: 'private', channelId: privateChannelId, visibleTo: [requesterId] }),
  ])
  assert.equal(await getApprovalRequest(prisma, 'private', actorCtx(memberId)), null)
  assert.equal(
    (await getApprovalRequest(prisma, 'private', actorCtx(ownerId, ['owner'])))?.id,
    'private',
  )
})

test('a pinned approval is hidden from channel members and owners other than its approver', async () => {
  const prisma = makePrisma([
    makeRow({
      id: 'pinned',
      channelId: privateChannelId,
      channelIsPublic: true,
      context: { inputSummary: 'bcc: private@example.test; body: not for the channel' },
      requiredApproverUserId: requesterId,
    }),
  ])

  assert.deepEqual((await listApprovalRequests(prisma, actorCtx(memberId))).data, [])
  assert.deepEqual((await listApprovalRequests(prisma, actorCtx(ownerId, ['owner']))).data, [])
  assert.equal(await getApprovalRequest(prisma, 'pinned', actorCtx(memberId)), null)
  assert.equal(await getApprovalRequest(prisma, 'pinned', actorCtx(ownerId, ['owner'])), null)
  assert.equal(
    (await getApprovalRequest(prisma, 'pinned', actorCtx(requesterId)))?.id,
    'pinned',
  )
})

test('the pending count excludes approvals the actor cannot see', async () => {
  const prisma = makePrisma([
    makeRow({ id: 'hidden', channelId: privateChannelId, visibleTo: [requesterId] }),
    makeRow({ id: 'mine', channelId: null, requesterId: memberId }),
  ])
  assert.equal(await getPendingApprovalCount(prisma, actorCtx(memberId)), 1)
  assert.equal(await getPendingApprovalCount(prisma, actorCtx(ownerId, ['owner'])), 2)
})

test('a mail proposal never reaches approval list or detail presentation', async () => {
  const recipient = 'recipient@example.com'
  const body = 'This body belongs only to the mailbox approver.'
  const prisma = makePrisma([
    makeRow({
      reason: 'Send the private renewal to recipient@example.com: this body must not be shown.',
      context: {
        headline: 'Send “Private subject” from a connected mailbox',
        inputSummary: JSON.stringify({ subject: 'Private subject', text: body, to: [recipient] }),
      },
      requiredApproverUserId: memberId,
      toolName: 'mailbox_send',
    }),
  ])

  const listed = await listApprovalRequests(prisma, actorCtx(memberId))
  const detail = await getApprovalRequest(prisma, 'approval-1', actorCtx(memberId))
  assert.deepEqual(listed.data[0]?.context, {
    audience: 'The recipients will receive it',
    headline: 'Send an email from a connected mailbox',
    toolName: 'mailbox_send',
  })
  assert.deepEqual(detail?.context, listed.data[0]?.context)
  assert.doesNotMatch(
    JSON.stringify({ detail, listed }),
    new RegExp(`${recipient}|${body}|Private subject|private renewal`),
  )
  assert.equal(detail?.reason, 'Review the email before deciding whether to send it.')
  // The privacy projection does not fork the exact-approver list/count rule.
  assert.equal(await getPendingApprovalCount(prisma, actorCtx(memberId)), 1)
})
