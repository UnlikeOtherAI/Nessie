import { Prisma, type PrismaClient } from '@prisma/client'
import {
  buildAddress,
  localPartRejectionMessage,
  normalizeDomain,
  suggestLocalParts,
  validateLocalPart,
} from '@nessie/agent-mail'

/**
 * Hosted agent mailbox lifecycle — the one implementation the API routes call,
 * so a future personal-assistant tool mirrors the route rather than forking it.
 *
 * Claiming an address mints an externally visible identity for the whole
 * organisation, so the lifecycle is owner-gated. Eligibility is deliberately
 * narrow (§3 of the plan): a non-system, inference-mode, org-bound,
 * workspace-visible agent. Private agents are excluded because the private-agent
 * placement guard permits runs only in the exact home DM or the agent's own
 * trigger thread — a mailbox channel would be refused before inference, and
 * widening that guard is its own decision rather than a side effect of this one.
 */

export type MailboxRefusal =
  | 'agent_not_found'
  | 'agent_ineligible_system'
  | 'agent_ineligible_private'
  | 'agent_ineligible_external'
  | 'agent_ineligible_child'
  | 'already_has_mailbox'
  | 'address_taken'
  | 'invalid_local_part'
  | 'domain_not_verified'
  | 'not_owner'

export class AgentMailboxError extends Error {
  constructor(
    readonly refusal: MailboxRefusal,
    message: string,
    readonly suggestions: string[] = [],
  ) {
    super(message)
    this.name = 'AgentMailboxError'
  }
}

export type MailboxAgent = {
  id: string
  name: string
  organizationId: string | null
  systemManaged: boolean
  agentKind: string
  visibility: string
  executionMode: string
  parentAgentId: string | null
  projectId: string | null
  teamId: string | null
}

/**
 * Structural eligibility. Refuses in words rather than hiding the option, so a
 * person asking "why can't this agent have an address" gets an answer.
 */
export const assertMailboxEligible = (agent: MailboxAgent): void => {
  if (agent.systemManaged || agent.agentKind === 'personal_assistant' || !agent.organizationId) {
    throw new AgentMailboxError(
      'agent_ineligible_system',
      'System-managed agents and the personal assistant act as people, not as their own '
      + 'correspondents, so they cannot hold an address.',
    )
  }
  if (agent.executionMode !== 'inference') {
    throw new AgentMailboxError(
      'agent_ineligible_external',
      'This agent runs on an external product, so Nessie does not compose its replies and '
      + 'cannot hold a mailbox for it.',
    )
  }
  if (agent.visibility === 'private') {
    throw new AgentMailboxError(
      'agent_ineligible_private',
      'A private agent may only run in its own home conversation, so it cannot yet own a '
      + 'mailbox. Publish the agent to the workspace first.',
    )
  }
  if (agent.parentAgentId) {
    throw new AgentMailboxError(
      'agent_ineligible_child',
      'Delegated sub-agents are transient and cannot hold a lasting address.',
    )
  }
}

export type CreateMailboxInput = {
  agentId: string
  organizationId: string
  localPart: string
  /** Verified custom domain, or null for the deployment's default domain. */
  domainId?: string | null
  defaultDomain: string
  displayName?: string | null
  createdByUserId: string
}

export type MailboxRecord = {
  id: string
  agentId: string
  address: string
  channelId: string
  status: string
  statusReason: string | null
  sendPolicy: string
  displayName: string | null
  domain: string
  createdAt: Date
}

const CHANNEL_LABEL = (agentName: string, address: string): string =>
  `${agentName} — ${address}`

/**
 * A standard channel must carry a slug (`channels_standard_slug_required`).
 * Derived from the address so the room is findable by the name people already
 * know it by, and suffixed with the mailbox's own uniqueness rather than a
 * retry loop — the address is already unique per deployment.
 */
const channelSlugForAddress = (address: string): string =>
  `mail-${address.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()}`

/**
 * Create the mailbox, its backing channel and that channel's default thread in
 * one transaction. A half-made mailbox — an address with no room to work in, or
 * a channel nothing routes to — is not a state anything should have to handle.
 */
