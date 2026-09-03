import { createHash } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'
import { claimThreadRunOrPend } from '@nessie/db'
import {
  GlobalAgentDraftMetadataSchema,
  parseAgentId,
  parseChannelId,
  parseThreadId,
  parseUserId,
  withActionContext,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import {
  deliverGlobalAgentBrief,
  ensureGlobalAgentBootstrap,
  getGlobalAgentBlueprint,
  listGlobalAgentBlueprints,
} from '@nessie/team-admin'

import { enqueueRunExecution } from '../queue/pgqueue.js'
import type { DesignerContinueInput } from '../contracts.js'

/**
 * "Continue in chat" — moving a sidebar draft into the person's own Agent
 * Designer conversation (D9).
 *
 * The transfer reuses the `agent_handoff` mechanism exactly (one shared
 * `deliverGlobalAgentBrief`), and for the same reason: the draft becomes a
 * hidden server-authored `system` message that starts the run, never a
 * `role: 'user'` turn written under the person's id. The values inside it are
 * their own unsaved form; the frame around them is ours, and the Designer's
 * first reply is the only visible thing in the DM.
 */

/** A refusal the route turns into its status code, the service-error pattern. */
export class GlobalAgentChatError extends Error {
  override readonly name = 'GlobalAgentChatError'

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const DRAFT_FIELD_LIMIT = 8000

const describeDraft = (draft: DesignerContinueInput['formState']): string => {
  const enabled = Object.entries(draft.tools)
    .filter(([, value]) => value)
    .map(([key]) => key)

  return [
    'The person was designing an agent on the Agent Designer page and moved the',
    'conversation here. This is the draft exactly as it stands on that form,',
    'unsaved — nothing has been created yet. Pick it up from here: say what you',
    'understand it to be, and improve it with them.',
    '',
    `Name: ${draft.name || '(empty)'}`,
    `Role: ${draft.role || '(empty)'}`,
    `Model: ${draft.model ? `${draft.model} (provider ${draft.provider || 'unset'})` : '(none selected)'}`,
    `Tools enabled: ${enabled.length > 0 ? enabled.join(', ') : 'none'}`,
    '',
    'System prompt as drafted:',
    draft.systemPrompt.slice(0, DRAFT_FIELD_LIMIT) || '(empty)',
  ].join('\n')
}

export type GlobalAgentChatResult = {
  agentId: string
  channelId: string
  /** False when the conversation was busy and the draft is queued behind it. */
  started: boolean
  threadId: string
}

export const continueDesignInChat = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    body: DesignerContinueInput
    slug: string
  },
): Promise<GlobalAgentChatResult> => {
  const blueprint = getGlobalAgentBlueprint(input.slug)
  if (!blueprint || blueprint.home !== 'per_user_dm') {
    throw new GlobalAgentChatError(
      404,
      'GLOBAL_AGENT_NOT_FOUND',
      `There is no built-in specialist called "${input.slug}". Available: ${
        listGlobalAgentBlueprints().map((entry) => entry.slug).join(', ') || 'none'
      }.`,
    )
  }

  const { actor, tenant } = input.actorContext
  if (actor.actorType !== 'user') {
    throw new GlobalAgentChatError(
      403,
      'GLOBAL_AGENT_REQUIRES_PERSON',
      'A specialist conversation belongs to a person, so it cannot be opened by a service actor.',
    )
  }
  const userId = actor.actorId

  // The live membership row, exactly as every route-mirroring path re-reads it.
  const membership = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId: tenant.organizationId, userId },
    },
    select: { deactivatedAt: true, role: true },
  })
  if (!membership || membership.deactivatedAt) {
    throw new GlobalAgentChatError(
      403,
      'MEMBERSHIP_INACTIVE',
      'Your access to this organisation is not active.',
    )
  }

  // The hidden system team is seeded from a real team's project the first time
  // any global agent is bootstrapped in this organisation; afterwards the seed
  // is found by name and this value is unused. The session tenant usually
  // carries one, but it is optional on the context, so fall back to a team this
  // person actually belongs to rather than inventing one.
  const seedTeamId = tenant.teamId ?? (await prisma.teamMember.findFirst({
    where: { team: { project: { organizationId: tenant.organizationId } }, userId },
    orderBy: { createdAt: 'asc' },
    select: { teamId: true },
  }))?.teamId
  if (!seedTeamId) {
    throw new GlobalAgentChatError(
      409,
      'GLOBAL_AGENT_NO_TEAM',
      'You are not in a team in this organisation yet, so there is nowhere to open '
      + 'the conversation.',
    )
  }

  // Idempotent, and the same bootstrap login runs — the person may never have
  // opened this DM.
  const home = await ensureGlobalAgentBootstrap(prisma, {
    blueprint,
    organizationId: tenant.organizationId,
    teamId: seedTeamId,
    userId,
  })

  const content = describeDraft(input.body.formState)
  const destinationActorContext = withActionContext(input.actorContext, {
    agentId: parseAgentId(home.agentId),
    channelId: parseChannelId(home.channelId),
    effectiveUserId: parseUserId(userId),
    threadId: parseThreadId(home.threadId),
  })

  const delivered = await prisma.$transaction((tx) =>
    deliverGlobalAgentBrief(tx, { claimThreadRunOrPend, enqueueRunExecution }, {
      agentId: home.agentId,
      content,
      destinationChannelId: home.channelId,
      // A double-clicked button converges while the job row lives; a genuinely
      // different draft is a different key and always goes through.
      idempotencyKey: `gagent-draft:${userId}:${blueprint.slug}:${
        createHash('sha256').update(content).digest('hex').slice(0, 32)
      }`,
      metadata: {
        globalAgentDraft: GlobalAgentDraftMetadataSchema.parse({
          ...(input.body.editingAgentId
            ? { editingAgentId: input.body.editingAgentId }
            : {}),
          requestedByUserId: userId,
          source: 'designer_form',
          targetSlug: blueprint.slug,
        }),
      } as Prisma.InputJsonValue,
      organizationId: tenant.organizationId,
      requesterActorContext: destinationActorContext,
      threadId: home.threadId,
    }))

  return {
    agentId: home.agentId,
    channelId: home.channelId,
    started: delivered.started,
    threadId: home.threadId,
  }
}
