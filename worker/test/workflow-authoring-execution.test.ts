import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  runWorkflowCreateTool,
  runWorkflowInstallTool,
  runWorkflowListTool,
  runWorkflowTriggerCreateTool,
} from '../src/run/pa-tools/workflow-authoring.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

const organizationId = randomUUID()
const userId = randomUUID()
const workflowTemplateId = randomUUID()
const workflowInstallationId = randomUUID()

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
        source: 'authored',
        version: 1,
      }),
      findMany: async () => [],
    },
    workflowInstallation: {
      create: async () => ({
        id: workflowInstallationId,
        status: 'active',
        workflowTemplateVersion: 1,
      }),
      findFirst: async () => ({ id: workflowInstallationId }),
      findUnique: async () => ({ id: workflowInstallationId }),
      groupBy: async () => [],
    },
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
      channel: { organizationId },
      prisma,
    } as unknown as BuiltinToolRuntimeContext,
  }
}

test('an owner agent can create, install, and schedule a workflow', async () => {
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
    'workflow.installation.installed',
    'workflow.trigger.created',
  ])
})
