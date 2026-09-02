import { loadConfig } from '@nessie/config'
import {
  AgentAvatarBackgroundColorSchema,
  AgentEffortSchema,
  AgentRunLimitsSchema,
} from '@nessie/schemas'
import {
  assertAgentModelSelection,
  ledgerAgentModelCatalogRequestHeaders,
  loadAgentToolCatalog,
  readAgentRecordForActor,
  updateAgentAvatar,
  updateAgentRecord,
  type AgentConfigProjection,
  type AgentToolCatalogEntry,
  type AgentToolCatalogRestrictedEntry,
} from '@nessie/workspace-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember } from './access.js'
import { formatSection } from './tool-output.js'

/**
 * Reading and rewriting an agent's configuration from chat.
 *
 * Each tool calls the very same shared function the Agent Designer page's
 * controls call — `readAgentRecordForActor` for the record the detail page
 * reads out of the entitled list, `updateAgentRecord` / `updateAgentAvatar` for
 * the writes — so the conversation and the form cannot disagree about who may
 * do what. Authority is decided inside those functions, from the agent's
 * ownership state and the live `OrganizationMember` row at call time, and their
 * refusals are already written for a person, so they travel to the model as
 * they are.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D4).
 */

const AgentReadInputSchema = z.object({
  agentId: z.string().uuid(),
})

const describeRunLimits = (
  limits: AgentConfigProjection['runLimits'],
): string => {
  if (!limits) return 'deployment backstop'
  const entries = Object.entries(limits).filter(([, value]) => value !== undefined)
  return entries.length === 0
    ? 'deployment backstop'
    : entries.map(([key, value]) => `${key}=${String(value)}`).join(', ')
}

const describeToolPolicy = (
  policy: AgentConfigProjection['toolPolicy'],
): string => {
  const entries = Object.entries(policy ?? {})
  if (entries.length === 0) return 'defaults only (no explicit entries)'
  const on = entries.filter(([, value]) => value).map(([key]) => key)
  const off = entries.filter(([, value]) => !value).map(([key]) => key)
  return [
    on.length ? `allowed: ${on.join(', ')}` : '',
    off.length ? `denied: ${off.join(', ')}` : '',
  ].filter(Boolean).join(' | ')
}

const describeConfig = (config: AgentConfigProjection): string[] => [
  `name: ${config.name}`,
  `role: ${config.role}`,
  `visibility: ${config.visibility}${config.systemManaged ? ' (Nessie-managed)' : ''}`,
  `owner: ${config.owner
    ? `${config.owner.displayName ?? config.owner.userId} (${config.owner.ownerState})`
    : 'team-owned'}`,
  `model: ${config.model ? `${config.provider ?? '?'}/${config.model}` : 'deployment default'}`,
  `effort: ${config.effort ?? 'medium'}`,
  `run limits: ${describeRunLimits(config.runLimits)}`,
  `to-dos: ${config.todosEnabled ? 'on' : 'off'}`,
  `tool policy: ${describeToolPolicy(config.toolPolicy)}`,
  `instructions:\n${config.systemPrompt?.trim() || '(none)'}`,
]

export const runAgentReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentReadInputSchema.parse(input)
  const member = await resolveActingMember(context)

  const result = await readAgentRecordForActor(context.prisma, {
    agentId: args.agentId,
    isOwner: member.isOwner,
    organizationId: member.organizationId,
    userId: member.userId,
  })
  if (!result) {
    throw new Error('Agent not found, or you cannot reach it.')
  }

  // An agent's full configuration is a scoped source: its instructions can name
  // material the reader is entitled to and a later reader of this reply is not.
  // The `agent:` scope resolves through the shared live agent-visibility
  // predicate, so the person who just read it satisfies it by construction.
  context.consumedSources?.add({ scopeId: args.agentId, scopeType: 'agent' })

  const lines = describeConfig(result.config)
  if (result.record) {
    lines.push(
      `channels: ${result.record.channelIds.length === 0
        ? 'not in any channel'
        : result.record.channelIds.join(', ')}`,
    )
  } else {
    lines.push(
      'This agent is managed by Nessie itself: its configuration is fixed by '
      + 'the deployment, nobody can edit it, and its activity is not readable '
      + 'here.',
    )
  }

  return {
    inputSummary: `agentId=${args.agentId}`,
    outputPreview: formatSection(`Agent "${result.config.name}"`, lines),
    toolName: 'agent_read',
  }
}

const AgentUpdateInputSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  effort: AgentEffortSchema.optional(),
  runLimits: AgentRunLimitsSchema.nullish(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  todosEnabled: z.boolean().optional(),
  ownerUserId: z.string().uuid().nullish(),
})

