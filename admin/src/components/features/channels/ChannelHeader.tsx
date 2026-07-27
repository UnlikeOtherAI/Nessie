import type { ExternalAgentIdentity } from '../../../facades/integrations/hooks'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../../lib/api-client'
import { MobileMenuButton } from '../../../layouts/admin-shell/MobileMenuButton'
import { UserAvatar } from '../../primitives/UserAvatar'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { toolbarButtonClass } from './channel-helpers'
import { ChannelFavoriteButton, type ChannelTitleFavorite } from './ChannelFavoriteButton'

// A channel-header member avatar (real picture, initials fallback) with the
// overlapping-stack ring. Reads the token itself so the header stays prop-light.
const HeaderMemberAvatar = ({ user }: { user: UserRecord }) => {
  const { token } = useAuthSession()
  return (
    <UserAvatar
      avatarAttachmentId={user.avatarAttachmentId ?? undefined}
      avatarUrl={user.avatarUrl ?? undefined}
      className="border-2 border-[color:var(--main)]"
      displayName={user.displayName}
      gravatarUrl={user.gravatarUrl ?? undefined}
      size={24}
      token={token}
      userId={user.id}
    />
  )
}

const HeaderAgentAvatar = ({ agent }: { agent: AgentRecord }) => {
  const { token } = useAuthSession()
  return (
    <AgentAvatar
      agent={agent}
      className="border-2 border-[color:var(--main)]"
      shape="circle"
      size="xs"
      token={token}
    />
  )
}

interface ChannelHeaderProps {
  activeChannel: ChannelRecord | null
  isPersonalAssistantConversation: boolean
  // A first-class external-agent DM (DeepSignal, ...): render its non-human
  // product glyph + function-first identity instead of a generic DM avatar.
  isExternalAgentConversation: boolean
  externalAgentIdentity: ExternalAgentIdentity | null
  channelUsers: UserRecord[]
  boundAgents: AgentRecord[]
  callEligible: boolean
  activeCall: boolean
  isInCall: boolean
  searchOpen: boolean
  joinPending: boolean
  titleFavorite: ChannelTitleFavorite | null
  onOpenMembers: () => void
  onCallButton: () => void
  onOpenSettings: () => void
  onJoin: () => void
  onToggleSearch: () => void
}

export const ChannelHeader = ({
  activeChannel,
  isPersonalAssistantConversation,
  isExternalAgentConversation,
  externalAgentIdentity,
  channelUsers,
  boundAgents,
  callEligible,
  activeCall,
  isInCall,
  searchOpen,
  joinPending,
  titleFavorite,
  onOpenMembers,
  onCallButton,
  onOpenSettings,
  onJoin,
  onToggleSearch,
}: ChannelHeaderProps) => (
  <header className="flex h-[50px] items-center border-b border-[color:var(--sep)] px-5">
    <MobileMenuButton />
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {isPersonalAssistantConversation ? (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[9px] font-bold text-[var(--thinking)]">
          ⚡
        </div>
      ) : isExternalAgentConversation ? (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[9px] font-bold text-[var(--thinking)]">
          {externalAgentIdentity?.iconGlyph
            ?? (externalAgentIdentity?.name ?? activeChannel?.label ?? 'A').slice(0, 1).toUpperCase()}
        </div>
      ) : activeChannel?.type === 'dm' ? (
        <div
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-[var(--on-accent)]"
          style={{
            background: 'linear-gradient(135deg,var(--accent-hover),var(--accent-strong))',
          }}
        >
          {activeChannel.label.slice(0, 1).toUpperCase()}
        </div>
      ) : (
        <span className="flex-shrink-0 text-lg font-bold text-[color:var(--tx3)]">
          #
        </span>
      )}
      <h1 className="truncate text-[17px] font-bold text-[var(--tx)]">
        {isPersonalAssistantConversation
          ? 'Personal Assistant'
          : isExternalAgentConversation
            ? externalAgentIdentity?.name ?? activeChannel?.label ?? 'channels'
            : activeChannel?.label ?? 'channels'}
      </h1>
      <ChannelFavoriteButton favorite={titleFavorite} />
      {isPersonalAssistantConversation && (
        <span className="rounded bg-[var(--overlay-weak)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          system managed
        </span>
      )}
      {isExternalAgentConversation && externalAgentIdentity?.description ? (
        <span className="hidden min-w-0 truncate text-xs text-[color:var(--tx3)] sm:inline">
          {externalAgentIdentity.description}
        </span>
      ) : null}
    </div>

    <div className="flex flex-shrink-0 items-center gap-2">
      <button
        className={[
          'flex items-center gap-2 rounded-lg px-2 py-1',
          isPersonalAssistantConversation ? 'cursor-default opacity-90' : 'hover:bg-[var(--overlay-weak)]',
        ].join(' ')}
        onClick={() => {
          if (!isPersonalAssistantConversation) {
            onOpenMembers()
          }
        }}
        title={
          isPersonalAssistantConversation
            ? 'Personal Assistant is system-managed'
            : 'View channel members'
        }
        type="button"
      >
        <div className="flex -space-x-1.5">
          {channelUsers.slice(0, 3).map((user) => (
            <HeaderMemberAvatar key={user.id} user={user} />
          ))}
          {boundAgents.slice(0, Math.max(0, 4 - channelUsers.length)).map((agent) => (
            <HeaderAgentAvatar agent={agent} key={agent.id} />
          ))}
        </div>
        <span className="text-sm text-[color:var(--tx2)]">
          {channelUsers.length + boundAgents.length}
        </span>
      </button>
      {activeChannel
        && activeChannel.type !== 'dm'
        && !isPersonalAssistantConversation
        && activeChannel.visibility === 'public'
        && !activeChannel.memberRole ? (
        <button
          className="admin-button admin-button-secondary admin-button-compact h-7"
          disabled={joinPending}
          onClick={onJoin}
          type="button"
        >
          Join
        </button>
      ) : null}
      {activeChannel
        && activeChannel.type !== 'dm'
        && !isPersonalAssistantConversation ? (
        <button
          className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx3)] hover:bg-[var(--overlay)]"
          onClick={onOpenSettings}
          title="Channel settings"
          type="button"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <path
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
      <button
        className={[
          'relative flex h-7 w-7 items-center justify-center rounded',
          callEligible
            ? isInCall
              ? 'text-[var(--success-text)] hover:bg-[var(--overlay)]'
              : 'text-[color:var(--tx3)] hover:bg-[var(--overlay)]'
          : 'cursor-not-allowed text-[color:var(--tx3)] opacity-40',
        ].join(' ')}
        disabled={!callEligible}
        onClick={onCallButton}
        title={
          isPersonalAssistantConversation
            ? 'Personal Assistant does not support calls'
            : callEligible
            ? activeCall
              ? isInCall
                ? 'Toggle call overlay'
                : 'Join call'
              : 'Start a call'
            : 'You can only start a call with humans for now'
        }
        type="button"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path
            d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {activeCall && !isInCall && (
          <span className="absolute right-0.5 top-0.5 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--success)] opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--success)]" />
          </span>
        )}
      </button>
      <div className="mx-1 h-5 w-px bg-[color:var(--border-strong)]" />
      <button
        className={[toolbarButtonClass, searchOpen ? 'text-[var(--tx)]' : ''].join(' ')}
        onClick={onToggleSearch}
        title="Search messages"
        type="button"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <button className={toolbarButtonClass} type="button">
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path
            d="M4 6h16M4 12h16M4 18h16"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  </header>
)
