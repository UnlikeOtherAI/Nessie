import { loadConfig } from '@nessie/config'
import { loadLedgerIdentitySettings } from '@nessie/runtime'
import {
  AgentEffortSchema,
  AgentRunLimitsSchema,
  AgentVisibilitySchema,
  CreateAgentTriggerBodySchema,
  parseUserId,
  type ChannelRecord,
} from '@nessie/schemas'
import {
  AGENT_BINDING_ERROR_CODES,
  AgentBindingError,
  assertAgentModelSelection,
  bindAgentToChannel,
  checkPolicy,
  createAgentRecord,
  createAgentTrigger,
  createChannelForUser,
  getChannelIfMember,
  isAgentAccessibleToActor,
  ledgerAgentModelCatalogRequestHeaders,
  listAgentsForUser,
} from '@nessie/workspace-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireOwnerMember, resolveActingMember } from './access.js'
import { recordChannelDirectoryRead, recordVisibleAgentRead } from './message-search-basis.js'
import { formatSection } from './tool-output.js'

/**
 * Workspace provisioning from chat: list the agents you can see, create a
 * channel, create an agent, bind an agent to a channel, arm a trigger.
 *
 * Each tool calls the very same service function its REST route calls and
 * reproduces that route's authorization exactly — no weaker, no stronger.
 * `GET /api/agents`, `POST /api/channels` and `POST /api/agents` carry only
 * `requireActorContext`, so those three are open to any active member;
 * bindings and triggers are owner-gated, and bindings additionally require
 * channel membership, refuse every system-managed conversation (the Personal
 * Assistant's DM, an external agent's, a global agent's home), and pass the
 * `agent`/`bind` policy check.
 *
 * Disclosure: `agent_list` is the only read here, and it stamps its scopes (see
 * below). `channel_create`, `agent_create`, `agent_bind_channel` and
 * `agent_trigger_create` are writes whose outputs echo back ids the caller
 * already supplied plus the name of the row they just wrote — no scoped source
 * enters the run's context through them, so there is deliberately no sink call
 * on those four rather than a no-op one. The ids themselves had to come from a
 * read that did stamp: `agent_list` here, or `channel_find`/`channel_list`.
 */

// Whether this deployment signs Ledger calls is read once, exactly as
// api/src/routes/triggers.ts reads it: never a per-request or per-user decision.
const ledgerSigningConfigured = loadLedgerIdentitySettings() !== null

const describeChannel = (channel: ChannelRecord): string =>
  `#${channel.label} (${channel.projectName} / ${channel.teamName})`

const ChannelCreateInputSchema = z.object({
  label: z.string().min(1, 'label is required.'),
  teamId: z.string().uuid().optional(),
  visibility: z.enum(['public', 'protected', 'private']).optional(),
})

/**
 * The team a new channel lands in. The route falls back through the session's
 * tenant/action team; a run has no session, so its last resort is the team of
 * the channel the conversation is happening in — never an invented default.
 */
const resolveTeamId = async (
  context: BuiltinToolRuntimeContext,
  requested: string | undefined,
): Promise<string> => {
  const fromContext =
    requested
    ?? context.actorContext.tenant.teamId
    ?? context.actorContext.actionContext.teamId
  if (fromContext) return fromContext

  const channel = await context.prisma.channel.findUnique({
    where: { id: context.channel.id },
    select: { teamId: true },
  })
  if (!channel) {
    throw new Error('Could not work out which team this channel should belong to.')
  }
  return channel.teamId
}

export const runChannelCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ChannelCreateInputSchema.parse(input)
  const member = await resolveActingMember(context)
  const teamId = await resolveTeamId(context, args.teamId)

  // An invalid name and a taken slug both throw messages written for a person
  // (the route turns them into 400/409), so they travel to the model as they are.
  const channel = await createChannelForUser(context.prisma, {
    label: args.label,
    organizationId: member.organizationId,
    teamId,
    userId: member.userId,
    visibility: args.visibility ?? 'public',
  })
  if (!channel) {
    throw new Error('That team does not belong to this organisation.')
  }

  return {
    inputSummary: `label="${args.label}"`,
    outputPreview: [
      `Created ${describeChannel(channel)}`,
      `channelId=${channel.id} | slug=${channel.slug ?? ''} | visibility=${channel.visibility}`,
      `You are its owner. Bind an agent with agent_bind_channel, or invite people from the channel page.`,
    ].join('\n'),
    toolName: 'channel_create',
  }
}

