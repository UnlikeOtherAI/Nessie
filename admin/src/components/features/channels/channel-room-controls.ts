import type { ChannelRecord } from '../../../lib/api-client'

export type ChannelRoomControls = {
  /** The settings gear: shown only to people the server lets change the room. */
  canManageChannel: boolean
  /** A direct message opens its info panel instead of room settings. */
  canOpenConversationInfo: boolean
  /** A public room the viewer has not joined offers Join. */
  shouldJoin: boolean
}

/**
 * Which room controls the channel header offers. Kept out of the component so
 * the rule reads without a DOM: the gear is a doorway to changes, so it follows
 * `viewerCanManage` (the server's `canModifyChannel`) rather than the channel's
 * type — an unjoined public channel is readable, not manageable.
 */
export const channelRoomControls = (input: {
  activeChannel: Pick<ChannelRecord, 'memberRole' | 'type' | 'viewerCanManage' | 'visibility'> | null | undefined
  isPersonalAssistantConversation: boolean
}): ChannelRoomControls => {
  const { activeChannel, isPersonalAssistantConversation } = input
  const isRoom = Boolean(
    activeChannel && activeChannel.type !== 'dm' && !isPersonalAssistantConversation,
  )
  return {
    canManageChannel: isRoom && activeChannel?.viewerCanManage === true,
    canOpenConversationInfo: Boolean(
      activeChannel && activeChannel.type === 'dm' && !isPersonalAssistantConversation,
    ),
    shouldJoin: Boolean(
      isRoom && activeChannel?.visibility === 'public' && !activeChannel.memberRole,
    ),
  }
}
