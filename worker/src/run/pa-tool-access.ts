import { Prisma } from '@prisma/client'
import {
  resolveAccessibleScopes,
  type ScopeResolutionMode,
} from '@nessie/memory'
import type { BuiltinToolRuntimeContext } from './tool-types.js'

// The user this run acts on behalf of: the actor itself for an interactive
// (user-actor) run, or the delegated effectiveUserId when an agent acts for a
// user (the personal assistant acting for its owner). Null when there is no
// user to act as.
export const resolveEffectiveUserId = (
  context: BuiltinToolRuntimeContext,
): string | null =>
  context.actorContext.actionContext.effectiveUserId
  ?? (context.actorContext.actor.actorType === 'user'
    ? context.actorContext.actor.actorId
    : null)

// The personal assistant is a privileged delegate of its owner: it acts as that
// user across every channel in the organization. True only when this run is the
// PA and it has an owner to act as.
export const isDelegatingPersonalAssistant = (
  context: BuiltinToolRuntimeContext,
): boolean =>
  context.agentKind === 'personal_assistant'
  && resolveEffectiveUserId(context) !== null

// The user id a tool acts as: the user actor for an interactive run, or the
// delegated owner for the personal assistant's runs. Throws when neither exists
// (a non-delegating agent has no user to act as).
export const requireActingUserId = (context: BuiltinToolRuntimeContext): string => {
  const userId = resolveEffectiveUserId(context)
  if (!userId) {
    throw new Error('This tool requires a user actor context.')
  }
  return userId
}

// Channels a delegated run may target. The personal assistant reaches every
// channel in the organization (it is its owner's delegate); everyone else is
// scoped to public channels plus the ones the acting user belongs to.
export const buildVisibleChannelWhere = (
  organizationId: string,
  userId: string,
  orgWide = false,
): Prisma.ChannelWhereInput =>
  orgWide
    ? { organizationId }
    : {
        organizationId,
        OR: [{ visibility: 'public' }, { members: { some: { userId } } }],
      }

// The set of channels an agent run may search past conversations in. Shares
// the exact access model used for curated-memory recall, so search can never
// return a conversation outside what the agent (or its acting user) can access.
export const resolveAccessibleChannelIds = async (
  context: BuiltinToolRuntimeContext,
): Promise<string[]> => {
  const pool = context.memoryCaptureConfig?.pool
  if (!pool) {
    throw new Error(
      'Conversation search requires a database pool in the runtime context.',
    )
  }

  const effectiveUserId = resolveEffectiveUserId(context)

  const isPersonalAssistant = context.agentKind === 'personal_assistant'

  // The personal assistant acts as its owner; without one there is nothing to
  // act as, so it sees nothing.
  if (isPersonalAssistant && !effectiveUserId) {
    return []
  }

  const mode: ScopeResolutionMode = isPersonalAssistant
    ? 'personal_assistant'
    : effectiveUserId
      ? 'user_shared'
      : 'autonomous'

  const scopes = await resolveAccessibleScopes(
    {
      agentId: context.agentId,
      mode,
      organizationId: context.channel.organizationId,
      userId: effectiveUserId ?? null,
    },
    pool,
  )

  return scopes.channelIds
}
