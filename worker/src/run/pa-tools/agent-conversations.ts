import { Prisma } from '@prisma/client'
import { claimThreadRunOrPend, enqueueRunExecution } from '@nessie/db'
import { resolveDisclosureViewer } from '@nessie/runtime'
import {
  CONVERSATION_REF_SCHEMA_VERSION,
  ConversationRefMetadataSchema,
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
  withDelegatedSystemDmIdentity,
  type AgentConversationRecord,
} from '@nessie/schemas'
import {
  listAgentConversationsForUser,
  listAgentsForUser,
  loadConversationForUser,
  startAgentConversation,
} from '@nessie/team-admin'
import { z } from 'zod'

import { createAgentMessage } from '../execute/agent-message.js'
import { applyRunReplyBookkeeping } from '../execute/lifecycle.js'
import { publishMessageCreated } from '../execute/realtime.js'
import { isDelegatedSystemDmChannelType } from '../delegated-identity.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  buildVisibleChannelWhere,
  resolveActingMember,
  resolveEffectiveUserId,
  type ActingMember,
} from './access.js'
import { buildRealtimeScopesForChannel } from './message-destination.js'
import {
  computeDelegatedPostBasis,
  requireConsumedSources,
} from './tool-message-basis.js'
import { formatSection } from './tool-output.js'

/**
 * The three conversation tools.
 *
 * A conversation is a `Thread` with `agent_id` set
 * (docs/plans/2026-09-08-agent-conversations.md). These tools are the
 * assistant's half of the doors the API routes open for a person:
 *
 * - `agent_conversation_start` — open one and give it a job. The `Thread` is
 *   written by the shared `startAgentConversation`, so the button and the tool
 *   place a conversation by the same rule; what is *this* door's is the
 *   authorship (the assistant speaks, not the person, so the opener is written
 *   through `createAgentMessage` with a computed disclosure basis) and the run
 *   it claims for the target.
 * - `agent_conversations_list` — the read that turns an agent's name into the
 *   thread ids the other two take, exactly as `agent_list` does for agent ids.
 * - `conversation_reference` — put a live card for a conversation into this
 *   chat. Not PA-only: showing a conversation is a better-shaped message, and
 *   what a viewer then sees is decided per viewer by the card's own read.
 *
 * Nothing here decides visibility for itself. Agents resolve through the very
 * entitlement `agent_list` uses, rooms through `buildVisibleChannelWhere`, and
 * conversations through `listAgentConversationsForUser` /
 * `loadConversationForUser` as the acting person.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const AgentConversationStartInputSchema = z.object({
  agent: z.string().trim().min(1, 'agent is required — a name or an agentId.'),
  message: z.string().trim().min(1, 'message is required — the job for that agent.'),
  title: z.string().trim().min(1).max(80).optional(),
  channel: z.string().trim().min(1).optional(),
})

const AgentConversationsListInputSchema = z.object({
  agent: z.string().trim().min(1, 'agent is required — a name or an agentId.'),
})

const ConversationReferenceInputSchema = z.object({
  // UUID-guarded here rather than in the handler: a malformed id reaching a
  // uuid column is a 500, and the model is perfectly capable of inventing one.
  conversation: z
    .string()
    .trim()
    .uuid('conversation must be a thread id — take it from agent_conversations_list.'),
  note: z.string().trim().min(1).max(500).optional(),
})

export const AgentConversationStartToolOutputSchema = z.object({
  agentId: z.string().uuid(),
  channelId: z.string().uuid(),
  /** `pended` only when the new conversation somehow already held a run. */
  status: z.enum(['started', 'pended']),
  threadId: z.string().uuid(),
  title: z.string(),
  where: z.string(),
})
export type AgentConversationStartToolOutput = z.infer<
  typeof AgentConversationStartToolOutputSchema
>

/** One room description for every line these tools print, so they never disagree. */
const describeRoom = (channel: {
  label: string
  projectName: string | null
  type: 'dm' | 'standard'
}): string =>
  channel.type === 'dm'
    ? `direct message with ${channel.label}`
    : `#${channel.label}${channel.projectName ? ` (${channel.projectName})` : ''}`

/**
 * What a conversation is doing, in one word, from the record's own fields.
 *
 * Structural: an active run's status, else how the last one ended. Never
 * composed from message content, and never a status the record did not state.
 */
const describeStatus = (record: AgentConversationRecord): string => {
  if (record.activeRun) {
    switch (record.activeRun.status) {
      case 'running':
        return 'running'
      case 'pending':
        return 'queued'
      default:
        return 'waiting'
    }
  }
  switch (record.lastRunOutcome) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return 'idle'
  }
}

