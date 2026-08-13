import {
  faCircleInfo,
  faGear,
  faMagnifyingGlass,
  faPhone,
  faStar,
  faUsers,
} from '@fortawesome/free-solid-svg-icons'
import type { ExternalAgentIdentity } from '../../../facades/integrations/hooks'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../../lib/api-client'
import { MobileMenuButton } from '../../../layouts/admin-shell/MobileMenuButton'
import { usePhoneLayout } from '../../../lib/mobile-shell'
import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from '../../shared/ResponsivePageHeader'
import type { ChannelTitleFavorite } from './ChannelFavoriteButton'
import { ConversationBackButton } from './ConversationBackButton'

interface ChannelHeaderProps {
  activeCall: boolean
  activeChannel: ChannelRecord | null
  boundAgents: AgentRecord[]
  callEligible: boolean
  channelUsers: UserRecord[]
  externalAgentIdentity: ExternalAgentIdentity | null
  isExternalAgentConversation: boolean
  isInCall: boolean
  isConversationDetail: boolean
  isPersonalAssistantConversation: boolean
  joinPending: boolean
  onCallButton: () => void
  onBack: () => void
  onOpenInfo: () => void
  onJoin: () => void
  onOpenMembers: () => void
  onOpenSettings: () => void
  onToggleSearch: () => void
  searchOpen: boolean
  titleFavorite: ChannelTitleFavorite | null
}

// Conversation controls share the same priority policy as route headers. This
// prevents member, call and search controls from squeezing the channel title on
// a phone or a narrow tablet pane while preserving every action in More.
export const ChannelHeader = ({
  activeCall,
  activeChannel,
  boundAgents,
  callEligible,
  channelUsers,
  externalAgentIdentity,
  isExternalAgentConversation,
  isInCall,
  isConversationDetail,
  isPersonalAssistantConversation,
  joinPending,
  onCallButton,
  onBack,
  onJoin,
  onOpenInfo,
  onOpenMembers,
  onOpenSettings,
  onToggleSearch,
  searchOpen,
  titleFavorite,
}: ChannelHeaderProps) => {
  const phoneLayout = usePhoneLayout()
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
  const callLabel = isPersonalAssistantConversation
    ? 'Personal Assistant does not support calls'
    : callEligible
      ? activeCall
        ? isInCall ? 'Toggle call overlay' : 'Join call'
        : 'Start a call'
      : 'You can only start a call with humans for now'
  const participantCount = channelUsers.length + boundAgents.length
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
    {
      compact: true,
      disabled: !callEligible,
      icon: faPhone,
      id: 'call',
      label: callLabel,
      onSelect: onCallButton,
      priority: 50,
      selected: activeCall || isInCall,
    },
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
    <ResponsivePageHeader
      actions={actions}
      eyebrow={
        isPersonalAssistantConversation
          ? 'System managed'
          : isExternalAgentConversation
            ? externalAgentIdentity?.description ?? undefined
            : undefined
      }
      leading={
        phoneLayout && isConversationDetail
          ? <ConversationBackButton onBack={onBack} />
          : <MobileMenuButton />
      }
      title={title}
    />
  )
}