const AgentCreateInputSchema = z.object({
  name: z.string().min(1, 'name is required.'),
  role: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  effort: AgentEffortSchema.optional(),
  runLimits: AgentRunLimitsSchema.nullish(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  visibility: AgentVisibilitySchema.optional(),
  ownerUserId: z.string().uuid().optional(),
})

export const runAgentCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentCreateInputSchema.parse(input)
  const member = await resolveActingMember(context)

  if (
    args.visibility === 'private'
    && args.ownerUserId !== undefined
    && args.ownerUserId !== member.userId
  ) {
    throw new Error('A private agent can only be created for you.')
  }

  // The SAME validator the route uses, not a second copy: a Ledger pair must
  // exist in the catalogue, and a `subscription/<key>` pair must belong to the
  // acting person. Chat cannot mint an agent pointing at a model that will fail
  // on its first run, nor at somebody else's personal plan.
  let modelSubscriptionId: string | null = null
  if (args.model !== undefined || args.provider !== undefined) {
    const selection = await assertAgentModelSelection(context.prisma, {
      actingUserId: member.userId,
      config: loadConfig().model,
      ...(process.env.LEDGER_PUBLIC_URL
        ? { ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL }
        : {}),
      model: args.model,
      organizationId: member.organizationId,
      ownerUserId: member.userId,
      provider: args.provider,
      requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
        actorContext: member.actorContext,
        ledgerIdentity: context.ledgerIdentity,
      }),
    })
    modelSubscriptionId = selection.modelSubscriptionId
  }

  const agent = await createAgentRecord(context.prisma, {
    effort: args.effort,
    model: args.model,
    modelSubscriptionId,
    name: args.name,
    organizationId: member.organizationId,
    // Mirrors `POST /api/agents`: the person who asked for the agent stewards
    // it. `member` is the live OrganizationMember resolved at call time, not
    // the run's enqueue-time snapshot.
    ownerUserId: member.userId,
    projectId: context.actorContext.tenant.projectId,
    provider: args.provider,
    role: args.role ?? 'assistant',
    runLimits: args.runLimits,
    systemPrompt: args.systemPrompt,
    teamId: context.actorContext.tenant.teamId,
    toolPolicy: args.toolPolicy,
    visibility: args.visibility,
  })

  return {
    inputSummary: `name="${args.name}"`,
    outputPreview: [
      `Created agent "${agent.name}" (${agent.role})`,
      `agentId=${agent.id}`
      + (agent.model ? ` | model=${agent.provider ?? '?'}/${agent.model}` : ' | model=deployment default'),
      agent.homeChannelId
        ? `Its private home is channelId=${agent.homeChannelId}.`
        : 'It is not in any channel yet — an owner can bind it with agent_bind_channel.',
    ].join('\n'),
    toolName: 'agent_create',
  }
}

const AgentListInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'query cannot be blank — omit it to list every agent you can see.')
    .optional(),
})

/**
 * Channel labels for the bindings a listing already returned. The ids come
 * from `listAgentsForUser`, which filtered every binding through the caller's
 * own channel visibility, so this only puts a name on a channel the caller can
 * already see.
 */
const resolveBoundChannelLabels = async (
  context: BuiltinToolRuntimeContext,
  channelIds: string[],
): Promise<Map<string, string>> => {
  if (channelIds.length === 0) return new Map()
  const channels = await context.prisma.channel.findMany({
    where: {
      id: { in: [...new Set(channelIds)] },
      organizationId: context.channel.organizationId,
    },
    select: { id: true, label: true, visibility: true },
  })
  // The bindings were already filtered to channels this person can reach, so a
  // non-public label here is material they see through their own membership.
  recordChannelDirectoryRead(context, channels)
  return new Map(channels.map((channel) => [channel.id, channel.label]))
}

export const runAgentListTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentListInputSchema.parse(input)
  const member = await resolveActingMember(context)

  // The list the Agents page shows this person, scoped by entitlement: an owner
  // reaches every non-system agent including unbound ones, anybody else reaches
  // an agent through a channel they can see it working in.
  const agents = await listAgentsForUser(
    context.prisma,
    member.userId,
    member.organizationId,
    member.isOwner,
  )

  // Narrowing happens here rather than in the query so the entitlement read
  // stays the single shared one; it is a filter over an already-authorized list.
  const needle = args.query?.toLowerCase()
  const matches = needle
    ? agents.filter((agent) =>
      agent.name.toLowerCase().includes(needle)
      || agent.role.toLowerCase().includes(needle))
    : agents

  // Provenance for a delegated read (AGENTS.md: the obligation sits on the
  // read, not on the reply). The rule and why workspace rows are excluded from
  // it live on the helper.
  recordVisibleAgentRead(context, matches)

  const labels = await resolveBoundChannelLabels(
    context,
    matches.flatMap((agent) => agent.channelIds),
  )
  const lines = matches.map((agent) => {
    const channels = agent.channelIds.length === 0
      ? 'not in any channel yet'
      : agent.channelIds
        .map((channelId) => `#${labels.get(channelId) ?? 'unknown'} (channelId=${channelId})`)
        .join(', ')
    return `- "${agent.name}" | role=${agent.role} | agentId=${agent.id} | ${channels}`
  })

  const empty = needle
    ? `No agent you can see matches "${args.query}".`
    : 'No agents are visible to you.'

  return {
    inputSummary: needle ? `query="${args.query}"` : 'all',
    outputPreview: formatSection(`Agents (${lines.length})`, lines) || empty,
    toolName: 'agent_list',
  }
}