type AddressableAgent = { id: string; name: string }

/**
 * The agents this person may address by name.
 *
 * Two sources, and the second is not optional. `listAgentsForUser` is the exact
 * entitlement `agent_list` and `GET /api/agents` apply — but it excludes
 * system-managed agents, which would make the Personal Assistant and every
 * global agent unaddressable in the one place a person most obviously means
 * them. So the agents the caller already has a home DM with are added, resolved
 * the way `startAgentConversation` resolves "the caller's own DM with this
 * agent": a DM they belong to whose only bound agent is that one. Keying on the
 * bindings rather than on a `dmKey` spelling keeps this one rule instead of
 * five.
 */
const listAddressableAgents = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
): Promise<AddressableAgent[]> => {
  const entitled = await listAgentsForUser(
    context.prisma,
    member.userId,
    member.organizationId,
    member.isOwner,
  )
  const byId = new Map<string, AddressableAgent>(
    entitled.map((agent) => [agent.id, { id: agent.id, name: agent.name }]),
  )

  const homeDms = await context.prisma.channel.findMany({
    where: {
      organizationId: member.organizationId,
      type: 'dm',
      members: { some: { userId: member.userId } },
      agentBindings: { some: {} },
    },
    select: {
      agentBindings: {
        select: {
          agentId: true,
          principalUserId: true,
          agent: { select: { id: true, name: true } },
        },
      },
    },
  })
  for (const channel of homeDms) {
    const distinct = new Set(channel.agentBindings.map((binding) => binding.agentId))
    if (distinct.size !== 1) continue
    // A presence binding placed for somebody else is not this person's DM.
    const binding = channel.agentBindings.find(
      (candidate) =>
        candidate.principalUserId === null
        || candidate.principalUserId === member.userId,
    )
    if (!binding) continue
    if (!byId.has(binding.agentId)) {
      byId.set(binding.agentId, { id: binding.agent.id, name: binding.agent.name })
    }
  }

  return [...byId.values()]
}

/**
 * An agent an invisible caller named is "not found", never "forbidden": an id
 * or a name must never confirm that an agent exists.
 */
const agentNotFound = (needle: string): Error =>
  new Error(
    `I can't find an agent called "${needle}" that you can reach. `
    + 'Call agent_list to see the agents you can see, then pass its agentId.',
  )

const resolveAddressableAgent = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  needle: string,
): Promise<AddressableAgent> => {
  const agents = await listAddressableAgents(context, member)
  if (UUID_PATTERN.test(needle)) {
    const byId = agents.find((agent) => agent.id === needle)
    if (!byId) throw agentNotFound(needle)
    return byId
  }

  const lowered = needle.toLowerCase()
  const exact = agents.filter((agent) => agent.name.toLowerCase() === lowered)
  if (exact.length === 1 && exact[0]) return exact[0]
  const partial = agents.filter((agent) => agent.name.toLowerCase().includes(lowered))
  if (partial.length === 1 && partial[0]) return partial[0]
  if (partial.length > 1) {
    throw new Error(
      `Several agents match "${needle}": ${partial.map((agent) => agent.name).join(', ')}. `
      + 'Pass the agentId of the one you mean.',
    )
  }
  throw agentNotFound(needle)
}

