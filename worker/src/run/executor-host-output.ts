import type { BasisScope, ConsumedSourceSink } from './execute/disclosure-basis.js'

/**
 * Host program output is the launch conversation's.
 *
 * A local program on the person's machine answers from that machine: a real
 * browser profile, private repositories, whatever the owner's session can
 * reach. Nothing about it is public web, so every `mcp.*` result enters the
 * run's disclosure basis with the scope of the conversation the person
 * launched local apps in. Launching there is the person's consent to show the
 * program's output to that conversation's audience, and nowhere else: a reply
 * in the same conversation is unaffected, a write onto the board of the
 * project a public channel belongs to is allowed (`assertProjectWriteDestination`),
 * and every other destination is contained by the basis.
 *
 * The scope is stamped even when the channel is public, unlike a transcript
 * turn's: a public room's history is the organisation's to read, but the
 * program's output was only ever consented to that room.
 *
 * See docs/standards/disclosure-boundaries.md and executor-local-mcp.md.
 */
export type ExecutorHostOutputDisclosure = {
  /** The launch conversation's scope. */
  launchScope: BasisScope
  sink: ConsumedSourceSink
}

/** The operations that return a local program's own output. */
export const HOST_OUTPUT_OPERATION_KEYS: ReadonlySet<string> = new Set(['mcp.tools', 'mcp.call'])

/**
 * The launch conversation of a run's own local-apps launch: the run's channel.
 * A launch carried across a person's follow-ups would name the conversation it
 * was made in instead.
 */
export const launchConversationScope = (channelId: string): BasisScope => ({
  scopeId: channelId,
  scopeType: 'channel',
})