const AgentBindChannelInputSchema = z.object({
  agentId: z.string().uuid(),
  channelId: z.string().uuid(),
})

export const runAgentBindChannelTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentBindChannelInputSchema.parse(input)
  const member = await resolveActingMember(context)

  // Route order, reproduced: channel membership, then the system-channel
  // refusal, then owner, then policy.
  const channel = await getChannelIfMember(
    context.prisma,
    member.userId,
    member.organizationId,
    args.channelId,
  )
  if (!channel) {
    throw new Error('Channel not found, or you are not a member of it.')
  }
  if (channel.systemChannelType) {
    throw new Error('Agents cannot be bound to a system-managed conversation.')
  }

  requireOwnerMember(member, 'bind an agent to a channel')

  const decision = await checkPolicy(
    context.prisma,
    {
      ...member.actorContext,
      // A run's actor context is decorated with the tool being called, which
      // would add a scope the route's chain never carries. The question here is
      // the route's question — may this person bind this agent to this channel.
      actionContext: { ...member.actorContext.actionContext, toolId: undefined },
    },
    'agent',
    'bind',
    { agentId: args.agentId, channelId: args.channelId },
  )
  if (!decision.allowed) {
    throw new Error(`Agent binding denied by policy: ${decision.reasonCode}`)
  }

  let agent
  try {
    agent = await bindAgentToChannel(context.prisma, {
      agentId: args.agentId,
      channelId: args.channelId,
      organizationId: member.organizationId,
      userId: member.userId,
    })
  } catch (error) {
    if (
      error instanceof AgentBindingError
      && error.code === AGENT_BINDING_ERROR_CODES.PRIVATE_VISIBILITY
    ) {
      throw new Error('Private agents cannot be added to channels.')
    }
    throw error
  }
  if (!agent) {
    throw new Error('Agent not found, or it is system managed and cannot be bound.')
  }

  return {
    inputSummary: `agentId=${args.agentId} channelId=${args.channelId}`,
    outputPreview:
      `Bound agent "${agent.name}" to channelId=${args.channelId}. `
      + 'It now answers in that channel.',
    toolName: 'agent_bind_channel',
  }
}

const AgentTriggerCreateInputSchema = CreateAgentTriggerBodySchema.extend({
  agentId: z.string().uuid(),
})

export const runAgentTriggerCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { agentId, ...body } = AgentTriggerCreateInputSchema.parse(input)
  const member = await resolveActingMember(context)

  requireOwnerMember(member, 'create a trigger on an agent')

  if (!(await isAgentAccessibleToActor(context.prisma, member.actorContext, agentId))) {
    throw new Error('Agent not found.')
  }

  const isScheduled = body.type === 'scheduled' || body.type === 'interval'
  const teamId =
    context.actorContext.tenant.teamId ?? context.actorContext.actionContext.teamId
  if (isScheduled && !teamId) {
    throw new Error(
      'Scheduled triggers need an active team, so every future run keeps the original workspace scope.',
    )
  }
  // A signing deployment cannot fire a schedule whose creator left no UOA
  // identity: it would mint a trigger that fails at every sweep forever. Refuse
  // now, while there is somebody to tell.
  if (
    isScheduled
    && ledgerSigningConfigured
    && !context.actorContext.actionContext.uoaIdentity
  ) {
    throw new Error(
      'Scheduled triggers require an UnlikeOtherAI SSO session. Sign in through SSO and ask again.',
    )
  }

  const launchOrigin = isScheduled
    ? {
        organizationId: context.actorContext.tenant.organizationId,
        ...(context.actorContext.tenant.projectId
          ? { projectId: context.actorContext.tenant.projectId }
          : {}),
        teamId: teamId!,
        // Captured here because this is the only moment a real session exists.
        // A fire has none, and signing a Ledger call needs the UOA workspace
        // the creator was acting in.
        ...(context.actorContext.actionContext.uoaIdentity
          ? { uoaIdentity: context.actorContext.actionContext.uoaIdentity }
          : {}),
        userId: parseUserId(member.userId),
      }
    : undefined

  const trigger = await createAgentTrigger(
    context.prisma,
    agentId,
    body,
    launchOrigin ? { launchOrigin } : {},
  )
  if (!trigger) {
    throw new Error(
      'Trigger configuration is invalid. Check the schedule, and that the agent is bound to the target channel.',
    )
  }

  return {
    inputSummary: `agentId=${agentId} type=${body.type}`,
    outputPreview: [
      `Created ${trigger.type} trigger${trigger.name ? ` "${trigger.name}"` : ''}`,
      `triggerId=${trigger.id} | status=${trigger.status}`
      + (trigger.nextRunAt ? ` | next run ${trigger.nextRunAt}` : '')
      + (trigger.targetChannelId ? ` | posts into channelId=${trigger.targetChannelId}` : ''),
      ...(trigger.webhookApiKey
        ? ['A webhook key was generated; read it from the Triggers page rather than chat.']
        : []),
    ].join('\n'),
    toolName: 'agent_trigger_create',
  }
}