export const createAgentMailbox = async (
  prisma: PrismaClient,
  input: CreateMailboxInput,
): Promise<MailboxRecord> => {
  const validated = validateLocalPart(input.localPart)
  if (!validated.ok) {
    throw new AgentMailboxError('invalid_local_part', localPartRejectionMessage(validated.reason))
  }

  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, organizationId: input.organizationId },
    select: {
      agentKind: true,
      executionMode: true,
      id: true,
      mailbox: { select: { id: true } },
      name: true,
      organizationId: true,
      parentAgentId: true,
      projectId: true,
      systemManaged: true,
      teamId: true,
      visibility: true,
    },
  })
  if (!agent) {
    throw new AgentMailboxError('agent_not_found', 'Agent not found.')
  }
  assertMailboxEligible(agent as MailboxAgent)
  if (agent.mailbox) {
    throw new AgentMailboxError(
      'already_has_mailbox',
      'This agent already has an address. One mailbox per agent — a second agent is cheap.',
    )
  }

  let domainName = normalizeDomain(input.defaultDomain)
  if (input.domainId) {
    const domain = await prisma.emailDomain.findFirst({
      where: { id: input.domainId, organizationId: input.organizationId },
      select: { domain: true, status: true },
    })
    if (!domain || domain.status !== 'verified') {
      throw new AgentMailboxError(
        'domain_not_verified',
        'That domain is not verified for sending yet.',
      )
    }
    domainName = domain.domain
  }

  const address = buildAddress(validated.localPart, domainName)

  // A retired address keeps its row precisely so this check still sees it: a
  // recycled local part must never inherit an old correspondent's trust.
  const taken = await prisma.agentMailbox.findUnique({
    where: { address },
    select: { id: true },
  })
  if (taken) {
    const siblings = await prisma.agentMailbox.findMany({
      where: { address: { endsWith: `@${domainName}` } },
      select: { address: true },
    })
    const takenLocalParts = new Set(
      siblings.map((row) => row.address.slice(0, row.address.lastIndexOf('@'))),
    )
    throw new AgentMailboxError(
      'address_taken',
      `${address} is already claimed on this deployment.`,
      suggestLocalParts(validated.localPart, takenLocalParts).map((part) =>
        buildAddress(part, domainName),
      ),
    )
  }

  const { projectId, teamId } = await resolveMailboxScope(prisma, agent)

  try {
    return await prisma.$transaction(async (tx) => {
      const channel = await tx.channel.create({
        data: {
          description:
            'Run reports, approval gates and the human conversation about this mailbox. '
            + 'The mail itself lives in the mailbox view.',
          label: CHANNEL_LABEL(agent.name, address),
          organizationId: input.organizationId,
          projectId,
          slug: channelSlugForAddress(address),
          systemChannelType: 'agent_email',
          teamId,
          // Workspace-visible agents only (see assertMailboxEligible), so the
          // operations room matches the agent's own reach. There is no
          // "team-visible" channel entitlement to invent here.
          visibility: 'public',
        },
        select: { id: true },
      })
      await tx.thread.create({
        data: { channelId: channel.id, title: 'Mailbox' },
      })
      await tx.agentBinding.create({
        data: { agentId: agent.id, channelId: channel.id },
      })
      const mailbox = await tx.agentMailbox.create({
        data: {
          address,
          agentId: agent.id,
          channelId: channel.id,
          createdByUserId: input.createdByUserId,
          displayName: input.displayName ?? agent.name,
          domainId: input.domainId ?? null,
          organizationId: input.organizationId,
        },
        select: {
          address: true,
          agentId: true,
          channelId: true,
          createdAt: true,
          displayName: true,
          id: true,
          sendPolicy: true,
          status: true,
          statusReason: true,
        },
      })
      return { ...mailbox, domain: domainName }
    })
  } catch (error) {
    // Two owners claiming the same name at once: the unique index decides, and
    // the loser is told rather than shown a stack trace.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AgentMailboxError(
        'address_taken',
        `${address} was claimed a moment ago. Pick another name.`,
      )
    }
    throw error
  }
}

/**
 * Where the mailbox channel lives. An agent bound to a team keeps its
 * correspondence there; an unbound agent falls back to the organisation's
 * channel-root project, the same home standalone channels use.
 */
