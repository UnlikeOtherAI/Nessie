import type { Prisma } from '@prisma/client'
import {
  auditWorkflowMutation,
  canActorReadWorkflowRun,
  canActorStartWorkflowRun,
  createWorkflowTrigger,
  createWorkflowTemplateForActor,
  installWorkflowTemplateForActor,
  listWorkflowTemplatesForOrganization,
  startWorkflowRunForActor,
  updateWorkflowTemplateForActor,
} from '@nessie/team-admin'
import {
  AgentTriggerTypeSchema,
  WorkflowPreviewMessageMetadataSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { createAgentMessage } from '../execute/agent-message.js'
import { applyRunReplyBookkeeping } from '../execute/lifecycle.js'
import { publishMessageCreated } from '../execute/realtime.js'
import { requireOwnerMember, resolveActingMember } from './access.js'

const WorkflowGraphSchema = z.object({
  steps: z.array(z.object({
    id: z.string().min(1),
    input: z.record(z.unknown()).optional(),
    title: z.string().optional(),
    type: z.string().min(1),
    when: z.string().optional(),
  })).min(1),
})

const WorkflowTemplateInputSchema = z.object({
  bindingSchema: z.unknown().optional(),
  description: z.string().optional(),
  graph: WorkflowGraphSchema,
  name: z.string().trim().min(1),
  requiredEnvironmentTemplateIds: z.array(z.string().uuid()).optional(),
  variableSchema: z.unknown().optional(),
})

const WorkflowTemplateUpdateInputSchema = WorkflowTemplateInputSchema.extend({
  expectedVersion: z.number().int().positive().optional(),
  workflowTemplateId: z.string().uuid(),
})

const WorkflowInstallInputSchema = z.object({
  active: z.boolean().optional(),
  channelId: z.string().uuid().optional(),
  concurrency: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
  resolvedBindings: z.record(z.unknown()).optional(),
  status: z.enum(['active', 'draft', 'paused', 'disabled']).optional(),
  workflowTemplateId: z.string().uuid(),
})

const WorkflowTriggerInputSchema = z.object({
  config: z.record(z.unknown()).optional(),
  description: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  name: z.string().min(1).optional(),
  nextRunAt: z.string().datetime({ offset: true }).optional(),
  type: AgentTriggerTypeSchema,
  workflowInstallationId: z.string().uuid(),
})

const WorkflowPreviewInputSchema = z.object({
  workflowTemplateId: z.string().uuid(),
})

const WorkflowRunInputSchema = z.object({
  input: z.record(z.unknown()).optional(),
  workflowInstallationId: z.string().uuid(),
})

const WorkflowRunStatusInputSchema = z.object({
  workflowRunId: z.string().uuid(),
})

const WorkflowListInputSchema = z.object({
  cursor: z.string().optional(),
  direction: z.enum(['backward', 'forward']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

/**
 * Agent workflow authoring follows the same graph validator, environment
 * reference checks, and owner boundary as the Admin workflow routes. A graph
 * only defines execution steps; install it and create a trigger separately so
 * a schedule is never silently materialized from a canvas marker.
 */
export const runWorkflowCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = WorkflowTemplateInputSchema.parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'create a workflow')
  const workflow = await createWorkflowTemplateForActor(
    context.prisma,
    member.actorContext,
    args,
  )
  await auditWorkflowMutation(context.prisma, member.actorContext, {
    action: 'workflow.template.created',
    metadata: { name: workflow.name },
    resourceId: workflow.id,
    resourceType: 'workflow_template',
  })

  return {
    inputSummary: `name="${workflow.name}"; steps=${args.graph.steps.length}`,
    outputPreview: [
      `Created workflow "${workflow.name}" (version ${workflow.version}).`,
      `workflowTemplateId=${workflow.id}`,
      `Admin: /agents/workflow-designer/${workflow.id}`,
      'Install it with workflow_install before creating a workflow trigger.',
    ].join('\n'),
    toolName: 'workflow_create',
  }
}

export const runWorkflowUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = WorkflowTemplateUpdateInputSchema.parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'update a workflow')
  const { expectedVersion, workflowTemplateId, ...templateInput } = args
  const workflow = await updateWorkflowTemplateForActor(
    context.prisma,
    member.actorContext,
    workflowTemplateId,
    templateInput,
    expectedVersion,
  )
  if (!workflow) throw new Error('Workflow template not found.')
  await auditWorkflowMutation(context.prisma, member.actorContext, {
    action: 'workflow.template.updated',
    metadata: { name: workflow.name, version: workflow.version },
    resourceId: workflow.id,
    resourceType: 'workflow_template',
  })

  return {
    inputSummary: `workflowTemplateId=${workflow.id}; version=${workflow.version}`,
    outputPreview: [
      `Updated workflow "${workflow.name}" (version ${workflow.version}).`,
      `workflowTemplateId=${workflow.id}`,
      `Admin: /agents/workflow-designer/${workflow.id}`,
    ].join('\n'),
    toolName: 'workflow_update',
  }
}

