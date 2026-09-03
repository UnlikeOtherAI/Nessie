import { parseUserId } from './ids.js'
import { withActionContext, type AuthorizedActionContext } from './access-context.js'

/**
 * The single-member private DMs whose one bound agent acts as the person it is
 * talking to: the Personal Assistant's, and a DM-homed global agent's home.
 *
 * Exactly one member — the deferred `assert_private_agent_home_members`
 * trigger holds it at rest for the `gagent:` shape, and the PA DM is reduced
 * to it at bootstrap — which is what makes `effectiveUserId = poster` true
 * there and nowhere else, and what makes the organization-wide realtime scope
 * wrong for them.
 *
 * This sentence used to exist three times (api `request-helpers`, worker
 * `delegated-identity`, each carrying a "must not drift" comment about the
 * other). One definition, imported by both processes, is the only way that
 * promise is actually kept.
 */
export const isDelegatedSystemDmChannelType = (
  value: string | null | undefined,
): value is 'personal_assistant' | 'system_agent' =>
  value === 'personal_assistant' || value === 'system_agent'

/**
 * Stamp the delegated identity a single-member system DM implies.
 *
 * A run started in one of those DMs must carry `effectiveUserId = that
 * member`, or every identity-delegated tool silently vanishes from the model's
 * function set: `resolveDelegatedRequesterUserId`
 * (`worker/src/run/delegated-identity.ts`) requires `effectiveUserId ===
 * actorId`, so an unstamped run resolves no requester and
 * `resolveIdentityDelegatedToolIds` returns the empty set. Nothing fails — the
 * agent simply, and truthfully, reports that it cannot create anything.
 *
 * That is why this is a helper and not a line of code at each wake path. It
 * shipped correct in `thread-message-create` and absent in the agent-card
 * press, which is the path the Agent Designer's whole card-driven style
 * actually uses.
 *
 * Structural on both halves: the destination's `systemChannelType`, and an
 * actor who is a person. Never the agent, never the card, never content.
 */
export const withDelegatedSystemDmIdentity = (
  actorContext: AuthorizedActionContext,
  destination: { systemChannelType?: string | null },
): AuthorizedActionContext => {
  if (actorContext.actor.actorType !== 'user') return actorContext
  if (!isDelegatedSystemDmChannelType(destination.systemChannelType)) return actorContext
  return withActionContext(actorContext, {
    effectiveUserId: parseUserId(actorContext.actor.actorId),
  })
}
