import type { ChannelRecord } from '../../../lib/api-client'

export type ChannelRoomControls = {
  /** The settings gear: shown only to people the server lets change the room. */
  canManageChannel: boolean
  /** A direct message opens its info panel instead of room settings. */
  canOpenConversationInfo: boolean
  /** A public room the viewer has not joined offers Join. */
  shouldJoin: boolean
  /**
   * The message composer. **Membership, and nothing else.**
   *
   * This is the field that carries "management is not participation"
   * (`docs/standards/team-model.md`). An organisation admin reading a room they
   * never joined gets the settings gear, the members popup and the channel info
   * — and no composer, because they may administer the room without being able
   * to speak in it. Somebody browsing a public room they have not joined gets a
   * Join action instead, and somebody looking at a protected room gets neither.
   *
   * Deliberately NOT derived from `viewerCanManage`, which is wider, nor from
   * `memberRole`, which the single-record reads do not fill.
   */
  canPost: boolean
  /** Why the composer is absent, when it is — so the room can say so. */
  postRefusal: 'join-to-post' | 'not-a-member' | null
}

/**
 * Which room controls the channel header offers. Kept out of the component so
 * the rule reads without a DOM: the gear is a doorway to changes, so it follows
 * `viewerCanManage` (the server's `canModifyChannel`) rather than the channel's
 * type — an unjoined public channel is readable, not manageable.
 */
export const channelRoomControls = (input: {
  activeChannel:
    | Pick<
      ChannelRecord,
      'memberRole' | 'type' | 'viewerCanManage' | 'viewerIsMember' | 'visibility'
    >
    | null
    | undefined
  isPersonalAssistantConversation: boolean
}): ChannelRoomControls => {
  const { activeChannel, isPersonalAssistantConversation } = input
  const isRoom = Boolean(
    activeChannel && activeChannel.type !== 'dm' && !isPersonalAssistantConversation,
  )
  // A direct message and the assistant's own home are always the viewer's to
  // write in — reaching one at all is the membership check, made server-side.
  const viewerIsMember = isRoom
    ? activeChannel?.viewerIsMember === true
    : Boolean(activeChannel)
  const shouldJoin = Boolean(
    isRoom && activeChannel?.visibility === 'public' && !viewerIsMember,
  )
  return {
    canManageChannel: isRoom && activeChannel?.viewerCanManage === true,
    canOpenConversationInfo: Boolean(
      activeChannel && activeChannel.type === 'dm' && !isPersonalAssistantConversation,
    ),
    canPost: Boolean(activeChannel) && viewerIsMember,
    postRefusal: !activeChannel || viewerIsMember
      ? null
      : shouldJoin ? 'join-to-post' : 'not-a-member',
    shouldJoin,
  }
}
