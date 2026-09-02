import {
  faCircleDot,
  faCircleInfo,
  faGear,
  faMagnifyingGlass,
  faPhone,
  faStar,
  faUsers,
} from '@fortawesome/free-solid-svg-icons'
import type { ExternalAgentIdentity } from '../../../facades/integrations/hooks'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../../lib/api-client'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'
import { ScreenHeader } from '../../shared/ScreenHeader'
import type { ChannelTitleFavorite } from './ChannelFavoriteButton'

interface ChannelHeaderProps {
  activeCall: boolean
  activeChannel: ChannelRecord | null
  boundAgents: AgentRecord[]
  callEligible: boolean
  callMeetingUri: string | null | undefined
  callStarting: boolean
  channelUsers: UserRecord[]
  externalAgentIdentity: ExternalAgentIdentity | null
  isExternalAgentConversation: boolean
  isPersonalAssistantConversation: boolean
  personalAssistantPresenceCount: number
  joinPending: boolean
  onCallButton: () => void
  onOpenInfo: () => void
  onJoin: () => void
  onOpenMembers: () => void
  onOpenSettings: () => void
  onToggleRoutineRecording: () => void
  onToggleSearch: () => void
  searchOpen: boolean
  routineRecording: boolean
  titleFavorite: ChannelTitleFavorite | null
  /** A Gemini voice call is up in this conversation. */
  voiceCallActive: boolean
  /**
   * This conversation takes voice calls rather than provider-linked ones.
   * Structural — it follows from the channel being the Personal Assistant DM,
   * never from anything said in it.
   */
  voiceCallSupported: boolean
}

// Conversation controls share the same priority policy as route headers. This
// prevents member, call and search controls from squeezing the channel title on
// a phone or a narrow tablet pane while preserving every action in More.
export const ChannelHeader = ({
  activeCall,
  activeChannel,
  boundAgents,
  callEligible,
  callMeetingUri,
  callStarting,
  channelUsers,
  externalAgentIdentity,
  isExternalAgentConversation,
  isPersonalAssistantConversation,
  personalAssistantPresenceCount,
  joinPending,
  onCallButton,
  onJoin,
  onOpenInfo,
  onOpenMembers,
  onOpenSettings,
  onToggleRoutineRecording,
  onToggleSearch,
  searchOpen,
  routineRecording,
  voiceCallActive,
  voiceCallSupported,
  titleFavorite,
}: ChannelHeaderProps) => {
  const title = isPersonalAssistantConversation
    ? 'Personal Assistant'
    : isExternalAgentConversation
      ? externalAgentIdentity?.name ?? activeChannel?.label ?? 'Channels'
      : activeChannel?.label ?? 'Channels'
  const canManageChannel = Boolean(
    activeChannel && activeChannel.type !== 'dm' && !isPersonalAssistantConversation,
  )
  const canOpenConversationInfo = Boolean(
    activeChannel && activeChannel.type === 'dm' && !isPersonalAssistantConversation,
  )
  const shouldJoin = Boolean(
    canManageChannel && activeChannel?.visibility === 'public' && !activeChannel.memberRole,
  )
  // One call button for every conversation; what it starts is decided by the
  // kind of conversation, not by a second control. In the Personal Assistant
  // DM it opens a live voice call with the assistant; everywhere else it mints
  // a provider-linked meeting and rings people.
  const callLabel = voiceCallSupported
    ? voiceCallActive
      ? 'Call in progress'
      : 'Call your assistant'
    : callStarting
      ? 'Starting call…'
      : callEligible
        ? activeCall
          ? 'Join call'
          : 'Start a call'
        : 'You can only start a call with humans for now'
  const participantCount = channelUsers.length + boundAgents.length + personalAssistantPresenceCount
  const actions: PageHeaderAction[] = [
    ...(titleFavorite ? [{
      compact: true,
      disabled: titleFavorite.isPending,
      icon: faStar,
      id: 'favorite',
      label: titleFavorite.isFavorite ? 'Remove favorite' : 'Add favorite',
      onSelect: titleFavorite.onToggle,
      pressed: titleFavorite.isFavorite,
      priority: 90,
      selected: titleFavorite.isFavorite,
    } satisfies PageHeaderAction] : []),
    ...(canOpenConversationInfo ? [{
      compact: true,
      icon: faCircleInfo,
      id: 'conversation-info',
      label: 'Conversation info',
      onSelect: onOpenInfo,
      priority: 80,
    } satisfies PageHeaderAction] : !isPersonalAssistantConversation ? [{
      icon: faUsers,
      id: 'members',
      label: `Members (${participantCount})`,
      onSelect: onOpenMembers,
      priority: 80,
    } satisfies PageHeaderAction] : []),
    ...(shouldJoin ? [{
      disabled: joinPending,
      id: 'join',
      label: 'Join',
      onSelect: onJoin,
      primary: true,
      priority: 100,
    } satisfies PageHeaderAction] : []),
    ...(canManageChannel ? [{
      compact: true,
      icon: faGear,
      id: 'settings',
      label: 'Channel settings',
      onSelect: onOpenSettings,
      priority: 60,
    } satisfies PageHeaderAction] : []),
    ...(boundAgents.length > 0 ? [{
      compact: true,
      icon: faCircleDot,
      id: 'record-routine',
      label: routineRecording ? 'Recording routine' : 'Record routine',
      onSelect: onToggleRoutineRecording,
      priority: 55,
      selected: routineRecording,
    } satisfies PageHeaderAction] : []),
    activeCall && callMeetingUri && !voiceCallSupported
      ? {
          compact: true,
          href: callMeetingUri,
          icon: faPhone,
          id: 'call',
          kind: 'link',
          label: callLabel,
          priority: 50,
          rel: 'noopener noreferrer',
          selected: true,
          target: '_blank',
        } satisfies PageHeaderAction
      : {
          compact: true,
          disabled: voiceCallSupported
            ? false
            : !callEligible || activeCall || callStarting,
          icon: faPhone,
          id: 'call',
          label: callLabel,
          onSelect: onCallButton,
          priority: 50,
          selected: voiceCallSupported ? voiceCallActive : activeCall,
        } satisfies PageHeaderAction,
    {
      compact: true,
      icon: faMagnifyingGlass,
      id: 'search',
      label: 'Search messages',
      onSelect: onToggleSearch,
      pressed: searchOpen,
      priority: 40,
      selected: searchOpen,
    },
  ]

  return (
    <ScreenHeader
      actions={actions}
      eyebrow={
        isPersonalAssistantConversation
          ? 'System managed'
          : isExternalAgentConversation
            ? externalAgentIdentity?.description ?? undefined
            : undefined
      }
      title={title}
    />
  )
}
