import {
  PersonalAssistantSidebarEntry,
} from '../../components/features/personal-assistant/PersonalAssistantSurface';
import { UserAvatar } from '../../components/primitives/UserAvatar';
import { agentGradient } from '../../lib/avatar';
import type { AgentRecord } from '../../lib/api-client';
import { isReactNativeWebView } from '../../lib/mobile-shell';
import { useAuthSession } from '../../providers/AuthSessionProvider';
import { renderUnreadCount } from './SidebarRow';
import { SidebarMenuSection } from './SidebarMenuSection';
import { GroupDmSidebarLabel } from './GroupDmSidebarLabel';
import type {
  SidebarAgentDm,
  SidebarGroupDm,
  SidebarPerson,
  SidebarProductAssistant,
} from './types';

type SidebarDmSectionProps = {
  activeDmChannelId?: string;
  currentChannelId?: string;
  dmCollapsed: boolean;
  onNavigateChannel: (channelId: string) => void;
  onNavigateDm: (userId: string) => void;
  onStartNewConversation: () => void;
  onOpenPersonalAssistant: () => void;
  onToggleStar: (type: 'channel' | 'project' | 'user', id: string) => void;
  personalAssistantAgent: AgentRecord | null;
  personalAssistantBootstrapping: boolean;
  personalAssistantChannelId?: string;
  personalAssistantUnreadCount: number;
  sidebarAgentDms: SidebarAgentDm[];
  sidebarGroupDms: SidebarGroupDm[];
  sidebarPeople: SidebarPerson[];
  sidebarProductAssistants: SidebarProductAssistant[];
  starredAgentIds: Set<string>;
  starredChannelIds: Set<string>;
  starredUserIds: Set<string>;
  toggleDmCollapsed: () => void;
  unreadCountByChannelId: Map<string, number>;
};