export const runAgentUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { agentId, ...patch } = AgentUpdateInputSchema.parse(input)
  const member = await resolveActingMember(context)

  // A tool that takes an id ships with the read that resolves it: the same
  // entitlement the Agents list applies, so an agent this person could not have
  // seen is indistinguishable from one that does not exist.
  const existing = await readAgentRecordForActor(context.prisma, {
    agentId,
    isOwner: member.isOwner,
    organizationId: member.organizationId,
    userId: member.userId,
  })
  if (!existing) {
    throw new Error('Agent not found, or you cannot reach it.')
  }
  if (existing.config.systemManaged) {
    // The service refuses this too; saying it here means the person gets an
    // explanation rather than a raw code.
    throw new Error(
      `"${existing.config.name}" is one of Nessie's own built-in agents. It is `
      + 'defined by the deployment, so nobody — including organisation owners — '
      + 'can change its instructions, model or tools.',
    )
  }

  // The resulting pair, validated against the agent's owner-to-be, exactly as
  // `PUT /api/agents/:agentId` validates it: chat cannot point an agent at a
  // model that will fail on its first run, nor at somebody else's personal plan.
  let modelSubscriptionId: string | null | undefined
  if (patch.model !== undefined || patch.provider !== undefined) {
    const stored = await context.prisma.agent.findFirst({
      where: { id: agentId, organizationId: member.organizationId },
      select: { model: true, modelSubscriptionId: true, ownerUserId: true, provider: true },
    })
    const selection = await assertAgentModelSelection(context.prisma, {
      actingUserId: member.userId,
      config: loadConfig().model,
      ...(process.env.LEDGER_PUBLIC_URL
        ? { ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL }
        : {}),
      model: patch.model ?? stored?.model ?? undefined,
      ...(stored?.modelSubscriptionId
        ? { modelSubscriptionId: stored.modelSubscriptionId }
        : {}),
      organizationId: member.organizationId,
      ownerUserId:
        patch.ownerUserId === undefined ? stored?.ownerUserId ?? null : patch.ownerUserId,
      provider: patch.provider ?? stored?.provider ?? undefined,
      requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
        actorContext: member.actorContext,
        ledgerIdentity: context.ledgerIdentity,
      }),
    })
    modelSubscriptionId = selection.modelSubscriptionId
  }

  const agent = await updateAgentRecord(
    context.prisma,
    agentId,
    { organizationId: member.organizationId, userId: member.userId },
    {
      ...patch,
      ...(modelSubscriptionId === undefined ? {} : { modelSubscriptionId }),
      ...(patch.ownerUserId === undefined ? {} : { ownerUserId: patch.ownerUserId }),
      organizationId: member.organizationId,
    },
  )
  if (!agent) {
    throw new Error('Agent not found.')
  }

  const changed = Object.keys(patch).filter(
    (key) => patch[key as keyof typeof patch] !== undefined,
  )
  return {
    inputSummary: `agentId=${agentId} fields=${changed.join(',') || 'none'}`,
    outputPreview: [
      `Updated agent "${agent.name}" (${agent.role})`,
      `changed: ${changed.join(', ') || 'nothing'}`,
      `model=${agent.model ? `${agent.provider ?? '?'}/${agent.model}` : 'deployment default'}`
      + ` | effort=${agent.effort ?? 'medium'}`,
    ].join('\n'),
    toolName: 'agent_update',
  }
}

const AgentToolCatalogInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'query cannot be blank — omit it to see the whole catalogue.')
    .optional(),
})

const describeCatalogEntry = (entry: AgentToolCatalogEntry): string =>
  `- ${entry.label} | key=${entry.key} | ${entry.allowMode ? 'off by default, set true to enable' : 'on by default, set false to disable'}`
  + (entry.requiresTodos ? ' | needs to-dos enabled' : '')
  + `\n  ${entry.summary}`

const RESTRICTION_REASONS: Record<AgentToolCatalogRestrictedEntry['restriction'], string> = {
  explicit_grant:
    'granted only from the owner surfaces (Apps, Integrations) — never from here',
  personal_assistant_only:
    'only a person’s own Personal Assistant may use it; a designed agent cannot',
}

const describeRestrictedEntry = (entry: AgentToolCatalogRestrictedEntry): string =>
  `- ${entry.label} (${entry.key}): ${RESTRICTION_REASONS[entry.restriction]}`

export const runAgentToolCatalogTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentToolCatalogInputSchema.parse(input)
  // Membership is re-read even for a read-only tool: a deactivated person gets
  // nothing, the same refusal the API makes.
  const member = await resolveActingMember(context)

  const catalogue = await loadAgentToolCatalog(context.prisma, {
    organizationId: member.organizationId,
  })

  const needle = args.query?.toLowerCase()
  const matches = <T extends AgentToolCatalogEntry>(entries: T[]): T[] =>
    needle
      ? entries.filter((entry) =>
        entry.label.toLowerCase().includes(needle)
        || entry.key.toLowerCase().includes(needle))
      : entries

  const togglable = matches(catalogue.togglable)
  const restricted = matches(catalogue.restricted)

  const groups = new Map<string, AgentToolCatalogEntry[]>()
  for (const entry of togglable) {
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry])
  }

  const sections = [...groups.entries()].map(([group, entries]) =>
    formatSection(group, entries.map(describeCatalogEntry)))

  return {
    inputSummary: needle ? `query="${args.query}"` : 'all',
    outputPreview: [
      `Tools you can give an agent here (${togglable.length}), `
      + `and ${restricted.length} you cannot.`,
      ...sections,
      formatSection('Not grantable from a conversation', restricted.map(describeRestrictedEntry)),
      catalogue.connectorCount === 0
        ? 'No connected apps are active in this workspace yet — install one from '
          + 'the Apps page to give an agent access to an outside service.'
        : '',
    ].filter(Boolean).join('\n\n'),
    toolName: 'agent_tool_catalog',
  }
}

const AgentAvatarUpdateInputSchema = z.object({
  agentId: z.string().uuid(),
  avatarAttachmentId: z.string().uuid().nullish(),
  avatarBackgroundColor: AgentAvatarBackgroundColorSchema.optional(),
})

export const runAgentAvatarUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentAvatarUpdateInputSchema.parse(input)
  const member = await resolveActingMember(context)

  const agent = await updateAgentAvatar(
    context.prisma,
    args.agentId,
    { organizationId: member.organizationId, userId: member.userId },
    args.avatarAttachmentId ?? null,
    args.avatarBackgroundColor,
  )
  if (!agent) {
    throw new Error('Agent not found.')
  }

  return {
    inputSummary: `agentId=${args.agentId}`,
    outputPreview: args.avatarAttachmentId
      ? `Set the portrait for "${agent.name}".`
      : `Cleared the portrait for "${agent.name}".`,
    toolName: 'agent_avatar_update',
  }
}
