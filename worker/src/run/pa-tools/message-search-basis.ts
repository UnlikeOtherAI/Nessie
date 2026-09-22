import { Prisma } from '@prisma/client'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { originalHumanAuthorId } from '../execute/private-conversation-lineage.js'

/**
 * Disclosure rules for the agent-facing conversation searches.
 *
 * Two separate obligations, both missing before: what a search may *return*, and
 * what returning it makes of the reply.
 */

/**
 * Exclude internal system messages and any row carrying a disclosure basis.
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
export const UNRESTRICTED_MESSAGES_ONLY = Prisma.sql`m."role" <> 'system' AND NOT EXISTS (
  SELECT 1 FROM "message_basis_scopes" mbs WHERE mbs."message_id" = m."id"
)`

/**
 * The Prisma-query spelling of the same rule, for the searches that hydrate
 * rows through `message.findMany` rather than raw SQL.
 */
export const unrestrictedMessagesOnly = { role: { not: 'system' }, basisScopes: { none: {} } } as const

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
 * A returned private message retains original-author consent lineage.
 *
 * A non-human/legacy row can contain private conversation material but cannot
 * establish a human author. Mark that uncertainty explicitly: a known author
 * from another result in the same channel must never re-attribute it.
 */
export const recordPrivateConversationMessageRead = (
  context: Pick<BuiltinToolRuntimeContext, 'consumedSources'>,
  messages: readonly ({
    agentId: string | null
    channelId: string
    channelVisibility: string
    disclosureSources: readonly { sourceAuthorUserId: string | null; sourceChannelId: string }[]
    metadata: unknown
    onBehalfOfUserId: string | null
    role: string
    userId: string | null
  })[],
): void => {
  const sink = context.consumedSources
  if (!sink) return
  for (const message of messages) {
    if (message.channelVisibility === 'public') continue
    if (message.disclosureSources.length > 0) {
      for (const source of message.disclosureSources) {
        sink.addPrivateConversationSource(source)
      }
      continue
    }
    sink.addPrivateConversationSource({
      sourceAuthorUserId: originalHumanAuthorId(message),
      sourceChannelId: message.channelId,
    })
  }
}

/*
 * A channel *directory* read — `channel_list`, `channel_find`, the channel
 * labels `agent_list` names — deliberately feeds nothing. Listing a channel's
 * name, slug, topic and visibility is not reading what was said in it. Stamping
 * every non-public channel a list returned put each of the person's DMs into
 * the run's basis, and the project write gate then refused every ticket write
 * for the rest of the run, although no word of those rooms had been read. The
 * trade-off — a private channel's name may appear in a reply its other members
 * cannot see — is written into `docs/standards/disclosure-boundaries.md`.
 * What a channel *holds* still stamps: its messages, its attachments, and the
 * decision policy `channel_list` returns for one `channelId`.
 */

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
 * and withhold the answer from the only reader of their own DM. The channels
 * their bindings name are directory entries, which feed nothing (above).
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
