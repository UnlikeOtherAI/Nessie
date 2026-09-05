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
 * This mirrors `api/src/services/message-search.ts` verbatim, for the reason stated
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

/**
 * The same rule for a channel *directory* read (`channel_list`, `channel_find`).
 *
 * Not only message bodies are scoped material: a private channel's existence,
 * label and topic are visible to its members alone, and a delegated run
 * resolves them through the acting person's own `ChannelMember` rows
 * (`buildVisibleChannelWhere`). An agent that lists them and then names one in a
 * reply is disclosing them, so the read owes the sink its scopes — the
 * AGENTS.md rule that the obligation sits on the read, not on the reply.
 *
 * Deliberately the same implementation rather than a second mapping beside it:
 * the public-channel skip is identical and is the part most easily got wrong.
 */
export const recordChannelDirectoryRead = recordMessageChannelRead

/**
 * Provenance for an agent-directory read (`agent_list`).
 *
 * A PRIVATE agent is unambiguously privileged material, and `agent:<id>` names
 * exactly its live owner — the person a delegated run is acting as — so the
 * stamp restricts the reply to them and never silences the run against its own
 * audience.
 *
 * Team-visible rows are deliberately NOT stamped. `agent:<id>` means
 * "everybody who passes the shared live agent-visibility predicate", while
 * `listAgentsForUser` hands an organisation OWNER a strictly wider list
 * (unbound agents, and agents bound only into private channels they are not in).
 * Stamping those would compute a basis the requesting owner does not satisfy
 * and withhold the answer from the only reader of their own DM. What *is*
 * expressible about them — the non-public channels their bindings named — is
 * stamped by `recordChannelDirectoryRead` on the same read.
 */
export const recordVisibleAgentRead = (
  context: Pick<BuiltinToolRuntimeContext, 'consumedSources'>,
  agents: readonly { id: string; visibility: string }[],
): void => {
  const sink = context.consumedSources
  if (!sink) return

  for (const agent of agents) {
    if (agent.visibility !== 'private') continue
    sink.add({ scopeId: agent.id, scopeType: 'agent' })
  }
}
