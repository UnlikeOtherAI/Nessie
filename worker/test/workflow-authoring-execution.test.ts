import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  runWorkflowCreateTool,
  runWorkflowInstallTool,
  runWorkflowListTool,
  runWorkflowRunStatusTool,
  runWorkflowRunTool,
  runWorkflowTriggerCreateTool,
  runWorkflowUpdateTool,
} from '../src/run/pa-tools/workflow-authoring.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

const organizationId = randomUUID()
const userId = randomUUID()
const workflowTemplateId = randomUUID()
const workflowInstallationId = randomUUID()
const channelId = randomUUID()
const threadId = randomUUID()
const messageId = randomUUID()
const workflowRunId = randomUUID()

const createContext = (): {
  auditActions: string[]
  context: BuiltinToolRuntimeContext
} => {
  const now = new Date('2026-09-04T09:00:00.000Z')
  const auditActions: string[] = []
  const prisma = {
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: 'owner' }),
    },
    executionEnvironmentTemplate: { count: async () => 0 },
    workflowTemplate: {
      count: async () => 0,
      create: async ({ data }: { data: { name: string } }) => ({
        id: workflowTemplateId,
        name: data.name,
        version: 1,
      }),
      findFirst: async () => ({
        adoptedAt: null,
        bindingSchema: {},
        graphJson: { steps: [{ id: 'read', type: 'tool_call', input: { toolName: 'state_get' } }] },
        id: workflowTemplateId,
        name: 'Hourly state check',
        source: 'authored',
        version: 2,
      }),
      findMany: async () => [],
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }: { data: { name: string } }) => ({
        id: workflowTemplateId,
        name: data.name,
        version: 2,
      }),
    },
    workflowInstallation: {
      create: async () => ({
        id: workflowInstallationId,
        status: 'active',
        workflowTemplateVersion: 1,
      }),
      findFirst: async () => ({
        channelId,
        concurrency: {},
        id: workflowInstallationId,
        organizationId,
      }),
      findUnique: async () => ({
        id: workflowInstallationId,
        pinnedGraphJson: { steps: [] },
        workflowTemplate: { graphJson: { steps: [] } },
      }),
      groupBy: async () => [],
    },
    workflowRun: {
      count: async () => 0,
      create: async () => ({ id: workflowRunId, status: 'pending' }),
      findFirst: async () => ({
        errorMessage: null,
        finishedAt: null,
        id: workflowRunId,
        installationId: workflowInstallationId,
        startedAt: now,
        status: 'running',
      }),
    },
    workflowStepRun: {
      findMany: async () => [{
        errorMessage: null,
        status: 'running',
        stepKey: 'read',
        title: 'Read state',
      }],
    },
    channel: { findFirst: async () => ({ id: channelId }) },
    thread: { findFirst: async () => ({ channelId }) },
    message: { findFirst: async () => ({ threadId }) },
    agentTrigger: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        agentId: null,
        config: data.config ?? {},
        createdAt: now,
        description: data.description ?? null,
        enabled: data.enabled ?? true,
        id: randomUUID(),
        lastFiredAt: null,
        name: data.name ?? null,
        nextRunAt: data.nextRunAt ?? null,
        status: data.status ?? 'active',
        targetChannelId: null,
        targetThreadId: null,
        type: data.type,
        updatedAt: now,
        workflowInstallationId: data.workflowInstallationId,
      }),
    },
    auditLog: {
      create: async ({ data }: { data: { action: string } }) => {
        auditActions.push(data.action)
        return data
      },
      findFirst: async () => null,
    },
    $executeRaw: async () => 0,
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  }

  return {
    auditActions,
    context: {
      actorContext: {
        actionContext: {},
        actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
        tenant: { organizationId },
      },
      agentId: randomUUID(),
      channel: { id: channelId, organizationId },
      prisma,
      run: { id: randomUUID(), messageId, threadId },
    } as unknown as BuiltinToolRuntimeContext,
  }
}

test('an owner agent can create, update, install, and schedule a workflow', async () => {
  const { auditActions, context } = createContext()
  const listed = await runWorkflowListTool(context, {})
  assert.match(listed.outputPreview, /No workflows exist/)

  const created = await runWorkflowCreateTool(context, {
    graph: {
      steps: [{ id: 'read', input: { toolName: 'state_get' }, type: 'tool_call' }],
    },
    name: 'Daily state check',
  })
  assert.match(created.outputPreview, new RegExp(`workflowTemplateId=${workflowTemplateId}`))

  const updated = await runWorkflowUpdateTool(context, {
    expectedVersion: 1,
    graph: {
      steps: [{ id: 'read', input: { toolName: 'state_get' }, type: 'tool_call' }],
    },
    name: 'Hourly state check',
    workflowTemplateId,
  })
  assert.match(updated.outputPreview, /Updated workflow "Hourly state check" \(version 2\)/)

  const installed = await runWorkflowInstallTool(context, { workflowTemplateId })
  assert.match(installed.outputPreview, new RegExp(`workflowInstallationId=${workflowInstallationId}`))

  const scheduled = await runWorkflowTriggerCreateTool(context, {
    config: { interval_minutes: 30 },
    type: 'interval',
    workflowInstallationId,
  })
  assert.match(scheduled.outputPreview, /Created interval workflow trigger/)
  assert.match(scheduled.outputPreview, /next run/)
  assert.deepEqual(auditActions, [
    'workflow.template.created',
    'workflow.template.updated',
    'workflow.installation.installed',
    'workflow.trigger.created',
  ])
})

test('an entitled agent can start and inspect a workflow run', async () => {
  const { auditActions, context } = createContext()
  const started = await runWorkflowRunTool(context, {
    input: { release: 'v1.2.3' },
    workflowInstallationId,
  })
  assert.match(started.outputPreview, new RegExp(`workflowRunId=${workflowRunId}`))
  assert.match(started.outputPreview, /workflow_run_status/)

  const status = await runWorkflowRunStatusTool(context, { workflowRunId })
  assert.match(status.outputPreview, /Workflow run .*: running/)
  assert.match(status.outputPreview, /Read state: running/)
  assert.deepEqual(auditActions, ['workflow.run.started'])
})
