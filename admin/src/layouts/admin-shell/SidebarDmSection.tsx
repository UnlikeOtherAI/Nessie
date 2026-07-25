import {
  PersonalAssistantSidebarEntry,
} from '../../components/features/personal-assistant/PersonalAssistantSurface';
import { UserAvatar } from '../../components/primitives/UserAvatar';
import { agentGradient } from '../../lib/avatar';
import { useAuthSession } from '../../providers/AuthSessionProvider';
import { renderUnreadCount } from './SidebarRow';
import { SidebarMenuSection } from './SidebarMenuSection';
import type { SidebarAgentDm, SidebarPerson, SidebarProductAssistant } from './types';

type SidebarDmSectionProps = {
  activeDmChannelId?: string;
  currentChannelId?: string;
  dmCollapsed: boolean;
  isOwner: boolean;
  onNavigateAgentDm: (channelId: string) => void;
  onNavigateDm: (userId: string) => void;
  onNavigateSettings: (subPage?: string) => void;
  onOpenPersonalAssistant: () => void;
  onToggleStar: (type: 'channel' | 'project' | 'user', id: string) => void;
  personalAssistantBootstrapping: boolean;
  personalAssistantChannelId?: string;
  personalAssistantUnreadCount: number;
  sidebarAgentDms: SidebarAgentDm[];
  sidebarPeople: SidebarPerson[];
  sidebarProductAssistants: SidebarProductAssistant[];
  starredUserIds: Set<string>;
  toggleDmCollapsed: () => void;
  unreadCountByChannelId: Map<string, number>;
};

export const SidebarDmSection = ({
  activeDmChannelId,
  currentChannelId,
  dmCollapsed,
  isOwner,
  onNavigateAgentDm,
  onNavigateDm,
  onNavigateSettings,
  onOpenPersonalAssistant,
  onToggleStar,
  personalAssistantBootstrapping,
  personalAssistantChannelId,
  personalAssistantUnreadCount,
  sidebarAgentDms,
  sidebarPeople,
  sidebarProductAssistants,
  starredUserIds,
  toggleDmCollapsed,
  unreadCountByChannelId,
}: SidebarDmSectionProps) => {
  const { token } = useAuthSession();
  return (
    <SidebarMenuSection
      action={
        <button
          aria-label={isOwner ? 'Invite people' : 'Open workspace profile'}
          className="admin-sidebar-plus"
          onClick={() => onNavigateSettings('members')}
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
      <PersonalAssistantSidebarEntry
        active={personalAssistantChannelId === currentChannelId}
        bootstrapping={personalAssistantBootstrapping}
        onClick={onOpenPersonalAssistant}
        unreadCount={personalAssistantUnreadCount}
      />
      {sidebarProductAssistants.map((assistant) => {
        const unreadCount = unreadCountByChannelId.get(assistant.dmChannelId) ?? 0;
        return (
          <button
            key={assistant.productSlug}
            className={`admin-sb-item group ${unreadCount > 0 ? 'unread' : ''} ${currentChannelId === assistant.dmChannelId ? 'active' : ''}`}
            onClick={() => onNavigateAgentDm(assistant.dmChannelId)}
            type="button"
          >
            <span
              className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[9px] text-[var(--on-accent)]"
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
        const unreadCount = unreadCountByChannelId.get(agent.dmChannelId) ?? 0;
        return (
          <button
            key={agent.id}
            className={`admin-sb-item group ${unreadCount > 0 ? 'unread' : ''} ${currentChannelId === agent.dmChannelId ? 'active' : ''}`}
            onClick={() => onNavigateAgentDm(agent.dmChannelId)}
            type="button"
          >
            <span
              className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[9px] text-[var(--on-accent)]"
              style={{ background: agentGradient }}
            >
              {agent.label.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate">{agent.label}</span>
            {renderUnreadCount(unreadCount)}
          </button>
        );
      })}
      {sidebarPeople.map((person) => {
        if (starredUserIds.has(person.id)) return null;

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
              size={18}
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
