import type { PrismaClient } from '@prisma/client'
import { isAgentVisibleToUser } from '@nessie/team-admin'

/**
 * The entitlement questions the realtime hub asks again at delivery time.
 *
 * A socket is one request. `authenticateRequest` was hardened so revocation
 * takes effect on the next request rather than at token expiry, which for a
 * WebSocket or an SSE stream means: never. So subscription-time authorization
 * is only half the rule — every scope a connection holds is re-asked on the way
 * out, and an opaque id is never an entitlement.
 *
 * Channel and dashboard scopes already worked this way. Organization, agent and
 * thread-stream scopes did not: a deactivated member kept a live org-scoped
 * feed, and a person removed from a private channel kept that channel's thread
 * stream, until they happened to disconnect.
 */
export type RealtimeDeliveryEntitlements = {
  canAccessAgentEvent: (input: {
    agentId: string
    organizationId: string
    userId: string
  }) => Promise<boolean>
  canAccessOrganizationEvent: (input: {
    organizationId: string
    userId: string
  }) => Promise<boolean>
  resolveThreadChannelId: (threadId: string) => Promise<string | null>
}

/**
 * Memoize an async predicate for `ttlMs`.
 *
 * The re-check has to be cheap enough to run on the hottest lane in the system:
 * a thread SSE stream emits one `stream.delta` per model token, so an
 * unmemoized membership query would be one round trip per token. A short window
 * keeps the worst-case exposure after a revocation to that window — bounded,
 * and far shorter than the connection lifetimes it replaces — while collapsing
 * a burst of hundreds of events into a single query.
 */
export const REALTIME_ENTITLEMENT_TTL_MS = 5_000

export const createEntitlementGate = <TKey extends string>(
  load: (key: TKey) => Promise<boolean>,
  options: { now?: () => number; ttlMs?: number } = {},
): ((key: TKey) => Promise<boolean>) => {
  const ttlMs = options.ttlMs ?? REALTIME_ENTITLEMENT_TTL_MS
  const now = options.now ?? Date.now
  const cache = new Map<TKey, { allowed: boolean; expiresAt: number }>()

  return async (key: TKey): Promise<boolean> => {
    const cached = cache.get(key)
    const at = now()
    if (cached && cached.expiresAt > at) {
      return cached.allowed
    }
    const allowed = await load(key)
    cache.set(key, { allowed, expiresAt: at + ttlMs })
    return allowed
  }
}

/**
 * The production predicates, read live from Postgres.
 *
 * Organization membership is the deactivation gate: `services/users.ts` clears
 * refresh families and auth sessions on deactivation but closes no socket, so
 * this row is the only thing standing between a deactivated person and the
 * feed they already hold.
 */
export const createRealtimeDeliveryEntitlements = (
  prisma: PrismaClient,
): RealtimeDeliveryEntitlements => ({
  canAccessAgentEvent: async (input) =>
    isAgentVisibleToUser(prisma, input.userId, input.organizationId, input.agentId),
  canAccessOrganizationEvent: async (input) =>
    (await prisma.organizationMember.count({
      where: {
        deactivatedAt: null,
        organizationId: input.organizationId,
        userId: input.userId,
      },
    })) > 0,
  // A thread never moves between channels, so the owning channel is resolved
  // once per connection; it is the entitlement on that channel that is re-asked.
  resolveThreadChannelId: async (threadId) =>
    (
      await prisma.thread.findUnique({
        select: { channelId: true },
        where: { id: threadId },
      })
    )?.channelId ?? null,
})
