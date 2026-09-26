export type ConversationRouteStep = 'add-members' | 'conversation' | 'info' | 'members'

export type ConversationRoute = {
  channelId: string
  step: ConversationRouteStep
}

const channelRoutePattern = /^\/channels\/([^/?#]+)(?:\/(.*))?$/

// Conversation destinations remain URL-addressable because the same routes are
// opened from the desktop sidebar, mobile tabs, notifications, and the WebView.
// This also gives every nested mobile screen a deterministic Back destination
// when a notification opened it without browser history.
//
// `info` and `members` are one screen — a conversation's Details, at its
// General (or another `?section=`) and its People section — so both return
// to the conversation; adding people is the one screen deeper, over People.
export const getConversationRoute = (pathname: string): ConversationRoute | null => {
  const match = pathname.match(channelRoutePattern)
  if (!match) return null

  const [, channelId, remainder = ''] = match
  if (!channelId) return null

  if (remainder === 'info') return { channelId, step: 'info' }
  if (remainder === 'info/members') return { channelId, step: 'members' }
  if (remainder === 'info/members/add') return { channelId, step: 'add-members' }

  // Reply-thread routes still sit over a conversation, so the phone Back
  // affordance returns to the Channels root rather than opening Details.
  return { channelId, step: 'conversation' }
}

/** True on any of the three Details routes. */
export const isConversationDetailsRoute = (route: ConversationRoute | null): boolean =>
  route !== null && route.step !== 'conversation'

export const conversationParentPath = (route: ConversationRoute): string => {
  const channelPath = `/channels/${route.channelId}`

  switch (route.step) {
    case 'add-members':
      return `${channelPath}/info/members`
    case 'members':
    case 'info':
      return channelPath
    case 'conversation':
      return '/channels'
  }
}
