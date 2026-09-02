import { Prisma } from '@prisma/client'
import {
  AgentHandoffBriefMetadataSchema,
  AgentHandoffDoorwayMetadataSchema,
  AgentHandoffToolInputSchema,
  AgentHandoffToolOutputSchema,
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  parseUserId,
  withActionContext,
} from '@nessie/schemas'
import { resolveDisclosureViewer } from '@nessie/runtime'
import {
  ensureGlobalAgentBootstrap,
  getGlobalAgentBlueprint,
  listGlobalAgentBlueprints,
  type GlobalAgentBlueprint,
} from '@nessie/workspace-admin'

import { enqueueRunExecution } from '../../queue.js'
import { claimThreadRunOrPend } from '../thread-serialization.js'
import { createAgentMessage } from '../execute/agent-message.js'
import {
  computeReplyBasis,
  subtractImpliedScopes,
  type BasisScope,
} from '../execute/disclosure-basis.js'
import { applyRunReplyBookkeeping } from '../execute/lifecycle.js'
import { publishMessageCreated } from '../execute/realtime.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'

/**
 * `agent_handoff` — pass the conversation to a global agent (D8).
 *
 * What it writes: a hidden server-authored `system` brief into the requesting
 * person's own home DM with the target global agent, the run that brief starts,
 * and one ordinary doorway message back in the room the ask came from. Nothing
 * else, and nothing carrying authority the origin run did not already have.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D8).
 */

/**
 * A repeat ask, a queue retry, or a continuation run (new `runId`, same
 * request) inside this window converges on the briefing already waiting rather
 * than writing a second one. Ten minutes is the span of one conversation about
 * one thing; past it, coming back is a new ask and deserves a fresh brief.
 */
const HANDOFF_COOLDOWN_MS = 10 * 60_000
/** After this the row stops being the live handoff for the (person, target) pair. */
const HANDOFF_EXPIRY_MS = 60 * 60_000

const namedTargets = (): string =>
  listGlobalAgentBlueprints().map((blueprint) => blueprint.slug).join(', ') || 'none'

const resolveTargetBlueprint = (target: string): GlobalAgentBlueprint => {
  const blueprint = getGlobalAgentBlueprint(target)
  // `home` is checked as well as existence: a blueprint homed anywhere but a
  // per-user DM has no private surface to brief, and v1 ships none.
  if (!blueprint || blueprint.home !== 'per_user_dm') {
    throw new Error(
      `There is no built-in specialist called "${target}". Available: ${namedTargets()}.`,
    )
  }
  return blueprint
}

/**
 * The human this handoff is *for*.
 *
 * Deliberately the actor, never `effectiveUserId`. A Personal Assistant
 * presence in a shared room carries its owner's `effectiveUserId` while a
 * different member did the asking — keying the DM on the effective user would
 * open, and brief, the wrong person's private conversation. Requiring an
 * interactive turn from a user actor also refuses every unattended, trigger,
 * subtask and agent-authored run in one condition rather than four.
 */
const requireRequestingHuman = (context: BuiltinToolRuntimeContext): string => {
  if (context.run.interactive !== true) {
    throw new Error(
      'A handoff opens someone\'s private conversation with a specialist, so it only '
      + 'happens on a live turn from the person themselves — not on a scheduled or '
      + 'automated run.',
    )
  }
  if (context.actorContext.actor.actorType !== 'user') {
    throw new Error(
      'This run has no person asking, so there is nobody to hand the conversation to.',
    )
  }
  return context.actorContext.actor.actorId
}

/**
 * The brief's disclosure basis: the origin run's consumed sources, minus what
 * the destination DM already implies, minus every scope the requester already
 * satisfies.
 *
 * The second subtraction is the load-bearing one and it is not a nicety. The
 * requester is the DM's only member, so a basis they cannot satisfy makes every
 * later reply in that DM unreadable by the one person it is for — the Designer
 * silenced in its own home. They heard the brief's content in the origin thread
 * already, so subtracting what they can reach withholds nothing from anybody.
 *
 * Both subtractions reuse `disclosure-basis.ts` rather than restating set
 * containment here: `computeReplyBasis` for the destination and
 * `subtractImpliedScopes` — the function it is itself built on — for the person.
 */
export const computeHandoffBriefBasis = (input: {
  consumed: readonly BasisScope[]
  destination: {
    channelId: string
    organizationId: string
    projectId: string
    teamId: string
  }
  requesterScopes: readonly BasisScope[]
  targetAgentId: string
}): BasisScope[] =>
  subtractImpliedScopes(
    computeReplyBasis(input.consumed, input.destination, [input.targetAgentId]),
    input.requesterScopes,
  )