/** The owner-visible picker for workflow_install and workflow_preview. */
export const runWorkflowListTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = WorkflowListInputSchema.parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'list workflows')
  const page = await listWorkflowTemplatesForOrganization(
    context.prisma,
    member.organizationId,
    args,
  )

  return {
    inputSummary: `limit=${args.limit ?? 25}`,
    outputPreview: page.data.length === 0
      ? 'No workflows exist in this organization.'
      : page.data.map(({ template, installationSummary }) =>
        `${template.name} | workflowTemplateId=${template.id} | version=${template.version} | installations=${installationSummary.active}/${installationSummary.total}`,
      ).join('\n'),
    toolName: 'workflow_list',
  }
}

export const runWorkflowInstallTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = WorkflowInstallInputSchema.parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'install a workflow')
  const created = await installWorkflowTemplateForActor(
    context.prisma,
    member.actorContext,
    args.workflowTemplateId,
    args,
  )
  if (!created) throw new Error('Workflow template not found.')
  const installation = created.installation
  await auditWorkflowMutation(context.prisma, member.actorContext, {
    action: 'workflow.installation.installed',
    metadata: { workflowTemplateId: args.workflowTemplateId },
    resourceId: installation.id,
    resourceType: 'workflow_installation',
    status: installation.status,
  })

  return {
    inputSummary: `workflowTemplateId=${args.workflowTemplateId}`,
    outputPreview: [
      `Installed workflow (template version ${installation.workflowTemplateVersion}).`,
      `workflowInstallationId=${installation.id} | status=${installation.status}`,
      'Create its manual, one-off, cron, interval, webhook, or event trigger with workflow_trigger_create.',
    ].join('\n'),
    toolName: 'workflow_install',
  }
}

export const runWorkflowTriggerCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = WorkflowTriggerInputSchema.parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'create a workflow trigger')

  const installation = await context.prisma.workflowInstallation.findFirst({
    where: { id: args.workflowInstallationId, organizationId: member.organizationId },
    select: { id: true },
  })
  if (!installation) throw new Error('Workflow installation not found.')

  const trigger = await createWorkflowTrigger(context.prisma, installation.id, args)
  if (!trigger) {
    throw new Error('Trigger configuration is invalid. Check the schedule or interval settings.')
  }
  await auditWorkflowMutation(context.prisma, member.actorContext, {
    action: 'workflow.trigger.created',
    metadata: { workflowInstallationId: installation.id },
    resourceId: trigger.id,
    resourceType: 'workflow_trigger',
    status: trigger.status,
  })

  return {
    inputSummary: `workflowInstallationId=${installation.id}; type=${trigger.type}`,
    outputPreview: [
      `Created ${trigger.type} workflow trigger${trigger.name ? ` "${trigger.name}"` : ''}.`,
      `triggerId=${trigger.id} | status=${trigger.status}`
      + (trigger.nextRunAt ? ` | next run ${trigger.nextRunAt}` : ''),
      ...(trigger.webhookApiKey
        ? ['A webhook key was generated; retrieve it from the Triggers page rather than chat.']
        : []),
    ].join('\n'),
    toolName: 'workflow_trigger_create',
  }
}

/**
 * Posts a server-stamped pointer rather than a copied graph. The chat renderer
 * reads the current template under each viewer's own workflow-admin access and
 * expands the same read-only canvas used by the designer.
 */
