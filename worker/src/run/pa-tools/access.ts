import type { Prisma } from '@prisma/client'
import {
  resolveAccessibleScopes,
  type ScopeResolutionMode,
} from '@nessie/memory'
import type { SpaceViewerPrincipal } from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

export type ChannelAgent = {
  id: string
  name: string
  role: string
  systemPrompt: string | null
}

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

// The personal assistant is a delegate of its owner: it acts as that user and,
// unlike a shared agent, is not restricted to channels the bot is bound to. Its
// reach is still the owner's own reach (public + member channels) — being a
// delegate exempts it from the binding gate, not from the owner's visibility.
// True only when this run is the PA and it has an owner to act as.
export const isDelegatingPersonalAssistant = (
  context: BuiltinToolRuntimeContext,
): boolean =>
  context.agentKind === 'personal_assistant'
  && resolveEffectiveUserId(context) !== null

// The user id a tool acts as: the user actor for an interactive run, or the
// delegated owner for the personal assistant's runs. Throws when neither exists
// (a non-delegating agent has no user to act as).
export const requireActingUserId = (
  context: BuiltinToolRuntimeContext,
): string => {
  const userId = resolveEffectiveUserId(context)
  if (!userId) {
    throw new Error('This tool requires a user actor context.')
  }
  return userId
}

// The knowledge-base access principal for a tool call: a delegating PA (or
// interactive user run) reads/writes with the owner's own space access; an
// autonomous agent is checked against its own channel bindings / explicit
// space grants. Shared by every knowledge-base builtin tool (comments, notes,
// search, page read, listing) so the two never drift apart.
export const buildSpaceViewerPrincipal = (
  context: BuiltinToolRuntimeContext,
): SpaceViewerPrincipal => {
  const effectiveUserId = resolveEffectiveUserId(context)
  return effectiveUserId
    ? { actorType: 'user', actorId: effectiveUserId }
    : { actorType: 'agent', actorId: context.agentId }
}

// Channels a delegated run may target: public channels plus the ones the acting
// user belongs to. The personal assistant acts as its owner, so this is also its
// reach — the same channels the owner can see, never a private channel the owner
// was not admitted to.
export const buildVisibleChannelWhere = (
  organizationId: string,
  userId: string,
): Prisma.ChannelWhereInput => ({
  organizationId,
  OR: [{ visibility: 'public' }, { members: { some: { userId } } }],
})

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