const resolveNamedRoom = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  needle: string,
): Promise<{ id: string; label: string }> => {
  const visible = buildVisibleChannelWhere(member.organizationId, member.userId)
  if (UUID_PATTERN.test(needle)) {
    const byId = await context.prisma.channel.findFirst({
      where: { ...visible, id: needle },
      select: { id: true, label: true },
    })
    if (!byId) {
      throw new Error(`I can't find a channel with id ${needle} that you can see.`)
    }
    return byId
  }

  const label = needle.replace(/^#/, '').trim()
  const matches = await context.prisma.channel.findMany({
    where: {
      ...visible,
      archivedAt: null,
      label: { contains: label, mode: 'insensitive' },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, label: true },
    take: 6,
  })
  const exact = matches.filter((channel) => channel.label.toLowerCase() === label.toLowerCase())
  if (exact.length === 1 && exact[0]) return exact[0]
  if (matches.length === 1 && matches[0]) return matches[0]
  if (matches.length > 1) {
    throw new Error(
      `Several channels match "${needle}": ${matches.map((channel) => `#${channel.label}`).join(', ')}. `
      + 'Pass the channelId of the one you mean.',
    )
  }
  throw new Error(`I can't find a channel called "${needle}" that you can see.`)
}

export const runAgentConversationStartTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  // Delegation turns this run's words into another run's prompt, so provenance
  // is required before anything is written — the same first line as a handoff.
  const consumedSources = requireConsumedSources(context)
  const args = AgentConversationStartInputSchema.parse(input)
  const runContext = context.runContext
  if (!runContext) {
    throw new Error('Unable to resolve the current conversation.')
  }

  // Deliberately NOT `requireRequestingHuman`: a scheduled "every morning ask
  // the researcher to…" is exactly what this tool is for. The acting member is
  // still re-read live, so a deactivated person starts nothing.
  const member = await resolveActingMember(context)
  const target = await resolveAddressableAgent(context, member, args.agent)
  const namedRoom = args.channel
    ? await resolveNamedRoom(context, member, args.channel)
    : null

  // One transaction: the conversation itself, the opener, the run it starts,
  // and the doorway back here. The card must exist exactly when the job does —
  // a doorway pointing at a conversation whose run never started is a card that
  // says "Not started" forever, and an opener with no doorway is work nobody
  // can see. The thread is inside it for the same reason: created outside, a
  // failure below leaves an orphan unnamed conversation in somebody's list.
  //
  // The destination read and the sole-audience decision are inside too, so the
  // audience the opener's basis was computed for is the audience the opener was
  // committed to — a membership change between the two would otherwise publish
  // to a room the basis never saw.
  const started = await context.prisma.$transaction(async (tx) => {
    const outcome = await startAgentConversation(tx, {
      agentId: target.id,
      ...(namedRoom ? { channelId: namedRoom.id } : {}),
      message: args.message,
      organizationId: member.organizationId,
      startedByUserId: member.userId,
      ...(args.title ? { title: args.title } : {}),
    })
    if (outcome.kind !== 'created') return { failure: outcome }
    const conversation = outcome.thread

    const destination = await tx.channel.findUniqueOrThrow({
      where: { id: conversation.channelId },
      select: {
        id: true,
        label: true,
        organizationId: true,
        projectId: true,
        systemChannelType: true,
        teamId: true,
        type: true,
        members: { select: { userId: true }, take: 2 },
        team: { select: { project: { select: { channelRoot: true, name: true } } } },
      },
    })

    /**
     * Whether the destination's whole audience is the person who asked.
     *
     * This is the condition `agent_handoff`'s second subtraction silently
     * assumes and this tool cannot: a handoff always lands in the requester's
     * own single-member DM, while a conversation can be opened in a shared
     * room. In that room, subtracting the scopes one person satisfies would
     * publish restricted material to everyone else in it. Structural — a
     * system DM's own type, or a DM with exactly one member who is the
     * requester.
     */
    const destinationIsRequestersOwnRoom =
      isDelegatedSystemDmChannelType(destination.systemChannelType)
      || (destination.type === 'dm'
        && destination.members.length === 1
        && destination.members[0]?.userId === member.userId)
    const viewer = destinationIsRequestersOwnRoom
      ? await resolveDisclosureViewer(tx, member.organizationId, member.userId)
      : null
    const openerBasis = computeDelegatedPostBasis({
      consumed: consumedSources.list(),
      destination: {
        channelId: destination.id,
        organizationId: destination.organizationId,
        projectId: destination.projectId,
        teamId: destination.teamId,
      },
      requesterScopes: viewer?.kind === 'user' ? viewer.scopes : [],
      targetAgentIds: [target.id],
    })

    // The target run acts as the person who asked, so its own tools are gated
    // as that person's ask — and `withDelegatedSystemDmIdentity` adds the
    // `effectiveUserId` stamp exactly when the destination is a single-member
    // system DM, which is the difference between the target having its
    // identity-delegated tools and silently reporting that it cannot do
    // anything (docs/standards/global-agents.md).
    const destinationActorContext = withDelegatedSystemDmIdentity(
      withActionContext(member.actorContext, {
        agentId: parseAgentId(target.id),
        channelId: parseChannelId(destination.id),
        threadId: parseThreadId(conversation.id),
      }),
      { systemChannelType: destination.systemChannelType },
    )

    const opener = await createAgentMessage(tx, runContext, {
      agentId: context.agentId,
      basis: openerBasis,
      content: args.message,
      role: 'assistant',
      threadId: conversation.id,
    })

    const claim = await claimThreadRunOrPend(tx, {
      agentId: target.id,
      threadId: conversation.id,
      pending: {
        actorContext: destinationActorContext,
        channelId: destination.id,
        // Nobody is at the keyboard of the *target's* turn: the job was handed
        // to it, not typed at it.
        interactive: false,
        messageId: opener.id,
      },
    })
    if (claim === 'claimed') {
      const run = await tx.run.create({
        data: {
          agentId: target.id,
          replyPlacement: 'thread',
          status: 'pending',
          threadId: conversation.id,
          triggerMessageId: opener.id,
        },
        select: { id: true },
      })
      const task = await tx.task.create({
        data: {
          agentId: target.id,
          organizationId: member.organizationId,
          purpose: args.message.slice(0, 200),
          runId: run.id,
          status: 'inbox',
        },
        select: { id: true },
      })
      await enqueueRunExecution(
        tx,
        {
          actorContext: withActionContext(destinationActorContext, {
            taskId: parseTaskId(task.id),
          }),
          agentId: parseAgentId(target.id),
          interactive: false,
          messageId: opener.id,
          runId: parseRunId(run.id),
          taskId: parseTaskId(task.id),
          threadId: parseThreadId(conversation.id),
        },
        // Keyed on the tool *call*, exactly as peer delegation's
        // `correlationId` is: the thread id is minted by this very attempt, so
        // a key carrying it is different on every redelivery and dedupes
        // nothing. The call is the same across redeliveries of this run.
        `agent-conversation:${runContext.run.id}:${context.toolCallId ?? conversation.id}`,
      )
    }

    const doorway = await createAgentMessage(tx, runContext, {
      agentId: context.agentId,
      content: `Started a conversation with ${target.name}: "${conversation.title}".`,
      metadata: {
        conversationRef: ConversationRefMetadataSchema.parse({
          agentId: target.id,
          channelId: destination.id,
          schemaVersion: CONVERSATION_REF_SCHEMA_VERSION,
          threadId: conversation.id,
        }),
      } as Prisma.InputJsonValue,
      role: 'assistant',
      threadId: runContext.run.threadId,
      ...(runContext.replyRootMessageId
        ? { rootMessageId: runContext.replyRootMessageId }
        : {}),
    })

    return { claim, conversation, destination, doorway, opener }
  })

  // Refused, in the words this door owns. Stated out here rather than inside so
  // a refusal is never a rolled-back transaction carrying a message for a
  // person, and so the transaction holds nothing while the text is composed.
  if (started.failure) {
    if (started.failure.kind === 'agent_not_found') {
      throw agentNotFound(args.agent)
    }
    if (started.failure.kind === 'no_room') {
      throw new Error(
        `"${target.name}" is not in any channel you can post in, so there is nowhere to `
        + 'hold a conversation with it. An owner can put it in a channel '
        + '(agent_bind_channel), and then this will work.',
      )
    }
    throw new Error(
      `"${target.name}" does not work in ${namedRoom ? `#${namedRoom.label}` : 'that channel'}, `
      + 'or you cannot post there. Name a channel you can both reach, or leave it out '
      + 'and I will use your own conversation with it.',
    )
  }

  const { conversation, destination } = started
  const room = describeRoom({
    label: destination.label,
    projectName:
      destination.type === 'dm' || destination.team.project.channelRoot
        ? null
        : destination.team.project.name,
    type: destination.type,
  })

  // Post-commit, exactly as the handoff doorway publishes: a listener must
  // never observe an uncommitted message id.
  const reply = runContext.replyRootMessageId
    ? await applyRunReplyBookkeeping(context.prisma, runContext, started.doorway.createdAt)
    : undefined
  await publishMessageCreated(context.realtimeTransport, runContext, {
    content: started.doorway.content,
    messageId: started.doorway.id,
    role: 'assistant',
    ...(started.doorway.basis.length > 0 ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })
  // The opener lands in another thread, so `publishMessageCreated` (which
  // publishes onto the run's own thread) cannot announce it. Same scope rule as
  // every other tool-posted message.
  await context.realtimeTransport.publishWs(
    buildRealtimeScopesForChannel({
      channelId: destination.id,
      organizationId: member.organizationId,
      systemChannelType: destination.systemChannelType,
    }),
    {
      data: {
        agentId: parseAgentId(context.agentId),
        channelId: parseChannelId(destination.id),
        ...(started.opener.basis.length > 0
          ? { restricted: true as const }
          : { contentPreview: args.message.slice(0, 200) }),
        messageId: started.opener.id,
        role: 'assistant' as const,
        threadId: parseThreadId(conversation.id),
      },
      event: 'message.new',
    },
  )

  const output = AgentConversationStartToolOutputSchema.parse({
    agentId: target.id,
    channelId: destination.id,
    status: started.claim === 'claimed' ? 'started' : 'pended',
    threadId: conversation.id,
    title: conversation.title,
    where: room,
  })
  return {
    inputSummary: `agent="${args.agent}" messageChars=${args.message.length}`,
    outputPreview: [
      JSON.stringify(output),
      'A live card for this conversation is now in this chat: it shows whether it is '
      + 'running, what it is doing and a way in, so point them at the card rather than '
      + 'describing progress yourself.',
    ].join('\n'),
    toolName: 'agent_conversation_start',
  }
}

export const runAgentConversationsListTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentConversationsListInputSchema.parse(input)
  const member = await resolveActingMember(context)
  const target = await resolveAddressableAgent(context, member, args.agent)

  // First page, as the acting person: `null` is "you can see nothing of this
  // agent", which is the same answer as "no such agent" on purpose.
  const page = await listAgentConversationsForUser(context.prisma, {
    agentId: target.id,
    organizationId: member.organizationId,
    userId: member.userId,
  })
  if (!page) {
    throw agentNotFound(args.agent)
  }

  const lines = page.data.map((record) =>
    `- ${record.title} · ${describeRoom(record.channel)} · ${describeStatus(record)}`
    + ` · thread=${record.id}`,
  )
  return {
    inputSummary: `agent="${args.agent}"`,
    outputPreview:
      formatSection(`Conversations with ${target.name} (${lines.length})`, lines)
      || `You cannot see any conversation with "${target.name}" yet.`,
    toolName: 'agent_conversations_list',
  }
}