export const runWorkflowPreviewTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = WorkflowPreviewInputSchema.parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'share a workflow preview')
  const runContext = context.runContext
  if (!runContext) throw new Error('Unable to resolve the current conversation.')

  const workflow = await context.prisma.workflowTemplate.findFirst({
    where: { id: args.workflowTemplateId, organizationId: member.organizationId },
    select: { id: true, name: true },
  })
  if (!workflow) throw new Error('Workflow template not found.')

  const message = await context.prisma.$transaction(async (tx) => {
    const created = await createAgentMessage(tx, runContext, {
      agentId: context.agentId,
      content: `Workflow preview: ${workflow.name}`,
      role: 'assistant',
      threadId: context.run.threadId,
      ...(runContext.replyRootMessageId
        ? { rootMessageId: runContext.replyRootMessageId }
        : {}),
    })
    await tx.message.update({
      data: {
        metadata: WorkflowPreviewMessageMetadataSchema.parse({
          workflowPreview: { workflowTemplateId: workflow.id },
        }) as Prisma.InputJsonValue,
      },
      where: { id: created.id },
    })
    return created
  })

  const reply = runContext.replyRootMessageId
    ? await applyRunReplyBookkeeping(context.prisma, runContext, message.createdAt)
    : undefined
  await publishMessageCreated(context.realtimeTransport, runContext, {
    content: message.content,
    messageId: message.id,
    role: 'assistant',
    ...(reply ? { reply } : {}),
  })

  return {
    inputSummary: `workflowTemplateId=${workflow.id}`,
    outputPreview: [
      `Posted a live workflow preview for "${workflow.name}".`,
      `messageId=${message.id}`,
      `Admin: /agents/workflow-designer/${workflow.id}`,
    ].join('\n'),
    toolName: 'workflow_preview',
  }
}

/** Mirrors Admin's member-level Run now action, including its overlap gate. */
export const runWorkflowRunTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = WorkflowRunInputSchema.parse(input)
  const member = await resolveActingMember(context)
  if (!(await canActorStartWorkflowRun(
    context.prisma,
    member.actorContext,
    args.workflowInstallationId,
  ))) {
    throw new Error('Workflow installation not found.')
  }
  const workflowRun = await startWorkflowRunForActor(
    context.prisma,
    member.actorContext,
    args.workflowInstallationId,
    {
      input: args.input,
      originChannelId: context.channel.id,
      originMessageId: context.run.messageId,
      originThreadId: context.run.threadId,
      replyRootMessageId: context.runContext?.replyRootMessageId,
    },
  )
  if (!workflowRun) throw new Error('Workflow installation is not active.')
  await auditWorkflowMutation(context.prisma, member.actorContext, {
    action: 'workflow.run.started',
    metadata: { installationId: args.workflowInstallationId },
    resourceId: workflowRun.id,
    resourceType: 'workflow_run',
    status: workflowRun.status,
  })
  return {
    inputSummary: `workflowInstallationId=${args.workflowInstallationId}`,
    outputPreview: [
      `Started workflow run (${workflowRun.status}).`,
      `workflowRunId=${workflowRun.id}`,
      'Use workflow_run_status to follow it.',
    ].join('\n'),
    toolName: 'workflow_run',
  }
}

/** Status-only read: W0-sensitive inputs and outputs stay on the Admin detail. */
export const runWorkflowRunStatusTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = WorkflowRunStatusInputSchema.parse(input)
  const member = await resolveActingMember(context)
  if (!(await canActorReadWorkflowRun(context.prisma, member.actorContext, args.workflowRunId))) {
    throw new Error('Workflow run not found.')
  }
  const workflowRun = await context.prisma.workflowRun.findFirst({
    where: { id: args.workflowRunId, organizationId: member.actorContext.tenant.organizationId },
    select: { id: true, status: true },
  })
  if (!workflowRun) throw new Error('Workflow run not found.')
  const steps = await context.prisma.workflowStepRun.findMany({
    where: { workflowRunId: workflowRun.id },
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
    select: { status: true, stepKey: true, title: true },
  })
  return {
    inputSummary: `workflowRunId=${workflowRun.id}`,
    outputPreview: [
      `Workflow run ${workflowRun.id}: ${workflowRun.status}.`,
      ...steps.map((step) => `${step.title || step.stepKey}: ${step.status}`),
    ].join('\n'),
    toolName: 'workflow_run_status',
  }
}
