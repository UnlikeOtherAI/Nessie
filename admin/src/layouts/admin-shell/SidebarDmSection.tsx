import {
  PersonalAssistantSidebarEntry,
} from '../../components/features/personal-assistant/PersonalAssistantSurface';
import { renderUnreadCount } from './SidebarRow';
import type { SidebarPerson } from './types';

type SidebarDmSectionProps = {
  activeDmChannelId?: string;
  currentChannelId?: string;
  dmCollapsed: boolean;
  isOwner: boolean;
  onNavigateDm: (userId: string) => void;
  onNavigateSettings: (subPage?: string) => void;
  onOpenPersonalAssistant: () => void;
  onToggleStar: (type: 'channel' | 'project' | 'user', id: string) => void;
  personalAssistantBootstrapping: boolean;
  personalAssistantChannelId?: string;
  personalAssistantUnreadCount: number;
  sidebarPeople: SidebarPerson[];
  starredUserIds: Set<string>;
  toggleDmCollapsed: () => void;
  unreadCountByChannelId: Map<string, number>;
};

export const SidebarDmSection = ({
  activeDmChannelId,
  currentChannelId,
  dmCollapsed,
  isOwner,
  onNavigateDm,
  onNavigateSettings,
  onOpenPersonalAssistant,
  onToggleStar,
  personalAssistantBootstrapping,
  personalAssistantChannelId,
  personalAssistantUnreadCount,
  sidebarPeople,
  starredUserIds,
  toggleDmCollapsed,
  unreadCountByChannelId,
}: SidebarDmSectionProps) => {
  return (
    <>
      <div className="admin-sec-row mt-2">
        <button
          className="admin-sec-hdr"
          onClick={toggleDmCollapsed}
          type="button"
        >
          <svg
            className={[
              'h-3 w-3 text-[color:var(--tx3)] transition-transform',
              dmCollapsed ? '-rotate-90' : '',
            ].join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
          >
            <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Direct messages
        </button>
        <button
          aria-label={isOwner ? 'Invite people' : 'Open workspace profile'}
          className="admin-sidebar-plus"
          onClick={() => onNavigateSettings('members')}
          type="button"
        >
          +
        </button>
      </div>

      {!dmCollapsed && (
        <>
          <PersonalAssistantSidebarEntry
            active={personalAssistantChannelId === currentChannelId}
            bootstrapping={personalAssistantBootstrapping}
            onClick={onOpenPersonalAssistant}
            unreadCount={personalAssistantUnreadCount}
          />
          {sidebarPeople.map((person) => {
            if (starredUserIds.has(person.id)) return null;

            const isStarredUser = starredUserIds.has(person.id);
            const unreadCount = person.dmChannelId
              ? unreadCountByChannelId.get(person.dmChannelId) ?? 0
              : 0;
            return (
              <button
                key={person.id}
                className={`admin-sb-item group ${person.dmChannelId && activeDmChannelId === person.dmChannelId ? 'active' : ''}`}
                onClick={() => onNavigateDm(person.id)}
                type="button"
              >
                <div className="h-4 w-4 flex-shrink-0 rounded" style={person.style} />
                <span className="min-w-0 flex-1 truncate text-sm">{person.label}</span>
                {renderUnreadCount(unreadCount)}
                <span
                  className={[
                    'flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
                    isStarredUser
                      ? 'ml-1 text-yellow-400 opacity-100'
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
        </>
      )}
    </>
  );
};
