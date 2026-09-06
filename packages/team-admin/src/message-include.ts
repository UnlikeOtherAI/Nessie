import { Prisma } from '@prisma/client'

/**
 * The shape a message row is read in, wherever a message row is written.
 *
 * It lived in `api/src/services/message-read-model.ts` while the API was the
 * only process that authored messages. It is here because the worker authors
 * them too — the DeepSignal insight digest moved out of the request path
 * (docs/standards/horizontal-scaling.md § 3), and a second `include` literal in
 * the worker would be the drifted copy AGENTS.md → "Reuse the surface" names.
 * The API still re-exports it from `message-read-model.ts`, which remains the
 * bottom of its messaging stack.
 */

// Hydrate every message with its reactions and the authoring user's identity so
// the client can render the real sender name + avatar without a second lookup.
// `select` keeps the user payload to just the avatar-source fields.
export const messageInclude = {
  reactions: true,
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      avatarAttachmentId: true,
    },
  },
  // Disclosure basis: zero rows means unrestricted, which is the common case.
  // Loaded with the message so the list can withhold content the caller is not
  // entitled to without a second round trip.
  basisScopes: { select: { scopeType: true, scopeId: true } },
} satisfies Prisma.MessageInclude

export type MessageWithReactions = Prisma.MessageGetPayload<{
  include: typeof messageInclude
}>