export const runConversationReferenceTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ConversationReferenceInputSchema.parse(input)
  const runContext = context.runContext
  if (!runContext) {
    throw new Error('Unable to resolve the current conversation.')
  }
  const organizationId = String(context.channel.organizationId)
  const actingUserId = resolveEffectiveUserId(context)

  let reference: {
    agentId: string
    channelId: string
    threadId: string
    title: string
  }
  if (actingUserId) {
    // The acting person's own visibility, through the one predicate every
    // conversation read shares (`buildViewerThreadWhere`, inside this).
    const record = await loadConversationForUser(context.prisma, {
      organizationId,
      threadId: args.conversation,
      userId: actingUserId,
    })
    if (!record) {
      throw new Error(
        'I can\'t find that conversation. Use agent_conversations_list to see the ones '
        + 'you can reach and take the thread id from there.',
      )
    }
    reference = {
      agentId: record.agentId,
      channelId: record.channel.id,
      threadId: record.id,
      title: record.title,
    }
  } else {
    // No person asking, so there is no visibility to borrow. The run is bounded
    // to its own channel, the way `assertReachableImages` bounds a card image.
    const thread = await context.prisma.thread.findFirst({
      where: { channelId: context.channel.id, id: args.conversation },
      select: {
        id: true,
        agentId: true,
        title: true,
        channel: {
          select: {
            id: true,
            label: true,
            agentBindings: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { agentId: true },
              take: 1,
            },
          },
        },
      },
    })
    if (!thread) {
      throw new Error(
        'Nobody is asking on this run, so I can only show a conversation from this very '
        + 'channel, and that thread is not one.',
      )
    }
    const agentId = thread.agentId ?? thread.channel.agentBindings[0]?.agentId
    if (!agentId) {
      throw new Error('That thread is not a conversation with an agent.')
    }
    reference = {
      agentId,
      channelId: thread.channel.id,
      threadId: thread.id,
      title: thread.title?.trim() || thread.channel.label,
    }
  }

  const content = args.note ?? `Here is the conversation: "${reference.title}".`
  const message = await createAgentMessage(context.prisma, runContext, {
    agentId: context.agentId,
    content,
    metadata: {
      conversationRef: ConversationRefMetadataSchema.parse({
        agentId: reference.agentId,
        channelId: reference.channelId,
        schemaVersion: CONVERSATION_REF_SCHEMA_VERSION,
        threadId: reference.threadId,
      }),
    } as Prisma.InputJsonValue,
    role: 'assistant',
    threadId: runContext.run.threadId,
    ...(runContext.replyRootMessageId
      ? { rootMessageId: runContext.replyRootMessageId }
      : {}),
  })

  const reply = runContext.replyRootMessageId
    ? await applyRunReplyBookkeeping(context.prisma, runContext, message.createdAt)
    : undefined
  await publishMessageCreated(context.realtimeTransport, runContext, {
    content: message.content,
    messageId: message.id,
    role: 'assistant',
    ...(message.basis.length > 0 ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })

  return {
    inputSummary: `conversation=${args.conversation}`,
    outputPreview: [
      `Posted a live card for "${reference.title}" (thread=${reference.threadId}).`,
      'It reads its own status every time somebody looks, so do not restate it.',
    ].join('\n'),
    toolName: 'conversation_reference',
  }
}
