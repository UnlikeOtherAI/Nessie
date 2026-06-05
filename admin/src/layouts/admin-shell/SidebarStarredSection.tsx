import type { ChannelRecord } from '../../lib/api-client';
import { channelHashClassName, renderUnreadCount } from './SidebarRow';
import type { StarredItem, VisibleStarredEntry } from './types';

type SidebarStarredSectionProps = {
  activeDmChannelId?: string;
  currentChannelId?: string;
  currentProjectId?: string;
  entries: VisibleStarredEntry[];
  onNavigateChannel: (channelId: string) => void;
  onNavigateDm: (userId: string) => void;
  onNavigateProject: (projectId: string) => void;
  onToggleStar: (type: StarredItem['type'], id: string) => void;
  starredCollapsed: boolean;
  toggleStarredCollapsed: () => void;
  unreadCountByChannelId: Map<string, number>;
};

export const SidebarStarredSection = ({
  activeDmChannelId,
  currentChannelId,
  currentProjectId,
  entries,
  onNavigateChannel,
  onNavigateDm,
  onNavigateProject,
  onToggleStar,
  starredCollapsed,
  toggleStarredCollapsed,
  unreadCountByChannelId,
}: SidebarStarredSectionProps) => {
  if (entries.length === 0) {
    return null;
  }

  return (
    <>
      <button
        className="admin-sec-hdr"
        onClick={toggleStarredCollapsed}
        type="button"
      >
        <svg
          className={[
            'h-3 w-3 text-[color:var(--tx3)] transition-transform',
            starredCollapsed ? '-rotate-90' : '',
          ].join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          viewBox="0 0 24 24"
        >
          <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg
          className="h-3.5 w-3.5 flex-shrink-0 text-yellow-400"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        Starred
      </button>
      {!starredCollapsed &&
        entries.map((item) => {
          if (item.type === 'channel') {
            const { channel } = item;
            return (
              <button
                key={`starred-ch-${channel.id}`}
                className={`admin-sb-item group ${channel.id === currentChannelId ? 'active' : ''}`}
                onClick={() => onNavigateChannel(channel.id)}
                type="button"
              >
                <span className={channelHashClassName}>#</span>
                <span className="min-w-0 flex-1 truncate">{channel.label}</span>
                {renderUnreadCount(channel.unreadCount)}
                <span
                  className="ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-yellow-400"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleStar('channel', channel.id);
                  }}
                >
                  ★
                </span>
              </button>
            );
          }
          if (item.type === 'project') {
            const { channels: starredProjectChannels, project } = item;
            const unreadCount = starredProjectChannels.reduce(
              (total: number, channel: ChannelRecord) => total + channel.unreadCount,
              0,
            );
            return (
              <div key={`starred-prj-${project.id}`} className="mt-1">
                <button
                  className={[
                    'admin-sb-item group font-semibold',
                    project.id === currentProjectId ? 'active-parent' : '',
                  ].join(' ')}
                  onClick={() => onNavigateProject(project.id)}
                  type="button"
                >
                  <svg
                    className="h-4 w-4 flex-shrink-0 text-[color:var(--tx3)]"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {renderUnreadCount(unreadCount)}
                  {item.starred ? (
                    <span
                      className="ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-yellow-400"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleStar('project', project.id);
                      }}
                    >
                      ★
                    </span>
                  ) : null}
                </button>

                {starredProjectChannels.map((channel) => (
                  <button
                    key={`starred-prj-${project.id}-ch-${channel.id}`}
                    className={[
                      'admin-sb-item sidebar-child group',
                      channel.id === currentChannelId ? 'active' : '',
                    ].join(' ')}
                    onClick={() => onNavigateChannel(channel.id)}
                    type="button"
                  >
                    <span className={channelHashClassName}>#</span>
                    <span className="min-w-0 flex-1 truncate">{channel.label}</span>
                    {renderUnreadCount(channel.unreadCount)}
                    <span
                      className="ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-yellow-400"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleStar('channel', channel.id);
                      }}
                    >
                      ★
                    </span>
                  </button>
                ))}
              </div>
            );
          }
          const { person } = item;
          return (
            <button
              key={`starred-usr-${person.id}`}
              className={`admin-sb-item group ${person.dmChannelId && activeDmChannelId === person.dmChannelId ? 'active' : ''}`}
              onClick={() => onNavigateDm(person.id)}
              type="button"
            >
              <div className="h-4 w-4 flex-shrink-0 rounded" style={person.style} />
              <span className="min-w-0 flex-1 truncate text-sm">{person.label}</span>
              {renderUnreadCount(
                person.dmChannelId
                  ? unreadCountByChannelId.get(person.dmChannelId) ?? 0
                  : 0,
              )}
              <span
                className="ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-yellow-400"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStar('user', person.id);
                }}
              >
                ★
              </span>
            </button>
          );
        })}
    </>
  );
};
