import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorkflowRunFailureDispatchJobPayload } from '@nessie/schemas'
import {
  handleWorkflowRunFailureDispatch,
  resolveWorkflowFailureRecipientIds,
  type WorkflowFailureDispatchPrisma,
} from '../src/control/workflow-failure-dispatch.js'

// W23 — recipients are resolved from live entitlement rows at delivery time:
// the installation creator (still an active org member) and the channel's
// owners. A deactivated creator and a demoted channel manager drop out.

const PAYLOAD: WorkflowRunFailureDispatchJobPayload = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  workflowInstallationId: '00000000-0000-4000-8000-000000000002',
  workflowRunId: '00000000-0000-4000-8000-000000000003',
}

type State = {
  channelMembers: Array<{ channelId: string; role: string; userId: string }>
  installation: {
    channelId: string | null
    createdByActorId: string
    createdByActorType: string
  } | null
  orgMembers: Array<{ deactivatedAt: Date | null; userId: string }>
}

const makeFakePrisma = (state: State): WorkflowFailureDispatchPrisma =>
  ({
    workflowInstallation: {
      findFirst: async () => state.installation,
    },
    organizationMember: {
      findFirst: async ({ where }: { where: { userId: string; deactivatedAt: null } }) =>
        state.orgMembers.find(
          (member) => member.userId === where.userId && member.deactivatedAt === null,
        ) ?? null,
    },
    channelMember: {
      findMany: async ({ where }: { where: { channelId: string; role: string } }) =>
        state.channelMembers.filter(
          (member) => member.channelId === where.channelId && member.role === where.role,
        ),
    },
  }) as unknown as WorkflowFailureDispatchPrisma

test('W23: creator + channel owners are the recipients', async () => {
  const prisma = makeFakePrisma({
    channelMembers: [
      { channelId: 'chan', role: 'owner', userId: 'manager-1' },
      { channelId: 'chan', role: 'member', userId: 'member-1' },
    ],
    installation: {
      channelId: 'chan',
      createdByActorId: 'creator',
      createdByActorType: 'user',
    },
    orgMembers: [{ deactivatedAt: null, userId: 'creator' }],
  })

  const recipients = await resolveWorkflowFailureRecipientIds(prisma, PAYLOAD)
  assert.deepEqual([...recipients].sort(), ['creator', 'manager-1'])
})

test('W23: a deactivated creator and non-owner channel members drop out', async () => {
  const prisma = makeFakePrisma({
    channelMembers: [{ channelId: 'chan', role: 'member', userId: 'member-1' }],
    installation: {
      channelId: 'chan',
      createdByActorId: 'creator',
      createdByActorType: 'user',
    },
    orgMembers: [{ deactivatedAt: new Date(), userId: 'creator' }],
  })

  const recipients = await resolveWorkflowFailureRecipientIds(prisma, PAYLOAD)
  assert.deepEqual(recipients, [])
})

test('W23: a missing installation notifies nobody', async () => {
  const prisma = makeFakePrisma({
    channelMembers: [],
    installation: null,
    orgMembers: [],
  })

  const recipients = await resolveWorkflowFailureRecipientIds(prisma, PAYLOAD)
  assert.deepEqual(recipients, [])
})

test('finding 13: failure writes one durable alert per entitled recipient without devices', async () => {
  const eventKeys = new Set<string>()
  const written: Array<{ eventKey: string; userId: string; workflowRunId: string }> = []
  const prisma = {
    ...makeFakePrisma({
      channelMembers: [],
      installation: { channelId: null, createdByActorId: 'creator', createdByActorType: 'user' },
      orgMembers: [{ deactivatedAt: null, userId: 'creator' }],
    }),
    workflowRun: {
      findFirst: async () => ({
        id: PAYLOAD.workflowRunId,
        installation: { channelId: null, workflowTemplate: { name: 'Daily briefing' } },
      }),
    },
    user: {
      findMany: async () => [{ id: 'creator', preferences: {} }],
    },
    userAlert: {
      createMany: async ({ data }: { data: Array<{ eventKey: string; userId: string; workflowRunId: string }> }) => {
        for (const row of data) {
          if (!eventKeys.has(`${row.userId}:${row.eventKey}`)) {
            eventKeys.add(`${row.userId}:${row.eventKey}`)
            written.push(row)
          }
        }
        return { count: written.length }
      },
    },
    pushCredential: { findMany: async () => [] },
  } as unknown as WorkflowFailureDispatchPrisma

  await handleWorkflowRunFailureDispatch({ authSecret: 'test', prisma }, PAYLOAD)
  await handleWorkflowRunFailureDispatch({ authSecret: 'test', prisma }, PAYLOAD)

  assert.deepEqual(written, [{
    channelId: null,
    eventKey: `workflow-run-failure:${PAYLOAD.workflowRunId}`,
    kind: 'workflow_run_failed',
    organizationId: PAYLOAD.organizationId,
    userId: 'creator',
    workflowRunId: PAYLOAD.workflowRunId,
  }])
})

test('finding 13: revocation before delivery writes no workflow-failure alert', async () => {
  let wrote = false
  const prisma = {
    ...makeFakePrisma({
      channelMembers: [],
      installation: { channelId: null, createdByActorId: 'creator', createdByActorType: 'user' },
      orgMembers: [{ deactivatedAt: new Date(), userId: 'creator' }],
    }),
    workflowRun: {
      findFirst: async () => ({
        id: PAYLOAD.workflowRunId,
        installation: { channelId: null, workflowTemplate: { name: 'Daily briefing' } },
      }),
    },
    userAlert: { createMany: async () => { wrote = true; return { count: 1 } } },
    user: { findMany: async () => [] },
  } as unknown as WorkflowFailureDispatchPrisma

  await handleWorkflowRunFailureDispatch({ authSecret: 'test', prisma }, PAYLOAD)

  assert.equal(wrote, false)
})
