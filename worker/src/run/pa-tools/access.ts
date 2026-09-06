import type { Prisma } from '@prisma/client'
import {
  resolveAccessibleScopes,
  type ScopeResolutionMode,
} from '@nessie/memory'
import type { SpaceViewerPrincipal } from '@nessie/knowledge'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

export type ChannelAgent = {
  id: string
  name: string
  role: string
  systemPrompt: string | null
}

// The user this run acts on behalf of: the actor itself for an interactive
// (user-actor) run, or the delegated effectiveUserId when an agent acts for a
// user (the personal assistant acting for its owner, or a DM-homed global
// agent acting for the sole member of its home DM). Null when there is no user
// to act as.
//
// VERIFIED CORRECT FOR GLOBAL AGENTS AS WRITTEN — no re-keying needed. This
// resolves from `effectiveUserId`, which the message-create route stamps for
// every delegated system DM (`isDelegatedSystemDmChannelType`), not from
// `agentKind`. `requireActingUserId` and `resolveActingMember` build on it, so
// the Agent Designer's identity tools already act as the person whose home DM
// they are running in, and `resolveActingMember` still re-reads that person's
// live `OrganizationMember` role at call time.
// Takes the actor context alone so callers that hold one without a full tool
// runtime context — the structural mailbox-send gate runs before any tool is
// built — resolve the acting user identically. They must: the gate reading
// `effectiveUserId` raw while the tool fell back to the actor left a person's
// own mailbox invisible to the gate and its send approval unpinned.
export const effectiveUserIdOfActor = (actorContext: {
  actionContext: { effectiveUserId?: string | null }
  actor: { actorId: string; actorType: string }
}): string | null =>
  actorContext.actionContext.effectiveUserId
  ?? (actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null)

export const resolveEffectiveUserId = (
  context: BuiltinToolRuntimeContext,
): string | null => effectiveUserIdOfActor(context.actorContext)

// The personal assistant is a delegate of its owner: it acts as that user and,
// unlike a shared agent, is not restricted to channels the bot is bound to. Its
// reach is still the owner's own reach (public + member channels) — being a
// delegate exempts it from the binding gate, not from the owner's visibility.
// True only when this run is the PA and it has an owner to act as.
//
// DELIBERATELY STILL PA-KEYED. Its one consumer (`schedule_task`) uses it to
// waive the *binding* check on a cross-channel target, and a DM-homed global
// agent is genuinely bound — to exactly one channel, its own home DM. Waiving
// the check for it would let it schedule posts into rooms it is not in.
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

export type ActingMember = {
  // The acting user as the actor, so a write is attributed to the person and a
  // policy check reads their live role — not the assistant agent running the loop.
  actorContext: AuthorizedActionContext
  isOwner: boolean
  organizationId: string
  role: string
  userId: string
}

/**
 * The acting user plus their CURRENT organization role.
 *
 * The API re-reads the membership row on every request rather than trusting the
 * session claim, so a demoted owner loses owner routes immediately. A run's
 * `actorContext` is a snapshot taken when the run was enqueued, which can be
 * older still — so tools that mirror an owner-gated route resolve the role here
 * instead. A membership that is absent or deactivated is refused for the same
 * reason the API rejects the request outright.
 */
export const resolveActingMember = async (
  context: BuiltinToolRuntimeContext,
): Promise<ActingMember> => {
  const userId = requireActingUserId(context)
  const organizationId = context.channel.organizationId
  const membership = await context.prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true, deactivatedAt: true },
  })
  if (!membership || membership.deactivatedAt) {
    throw new Error(
      'Your access to this organisation is not active, so I cannot do this on your behalf.',
    )
  }

  return {
    actorContext: {
      ...context.actorContext,
      actor: {
        ...context.actorContext.actor,
        actorType: 'user',
        actorId: userId,
        roles: [membership.role],
      },
    },
    isOwner: membership.role === 'owner',
    organizationId,
    role: membership.role,
    userId,
  }
}

/**
 * Owner-gated tools stay visible to everyone and explain themselves, the same
 * way the connector tools do: a member who asks gets told who can do it and
 * where, rather than watching the assistant claim it has no such capability.
 */
export const requireOwnerMember = (
  member: ActingMember,
  whatItWouldDo: string,
): void => {
  if (member.isOwner) return
  throw new Error(
    `Only an organisation owner can ${whatItWouldDo} (your role is "${member.role}"). `
    + 'Ask an owner to do it, or to make you one.',
  )
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
//
// DELIBERATELY STILL PA-KEYED, and it fails closed rather than open. A DM-homed
// global agent lands in `user_shared`, which intersects its own bindings (one:
// its home DM) with the person's reach — so conversation search returns
// essentially nothing for it. That is narrower than the delegation premise
// would allow, never wider, and none of the tools this phase opens
// (`agent_list`, `agent_create`, `agent_bind_channel`, `agent_trigger_create`,
// `channel_create`) reads through here. Widening it is a decision to take with
// the tools that need it, not a side effect of the identity gate.
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