export const SidebarDmSection = ({
  activeDmChannelId,
  currentChannelId,
  dmCollapsed,
  onNavigateChannel,
  onNavigateDm,
  onStartNewConversation,
  onOpenPersonalAssistant,
  onToggleStar,
  personalAssistantAgent,
  personalAssistantBootstrapping,
  personalAssistantChannelId,
  personalAssistantUnreadCount,
  sidebarAgentDms,
  sidebarGroupDms,
  sidebarPeople,
  sidebarProductAssistants,
  starredAgentIds,
  starredChannelIds,
  starredUserIds,
  toggleDmCollapsed,
  unreadCountByChannelId,
}: SidebarDmSectionProps) => {
  const { token } = useAuthSession();
  const nativeTouchShell = isReactNativeWebView();
  const avatarSize = nativeTouchShell ? 24 : 18;
  return (
    <SidebarMenuSection
      action={
        <button
          aria-label="Start new chat"
          className="admin-sidebar-plus"
          onClick={onStartNewConversation}
          title="Start new chat"
          type="button"
        >
          +
        </button>
      }
      className="mt-2"
      id="sidebar-nav-direct-messages"
      isCollapsed={dmCollapsed}
      onToggle={toggleDmCollapsed}
      title="Direct messages"
    >
      {!(
        (personalAssistantAgent && starredAgentIds.has(personalAssistantAgent.id))
        || (personalAssistantChannelId && starredChannelIds.has(personalAssistantChannelId))
      ) ? (
        <PersonalAssistantSidebarEntry
          active={personalAssistantChannelId === currentChannelId}
          agent={personalAssistantAgent}
          bootstrapping={personalAssistantBootstrapping}
          onClick={onOpenPersonalAssistant}
          token={token}
          unreadCount={personalAssistantUnreadCount}
        />
      ) : null}
      {sidebarProductAssistants.map((assistant) => {
        if (starredChannelIds.has(assistant.dmChannelId)) return null;

        const unreadCount = unreadCountByChannelId.get(assistant.dmChannelId) ?? 0;
        return (
          <button
            key={assistant.productSlug}
            className={`admin-sb-item group ${unreadCount > 0 ? 'unread' : ''} ${currentChannelId === assistant.dmChannelId ? 'active' : ''}`}
            onClick={() => onNavigateChannel(assistant.dmChannelId)}
            type="button"
          >
            <span
              className={[
                'flex shrink-0 items-center justify-center text-[9px] text-[var(--on-accent)]',
                nativeTouchShell ? 'h-6 w-6 rounded-md' : 'h-[18px] w-[18px] rounded-md',
              ].join(' ')}
              style={{ background: agentGradient }}
            >
              {(assistant.iconGlyph ?? assistant.label.slice(0, 1)).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate">{assistant.label}</span>
            {renderUnreadCount(unreadCount)}
          </button>
        );
      })}
      {sidebarAgentDms.map((agent) => {
        if (starredAgentIds.has(agent.id) || starredChannelIds.has(agent.dmChannelId)) return null;

        const unreadCount = unreadCountByChannelId.get(agent.dmChannelId) ?? 0;
        return (
          <button
            key={agent.id}
            className={`admin-sb-item group ${unreadCount > 0 ? 'unread' : ''} ${currentChannelId === agent.dmChannelId ? 'active' : ''}`}
            onClick={() => onNavigateChannel(agent.dmChannelId)}
            type="button"
          >
            <span
              className={[
                'flex shrink-0 items-center justify-center text-[9px] text-[var(--on-accent)]',
                nativeTouchShell ? 'h-6 w-6 rounded-md' : 'h-[18px] w-[18px] rounded-md',
              ].join(' ')}
              style={{ background: agentGradient }}
            >
              {agent.label.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate">{agent.label}</span>
            {renderUnreadCount(unreadCount)}
          </button>
        );
      })}
      {sidebarGroupDms.map((group) => {
        if (starredChannelIds.has(group.dmChannelId)) return null;

        const unreadCount = unreadCountByChannelId.get(group.dmChannelId) ?? 0;
        return (
          <button
            key={group.dmChannelId}
            className={`admin-sb-item group ${unreadCount > 0 ? 'unread' : ''} ${currentChannelId === group.dmChannelId ? 'active' : ''}`}
            onClick={() => onNavigateChannel(group.dmChannelId)}
            type="button"
          >
            <svg
              aria-hidden="true"
              className="h-[18px] w-[18px] shrink-0 text-[color:var(--tx2)]"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <circle cx="9" cy="8" r="3" />
              <path d="M3.5 20c.5-3.4 2.3-5.1 5.5-5.1s5 1.7 5.5 5.1" />
              <path d="M16.1 5.6a3 3 0 010 5.1M17.1 14.9c2.1.5 3.2 2.2 3.4 5.1" />
            </svg>
            <GroupDmSidebarLabel label={group.label} />
            {renderUnreadCount(unreadCount)}
          </button>
        );
      })}
      {sidebarPeople.map((person) => {
        if (starredUserIds.has(person.id) || (person.dmChannelId && starredChannelIds.has(person.dmChannelId))) {
          return null;
        }

        const isStarredUser = starredUserIds.has(person.id);
        const unreadCount = person.dmChannelId
          ? unreadCountByChannelId.get(person.dmChannelId) ?? 0
          : 0;
        return (
          <button
            key={person.id}
            className={`admin-sb-item group ${unreadCount > 0 ? 'unread' : ''} ${person.dmChannelId && activeDmChannelId === person.dmChannelId ? 'active' : ''}`}
            onClick={() => onNavigateDm(person.id)}
            type="button"
          >
            <UserAvatar
              avatarAttachmentId={person.avatarAttachmentId ?? undefined}
              avatarUrl={person.avatarUrl ?? undefined}
              displayName={person.label}
              gravatarUrl={person.gravatarUrl ?? undefined}
              presenceRingWidth={nativeTouchShell ? 3 : undefined}
              ringColor={nativeTouchShell ? 'var(--sb)' : undefined}
              showPresence={nativeTouchShell}
              showStatus={!nativeTouchShell}
              size={avatarSize}
              token={token}
              userId={person.id}
            />
            <span className="min-w-0 flex-1 truncate">{person.label}</span>
            {renderUnreadCount(unreadCount)}
            <span
              className={[
                'flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
                isStarredUser
                  ? 'ml-1 text-[color:var(--warning-text)] opacity-100'
                  : 'ml-auto text-[color:var(--tx3)] opacity-0 group-hover:opacity-100',
              ].join(' ')}
              onClick={(e) => {
                e.stopPropagation();
                onToggleStar('user', person.id);
              }}
            >
              {isStarredUser ? '★' : '☆'}
            </span>
          </button>
        );
      })}
    </SidebarMenuSection>
  );
};
