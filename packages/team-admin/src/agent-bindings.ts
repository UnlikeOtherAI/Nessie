import type { PrismaClient } from '@prisma/client'

import type { AgentRecord } from '@nessie/schemas'
import {
  isChannelBindableAgent,
  mapAgentRecord,
} from './agent-record.js'

type AgentChannelBindingInput = {
  agentId: string
  channelId: string
  organizationId: string
  userId?: string
  /**
   * The person has been shown what this agent's browser is signed in to and
   * has accepted that the new channel's members inherit those sessions.
   * Required only when there is something to inherit.
   */
  confirmBrowserSharing?: boolean
}

export const AGENT_BINDING_ERROR_CODES = {
  PRIVATE_VISIBILITY: 'AGENT_VISIBILITY_PRIVATE',
  BROWSER_LOGINS_PRESENT: 'AGENT_BROWSER_LOGINS_PRESENT',
  CROSS_TEAM: 'AGENT_BINDING_CROSS_TEAM',
} as const

export class AgentBindingError extends Error {
  override readonly name = 'AgentBindingError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export const bindAgentToChannel = async (
  prisma: PrismaClient,
  input: AgentChannelBindingInput,
): Promise<AgentRecord | null> => {
  const [agent, channel] = await Promise.all([
    prisma.agent.findFirst({
      where: {
        id: input.agentId,
        organizationId: input.organizationId,
      },
      select: {
        agentKind: true,
        delegationMode: true,
        executionMode: true,
        model: true,
        name: true,
        provider: true,
        role: true,
        surfacePolicy: true,
        systemManaged: true,
        systemPrompt: true,
        toolPolicy: true,
        visibility: true,
        ownerUserId: true,
        teamId: true,
      },
    }),
    prisma.channel.findFirst({
      where: {
        id: input.channelId,
        organizationId: input.organizationId,
      },
      select: { systemChannelType: true, teamId: true },
    }),
  ])

  if (!agent || !channel) {
    return null
  }

  if (agent.visibility === 'private') {
    // Only the private agent's owner gets the actionable refusal. Everybody
    // else receives the same null/not-found result as an unknown id, so this
    // chokepoint cannot become an existence oracle for private agents.
    if (input.userId && agent.ownerUserId === input.userId) {
      throw new AgentBindingError(
        AGENT_BINDING_ERROR_CODES.PRIVATE_VISIBILITY,
        'Private agents cannot be added to channels.',
      )
    }
    return null
  }

  // A shared agent's browser is one cookie jar for everyone who can reach it,
  // and a team is as far as that may go. An organisation-wide Browserbase key
  // does not change this: every team's contexts then live in one project, so
  // the boundary cannot come from the account — it has to come from here.
  // Checked before any login exists, because a binding made today is still
  // there when somebody signs the agent in tomorrow.
  if (agent.teamId && channel.teamId && agent.teamId !== channel.teamId) {
    throw new AgentBindingError(
      AGENT_BINDING_ERROR_CODES.CROSS_TEAM,
      'An agent can only be added to channels in its own team. Its browser and '
      + 'anything it is signed in to are shared with everyone who can reach it, '
      + 'and that sharing stops at the team.',
    )
  }

  // No second agent may ever join a system DM. A system channel is a
  // single-agent surface by construction — one bound agent, one member — and
  // everything built on that (the `effectiveUserId = poster` stamp, the
  // orchestrator's single-candidate fast path, the design transcript staying
  // private) breaks the moment another agent can read and answer in it. The
  // refusal is therefore any non-null `systemChannelType`, not just the PA's.
  if (channel.systemChannelType) return null

  // The agent-side refusal is NOT `systemManaged`: an app-provided shared agent
  // is placeable like any other, and only the Personal Assistant (its own
  // presence path) and an external-agent product (its own per-user DM) are
  // refused here. See `isChannelBindableAgent`.
  if (!isChannelBindableAgent(agent)) return null

  // Binding widens who can reach this agent, and its browser's sign-ins are
  // shared with exactly that audience — so a bind is the moment to confront
  // them, not something to discover afterwards. Checked only for a *new*
  // binding: re-binding a channel the agent is already in widens nothing.
  if (!input.confirmBrowserSharing) {
    const alreadyBound = await prisma.agentBinding.findFirst({
      where: { agentId: input.agentId, channelId: input.channelId },
      select: { id: true },
    })
    if (!alreadyBound) {
      const browser = await prisma.agentBrowser.findFirst({
        where: {
          organizationId: input.organizationId,
          agentId: input.agentId,
          status: 'active',
        },
        select: { logins: { select: { serviceHint: true } } },
      })
      const services = [...new Set(browser?.logins.map((login) => login.serviceHint) ?? [])]
      if (services.length > 0) {
        throw new AgentBindingError(
          AGENT_BINDING_ERROR_CODES.BROWSER_LOGINS_PRESENT,
          `This agent's browser is signed in to ${services.join(', ')}. Everyone in `
          + 'that channel will be able to use those sessions through it, and to read '
          + 'what it reads. Reset the browser first, or confirm to go ahead.',
        )
      }
    }
  }

  await prisma.agentBinding.createMany({
    data: [{
      agentId: input.agentId,
      channelId: input.channelId,
    }],
    // The storage-level partial unique keeps ordinary `(agent, channel)`
    // bindings idempotent while PA presences use their own key.
    skipDuplicates: true,
  })

  const boundAgent = await prisma.agent.findFirst({
    where: {
      id: input.agentId,
      organizationId: input.organizationId,
    },
    include: {
      bindings: {
        orderBy: { createdAt: 'asc' },
        select: { channelId: true },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
        take: 1,
      },
      runs: {
        include: {
          toolCalls: {
            orderBy: { startedAt: 'desc' },
            select: {
              endedAt: true,
              startedAt: true,
              toolName: true,
            },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  return boundAgent ? mapAgentRecord(boundAgent) : null
}

/**
 * Removal must be at least as wide as placement, or a bound agent becomes
 * permanent. This filtered on `systemManaged: false`, which was symmetric only
 * while nothing system-managed could be bound; now that an app-provided shared
 * agent can be placed, the same filter would strand it in the channel forever.
 *
 * The refusal is therefore the Personal Assistant alone — its presence rows are
 * removed by the presence route, and carry a `principalUserId` this delete
 * already excludes. Every other row this path could have written, it can take
 * back; the system-*channel* refusal (bindings there are owned by their
 * bootstrap) is enforced by both callers before this is reached.
 */
export const unbindAgentFromChannel = async (
  prisma: PrismaClient,
  input: AgentChannelBindingInput,
): Promise<void> => {
  const binding = await prisma.agent.findFirst({
    where: {
      id: input.agentId,
      organizationId: input.organizationId,
      agentKind: { not: 'personal_assistant' },
      bindings: {
        some: {
          channelId: input.channelId,
          channel: {
            organizationId: input.organizationId,
            systemChannelType: null,
          },
        },
      },
    },
    select: { id: true },
  })

  if (!binding) return
  await prisma.agentBinding.deleteMany({
    where: {
      agentId: input.agentId,
      channelId: input.channelId,
      principalUserId: null,
    },
  })
}
