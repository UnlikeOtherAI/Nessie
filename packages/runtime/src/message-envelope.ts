import {
  MessageRoleSchema,
  parseAgentId,
  parseChannelId,
  parseThreadId,
  parseUserId,
  type WsScope,
} from '@nessie/schemas'

/**
 * The one `message.new` / `message.reply` envelope.
 *
 * Every surface that commits a message row announces it, and the announcement
 * used to be retyped at each site: six literal payload objects across the API
 * and the worker, each deciding for itself how to brand the ids, how long a
 * preview is, and what to put in `role`. One of them wrote `role: 'agent'`,
 * which is not a value `MessageRoleSchema` accepts — `publishWs` parses before
 * it notifies, so that announcement threw inside a bare `catch {}` and the
 * message simply never announced itself.
 *
 * This lives in `@nessie/runtime` rather than in the API because the worker
 * announces messages too: the orchestration notice, the PA's cards, the
 * mailbox hand-off and the missed-call record are all message rows a person is
 * waiting to see appear.
 *
 * What stays with the caller is the scope set — who may see this — because
 * that is a disclosure decision the destination owns
 * (`docs/standards/disclosure-boundaries.md`), and the failure policy, because
 * only the caller knows whether a dropped announcement costs a refresh or a run.
 */

/** How much of a body an announcement carries; see `MessageNewEventSchema`. */
export const MESSAGE_CONTENT_PREVIEW_LENGTH = 200

/**
 * The message being announced, as its row reads.
 *
 * `role` is the row's own value rather than a literal at the call site: the
 * wire enum is `MessageRoleSchema` (`user | assistant | system`), and anything
 * else makes `publishWs`'s parse throw.
 */
export type AnnouncedMessage = {
  agentId?: string | null
  /**
   * The text the preview is cut from. A publisher that does not hold the body
   * — a call record, a digest — passes the standing label it announces instead.
   */
  content: string
  id: string
  /**
   * Content-free announcement. WS scopes are channel- and organization-wide,
   * so a preview of a disclosure-restricted message would reach every
   * connected member regardless of entitlement; entitled clients refetch
   * through the gated list endpoint instead.
   */
  restricted?: boolean
  role: string
  userId?: string | null
}

export type MessageAnnouncement = {
  channelId: string
  message: AnnouncedMessage
  /**
   * Set when the message is a reply (#233). It selects `message.reply` over
   * `message.new`, so clients can update the reply panel without touching the
   * top-level feed.
   */
  rootMessageId?: string | null
  threadId: string
}

// Absent authorship is omitted rather than set to `undefined`: the envelope is
// compared as a value in tests and persisted as JSON, and an explicit
// `undefined` key is neither one thing nor the other.
export const buildMessageEnvelope = (input: MessageAnnouncement) => ({
  ...(input.message.agentId ? { agentId: parseAgentId(input.message.agentId) } : {}),
  ...(input.message.userId ? { authorUserId: parseUserId(input.message.userId) } : {}),
  channelId: parseChannelId(input.channelId),
  ...(input.message.restricted
    ? { restricted: true as const }
    : { contentPreview: input.message.content.slice(0, MESSAGE_CONTENT_PREVIEW_LENGTH) }),
  messageId: input.message.id,
  ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
  role: MessageRoleSchema.parse(input.message.role),
  threadId: parseThreadId(input.threadId),
})

/** Just the part of a realtime transport an announcement needs. */
export type MessageEnvelopePublisher = {
  publishWs: (
    scopes: WsScope[],
    input: { data: unknown; event: string; ts?: string },
  ) => Promise<unknown>
}

/**
 * Announce a committed message row to the given scopes.
 *
 * A reply announces as `message.reply` and a top-level post as `message.new` —
 * the same rule the run executor already applies, stated once.
 */
export const publishMessageEnvelope = async (
  publisher: MessageEnvelopePublisher,
  scopes: WsScope[],
  input: MessageAnnouncement,
): Promise<void> => {
  await publisher.publishWs(scopes, {
    data: buildMessageEnvelope(input),
    event: input.rootMessageId ? 'message.reply' : 'message.new',
  })
}
