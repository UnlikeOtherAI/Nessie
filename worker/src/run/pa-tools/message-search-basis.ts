import { Prisma } from '@prisma/client'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'

/**
 * Disclosure rules for the agent-facing conversation searches.
 *
 * Two separate obligations, both missing before: what a search may *return*, and
 * what returning it makes of the reply.
 */

/**
 * Exclude any message carrying a disclosure basis, in raw SQL.
 *
 * `m` must be the alias of the `messages` table in the surrounding query.
 *
 * This mirrors `api/src/services/messages.ts` verbatim, for the reason stated
 * there: a search returns content snippets scoped by channel membership alone
 * and has nowhere to render a withheld placeholder, so anything carrying a basis
 * is excluded outright rather than evaluated. The agent case is the stronger
 * one — a person reading a snippet keeps it on their own screen, whereas an
 * agent can carry it into another room in its next sentence.
 */
export const UNRESTRICTED_MESSAGES_ONLY = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "message_basis_scopes" mbs WHERE mbs."message_id" = m."id"
)`

/**
 * The Prisma-query spelling of the same rule, for the searches that hydrate
 * rows through `message.findMany` rather than raw SQL.
 */
export const unrestrictedMessagesOnly = { basisScopes: { none: {} } } as const

/**
 * Record the channels a search actually read from as run provenance.
 *
 * A snippet is content: an agent that searches a channel most of the room cannot
 * see, and answers from what it found, is disclosing that channel's material.
 *
 * **Public channels are deliberately skipped.** A viewer's channel scopes are
 * built from their `ChannelMember` rows alone
 * (`packages/runtime/src/disclosure-access.ts`), so a public channel someone can
 * read but has not joined contributes no scope to them. Stamping it would
 * withhold the reply from people entitled to read the source — over-restriction,
 * and untrue besides: material anyone in the organisation may read is not
 * privileged. `protected` and `private` both count.
 */
export const recordMessageChannelRead = (
  context: Pick<BuiltinToolRuntimeContext, 'consumedSources'>,
  channels: readonly { id: string; visibility: string }[],
): void => {
  const sink = context.consumedSources
  if (!sink || channels.length === 0) {
    return
  }

  for (const channel of channels) {
    if (channel.visibility === 'public') {
      continue
    }
    sink.add({ scopeId: channel.id, scopeType: 'channel' })
  }
}