const resolveMailboxScope = async (
  prisma: PrismaClient,
  agent: { organizationId: string | null; projectId: string | null; teamId: string | null },
): Promise<{ projectId: string; teamId: string }> => {
  if (agent.projectId && agent.teamId) {
    return { projectId: agent.projectId, teamId: agent.teamId }
  }
  const team = await prisma.team.findFirst({
    where: {
      project: { channelRoot: true, organizationId: agent.organizationId ?? undefined },
      systemManaged: true,
    },
    select: { id: true, projectId: true },
  })
  if (team) return { projectId: team.projectId, teamId: team.id }

  const fallback = await prisma.team.findFirst({
    where: { project: { organizationId: agent.organizationId ?? undefined } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, projectId: true },
  })
  if (!fallback) {
    throw new AgentMailboxError(
      'agent_not_found',
      'This organisation has no team to host the mailbox conversation.',
    )
  }
  return { projectId: fallback.projectId, teamId: fallback.id }
}

export const loadAgentMailbox = async (
  prisma: PrismaClient,
  input: { agentId: string; organizationId: string },
): Promise<MailboxRecord | null> => {
  const mailbox = await prisma.agentMailbox.findFirst({
    where: {
      agentId: input.agentId,
      organizationId: input.organizationId,
      retiredAt: null,
    },
    select: {
      address: true,
      agentId: true,
      channelId: true,
      createdAt: true,
      displayName: true,
      id: true,
      sendPolicy: true,
      status: true,
      statusReason: true,
    },
  })
  if (!mailbox) return null
  return { ...mailbox, domain: mailbox.address.slice(mailbox.address.lastIndexOf('@') + 1) }
}

export type UpdateMailboxInput = {
  mailboxId: string
  organizationId: string
  sendPolicy?: 'approval' | 'auto_reply' | 'auto'
  displayName?: string | null
}

export const updateAgentMailbox = async (
  prisma: PrismaClient,
  input: UpdateMailboxInput,
): Promise<MailboxRecord | null> => {
  const updated = await prisma.agentMailbox.updateMany({
    data: {
      ...(input.sendPolicy ? { sendPolicy: input.sendPolicy } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    },
    where: { id: input.mailboxId, organizationId: input.organizationId, retiredAt: null },
  })
  if (updated.count === 0) return null
  const mailbox = await prisma.agentMailbox.findUnique({
    where: { id: input.mailboxId },
    select: { agentId: true, organizationId: true },
  })
  if (!mailbox) return null
  return loadAgentMailbox(prisma, {
    agentId: mailbox.agentId,
    organizationId: mailbox.organizationId,
  })
}

/**
 * Retire a mailbox. The row and the whole correspondence are kept — read-only —
 * and the address stays off the market permanently. The backing channel is
 * archived rather than deleted, so the discussion about the mail survives too.
 */
export const retireAgentMailbox = async (
  prisma: PrismaClient,
  input: { mailboxId: string; organizationId: string },
): Promise<boolean> =>
  prisma.$transaction(async (tx) => {
    const claimed = await tx.agentMailbox.updateMany({
      data: { retiredAt: new Date(), status: 'suspended', statusReason: 'Mailbox deleted.' },
      where: { id: input.mailboxId, organizationId: input.organizationId, retiredAt: null },
    })
    if (claimed.count === 0) return false
    const mailbox = await tx.agentMailbox.findUnique({
      where: { id: input.mailboxId },
      select: { channelId: true },
    })
    if (mailbox) {
      await tx.channel.update({
        data: { archivedAt: new Date() },
        where: { id: mailbox.channelId },
      })
    }
    return true
  })

/**
 * Resolve the mailbox an inbound envelope recipient names. Retired and
 * suspended mailboxes resolve to null: mail to a retired address is dropped
 * rather than delivered to whoever holds the agent now.
 */
export const resolveMailboxByAddress = async (
  prisma: PrismaClient,
  address: string,
): Promise<{
  id: string
  organizationId: string
  agentId: string
  channelId: string
  address: string
  sendPolicy: string
} | null> =>
  prisma.agentMailbox.findFirst({
    where: { address: address.toLowerCase(), retiredAt: null, status: 'active' },
    select: {
      address: true,
      agentId: true,
      channelId: true,
      id: true,
      organizationId: true,
      sendPolicy: true,
    },
  })