export const runAgentHandoffTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentHandoffToolInputSchema.parse(input)
  const blueprint = resolveTargetBlueprint(args.target)
  const requesterUserId = requireRequestingHuman(context)

  const runContext = context.runContext
  if (!runContext) {
    throw new Error('Unable to resolve the current conversation.')
  }
  const organizationId = context.channel.organizationId

  // The acting membership is re-read live, exactly as the route-mirroring
  // PA tools do: a run's actor context is a snapshot from enqueue time.
  const membership = await context.prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: requesterUserId } },
    select: { deactivatedAt: true, role: true },
  })
  if (!membership || membership.deactivatedAt) {
    throw new Error(
      'Your access to this organisation is not active, so I cannot open a specialist '
      + 'conversation for you.',
    )
  }

  // Idempotent, and the same function login runs — the person may never have
  // opened this DM. The origin channel's team only seeds the hidden system team
  // the first time; afterwards it is found by name and the seed is unused.
  const home = await ensureGlobalAgentBootstrap(context.prisma, {
    blueprint,
    organizationId,
    teamId: runContext.channel.teamId,
    userId: requesterUserId,
  })
  const destination = await context.prisma.channel.findUniqueOrThrow({
    where: { id: home.channelId },
    select: { id: true, organizationId: true, projectId: true, teamId: true },
  })

  const viewer = await resolveDisclosureViewer(
    context.prisma,
    organizationId,
    requesterUserId,
  )
  const briefBasis = computeHandoffBriefBasis({
    consumed: runContext.consumedSources.list(),
    destination: {
      channelId: destination.id,
      organizationId: destination.organizationId,
      projectId: destination.projectId,
      teamId: destination.teamId,
    },
    requesterScopes: viewer.kind === 'user' ? viewer.scopes : [],
    targetAgentId: home.agentId,
  })

  // The target run acts as the requester, on their own home DM, on an
  // interactive turn — the three conditions the identity-tool gate reads
  // (`resolveDelegatedRequesterUserId`). The tenant is deliberately the origin
  // run's, not the hidden system team's: it decides Ledger attribution, and an
  // ordinary message typed into this DM carries the poster's session tenant too.
  const destinationActorContext = withActionContext(
    {
      ...context.actorContext,
      actor: {
        ...context.actorContext.actor,
        actorId: requesterUserId,
        actorType: 'user' as const,
        roles: [membership.role],
      },
    },
    {
      agentId: parseAgentId(home.agentId),
      channelId: parseChannelId(destination.id),
      effectiveUserId: parseUserId(requesterUserId),
      threadId: parseThreadId(home.threadId),
    },
  )

  const now = new Date()
  const committed = await context.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`agent-handoff:${requesterUserId}:${blueprint.slug}`}, 0)
      )
    `
    const active = await tx.agentHandoffRequest.findFirst({
      where: {
        expiresAt: { gt: now },
        requestedByUserId: requesterUserId,
        supersededAt: null,
        targetSlug: blueprint.slug,
      },
      orderBy: { createdAt: 'desc' },
      select: { cooldownUntil: true, destinationChannelId: true, id: true },
    })
    if (active && active.cooldownUntil > now) {
      return { channelId: active.destinationChannelId, kind: 'existing' as const }
    }
    if (active) {
      await tx.agentHandoffRequest.update({
        data: { supersededAt: now },
        where: { id: active.id },
      })
    }

    // A hidden `system` row, never a `user` one under the person's id. The
    // integration-handoff precedent writes model text as the requester's own
    // words — editable by them afterwards, and indistinguishable from something
    // they typed. This is the trigger-kickoff mechanism instead: it drives the
    // run, is excluded from the channel feed and from future model context, and
    // the target's own first reply is the visible artifact in the DM.
    const brief = await tx.message.create({
      data: {
        content: args.brief,
        metadata: AgentHandoffBriefMetadataSchema.parse({
          fromAgentId: context.agentId,
          originChannelId: runContext.channel.id,
          originRunId: runContext.run.id,
          originThreadId: runContext.run.threadId,
          requestedByUserId: requesterUserId,
          targetSlug: blueprint.slug,
        }) as Prisma.InputJsonValue,
        role: 'system',
        threadId: home.threadId,
      },
      select: { id: true },
    })
    if (briefBasis.length > 0) {
      await tx.messageBasisScope.createMany({
        data: briefBasis.map((scope) => ({
          messageId: brief.id,
          organizationId,
          scopeId: scope.scopeId,
          scopeType: scope.scopeType,
        })),
        skipDuplicates: true,
      })
    }

    // Slot discipline, exactly as an orchestrator decision takes it: a busy
    // home DM — an open card, a turn still running — pends this brief for the
    // batched follow-up instead of double-running the agent. Only the
    // orchestrator's *judgement* is skipped here, never the claim.
    const claim = await claimThreadRunOrPend(tx, {
      agentId: home.agentId,
      pending: {
        actorContext: destinationActorContext,
        channelId: destination.id,
        interactive: true,
        messageId: brief.id,
      },
      threadId: home.threadId,
    })

    if (claim === 'claimed') {
      const run = await tx.run.create({
        data: {
          agentId: home.agentId,
          // Paired with the hidden `system` brief above, for the reason
          // trigger-run states: a reply threaded under an invisible root would
          // never appear in the DM at all.
          replyPlacement: 'channel',
          status: 'pending',
          threadId: home.threadId,
          triggerMessageId: brief.id,
        },
        select: { id: true },
      })
      const task = await tx.task.create({
        data: {
          agentId: home.agentId,
          organizationId,
          purpose: args.brief.slice(0, 200),
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
          agentId: parseAgentId(home.agentId),
          interactive: true,
          messageId: brief.id,
          runId: parseRunId(run.id),
          taskId: parseTaskId(task.id),
          threadId: parseThreadId(home.threadId),
        },
        // The crash guard beneath the cooldown row: a redelivered origin job
        // re-running this tool cannot enqueue the same handoff twice.
        `handoff:${runContext.run.id}:${blueprint.slug}`,
      )
    }

    await tx.agentHandoffRequest.create({
      data: {
        briefMessageId: brief.id,
        cooldownUntil: new Date(now.getTime() + HANDOFF_COOLDOWN_MS),
        destinationChannelId: destination.id,
        destinationThreadId: home.threadId,
        expiresAt: new Date(now.getTime() + HANDOFF_EXPIRY_MS),
        fromAgentId: context.agentId,
        organizationId,
        originRunId: runContext.run.id,
        requestedByUserId: requesterUserId,
        targetAgentId: home.agentId,
        targetSlug: blueprint.slug,
      },
    })

    // The doorway: an ordinary agent-authored message, not an interactive card.
    // Card `link` blocks require an absolute https URL and card actions carry no
    // navigation, and a pressable card left by a run that has ended would
    // re-enter the wake machinery. The client renders `agentHandoffDoorway` as
    // an internal navigation affordance instead.
    const doorway = await createAgentMessage(tx, runContext, {
      agentId: context.agentId,
      content:
        `I've handed this to the ${blueprint.name} — continue there and it will pick `
        + 'up from what I passed on.',
      metadata: {
        agentHandoffDoorway: AgentHandoffDoorwayMetadataSchema.parse({
          channelId: destination.id,
          targetName: blueprint.name,
          targetSlug: blueprint.slug,
          threadId: home.threadId,
        }),
      } as Prisma.InputJsonValue,
      role: 'assistant',
      threadId: runContext.run.threadId,
      ...(runContext.replyRootMessageId
        ? { rootMessageId: runContext.replyRootMessageId }
        : {}),
    })

    return { doorway, kind: 'created' as const }
  })

  if (committed.kind === 'created') {
    const reply = runContext.replyRootMessageId
      ? await applyRunReplyBookkeeping(
        context.prisma,
        runContext,
        committed.doorway.createdAt,
      )
      : undefined
    await publishMessageCreated(context.realtimeTransport, runContext, {
      content: committed.doorway.content,
      messageId: committed.doorway.id,
      role: 'assistant',
      ...(committed.doorway.basis.length > 0 ? { restricted: true } : {}),
      ...(reply ? { reply } : {}),
    })
  }

  const output = AgentHandoffToolOutputSchema.parse({
    channelId: committed.kind === 'created' ? destination.id : committed.channelId,
    status: committed.kind === 'created' ? 'handed_off' : 'already_open',
    target: blueprint.slug,
    targetName: blueprint.name,
  })
  return {
    inputSummary: `target=${blueprint.slug} briefChars=${args.brief.length}`,
    outputPreview: JSON.stringify(output),
    toolName: 'agent_handoff',
  }
}
