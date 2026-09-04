import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  updateWorkflowTemplateForActor,
  WorkflowTemplateVersionConflictError,
} from '@nessie/team-admin'

import {
  runWorkflowRunStatusTool,
  runWorkflowRunTool,
} from '../src/run/pa-tools/workflow-authoring.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

const organizationId = randomUUID()
const delegatedUserId = randomUUID()
const delegatedAgentId = randomUUID()
const workflowInstallationId = randomUUID()
const workflowRunId = randomUUID()
const channelId = randomUUID()
const threadId = randomUUID()
const messageId = randomUUID()

const createDelegatedContext = (input: {
  active?: boolean
  activeRuns?: number
  installationVisible?: boolean
} = {}) => {
  const active = input.active ?? true
  const activeRuns = input.activeRuns ?? 0
  const installationVisible = input.installationVisible ?? true
  const writes: { auditActorId?: string; runActorId?: string } = {}
  const prisma = {
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: 'member' }),
    },
    workflowInstallation: {
      findFirst: async ({ where }: { where: { active?: boolean } }) => {
        if (!installationVisible || (where.active && !active)) return null
        return {
          channelId,
          concurrency: {},
          id: workflowInstallationId,
          organizationId,
        }
      },
      findUnique: async () => ({
        id: workflowInstallationId,
        pinnedGraphJson: { steps: [] },
        workflowTemplate: { graphJson: { steps: [] } },
      }),
    },
    workflowRun: {
      count: async () => activeRuns,
      create: async ({ data }: { data: { startedByActorId: string } }) => {
        writes.runActorId = data.startedByActorId
        return { id: workflowRunId, status: 'pending' }
      },
      findFirst: async () => ({
        id: workflowRunId,
        installationId: workflowInstallationId,
        status: 'running',
      }),
    },
    workflowStepRun: {
      findMany: async () => [{
        errorMessage: 'credential=secret-value',
        status: 'running',
        stepKey: 'read',
        title: 'Read state',
      }],
    },
    channel: {
      findFirst: async () => ({ id: channelId, members: [{ id: randomUUID() }], visibility: 'protected' }),
    },
    thread: { findFirst: async () => ({ channelId }) },
    message: { findFirst: async () => ({ threadId }) },
    auditLog: {
      create: async ({ data }: { data: { actorId: string } }) => {
        writes.auditActorId = data.actorId
        return data
      },
      findFirst: async () => null,
    },
    $executeRaw: async () => 0,
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  }

  return {
    context: {
      actorContext: {
        actionContext: { effectiveUserId: delegatedUserId },
        actor: { actorId: delegatedAgentId, actorType: 'agent', roles: [] },
        tenant: { organizationId },
      },
      agentId: delegatedAgentId,
      channel: { id: channelId, organizationId },
      prisma,
      run: { id: randomUUID(), messageId, threadId },
    } as unknown as BuiltinToolRuntimeContext,
    writes,
  }
}

test('a delegated member starts and reads a workflow as the effective user without error disclosure', async () => {
  const { context, writes } = createDelegatedContext()

  await runWorkflowRunTool(context, { workflowInstallationId })
  const status = await runWorkflowRunStatusTool(context, { workflowRunId })

  assert.equal(writes.runActorId, delegatedUserId)
  assert.equal(writes.auditActorId, delegatedUserId)
  assert.match(status.outputPreview, /Read state: running/)
  assert.doesNotMatch(status.outputPreview, /secret-value/)
})

test('workflow run tool rejects inactive, inaccessible, and overlap-skipped installations', async () => {
  await assert.rejects(
    () => runWorkflowRunTool(createDelegatedContext({ active: false }).context, { workflowInstallationId }),
    /not active/,
  )
  await assert.rejects(
    () => runWorkflowRunTool(createDelegatedContext({ installationVisible: false }).context, { workflowInstallationId }),
    /not found/,
  )
  await assert.rejects(
    () => runWorkflowRunTool(createDelegatedContext({ activeRuns: 1 }).context, { workflowInstallationId }),
    /overlap policy is at capacity/,
  )
})

test('template updates use the expected version in their atomic mutation', async () => {
  const workflowTemplateId = randomUUID()
  let version = 1
  let updateWhere: { version?: number } | undefined
  const prisma = {
    executionEnvironmentTemplate: { count: async () => 0 },
    workflowTemplate: {
      findFirst: async ({ select }: { select?: { version: true } }) =>
        select ? { version } : { id: workflowTemplateId, name: 'Versioned', version },
      updateMany: async ({ where }: { where: { version?: number } }) => {
        updateWhere = where
        if (where.version !== version) return { count: 0 }
        version += 1
        return { count: 1 }
      },
    },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  }
  const actorContext = {
    actionContext: {},
    actor: { actorId: delegatedUserId, actorType: 'user' as const, roles: ['owner'] },
    tenant: { organizationId },
  }
  const input = {
    graph: { steps: [{ id: 'read', input: { toolName: 'state_get' }, type: 'tool_call' }] },
    name: 'Versioned',
  }

  const updated = await updateWorkflowTemplateForActor(
    prisma as never,
    actorContext,
    workflowTemplateId,
    input,
    1,
  )
  assert.equal(updateWhere?.version, 1)
  assert.equal(updated?.version, 2)

  await assert.rejects(
    () => updateWorkflowTemplateForActor(prisma as never, actorContext, workflowTemplateId, input, 1),
    WorkflowTemplateVersionConflictError,
  )
})
