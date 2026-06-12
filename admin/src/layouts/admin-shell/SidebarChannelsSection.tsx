import type { ChannelRecord } from '../../lib/api-client';
import { channelHashClassName, renderUnreadCount } from './SidebarRow';
import type { CreateChannelTarget, SidebarMenu } from './types';

type SidebarChannelsSectionProps = {
  channelsCollapsed: boolean;
  currentChannelId?: string;
  defaultProjectChannels: ChannelRecord[];
  defaultProjectTeamId?: string;
  onNavigateChannel: (channelId: string) => void;
  onOpenCreateChannel: (target?: CreateChannelTarget) => void;
  onOpenCreateProject: () => void;
  onToggleStar: (type: 'channel' | 'project' | 'user', id: string) => void;
  setSidebarMenu: (updater: (current: SidebarMenu) => SidebarMenu) => void;
  sidebarMenu: SidebarMenu;
  starredChannelIds: Set<string>;
  toggleChannelsCollapsed: () => void;
};

export const SidebarChannelsSection = ({
  channelsCollapsed,
  currentChannelId,
  defaultProjectChannels,
  defaultProjectTeamId,
  onNavigateChannel,
  onOpenCreateChannel,
  onOpenCreateProject,
  onToggleStar,
  setSidebarMenu,
  sidebarMenu,
  starredChannelIds,
  toggleChannelsCollapsed,
}: SidebarChannelsSectionProps) => {
  return (
    <>
      <div className="admin-sec-row">
        <button
          className="admin-sec-hdr"
          onClick={toggleChannelsCollapsed}
          type="button"
        >
          <svg
            className={[
              'h-3 w-3 text-[color:var(--tx3)] transition-transform',
              channelsCollapsed ? '-rotate-90' : '',
            ].join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
          >
            <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Channels
        </button>
        <div className="relative">
          <button
            aria-label="Add channel or project"
            className="admin-sidebar-plus"
            onClick={() =>
              setSidebarMenu((current) => (current?.type === 'channels' ? null : { type: 'channels' }))
            }
            type="button"
          >
            +
          </button>
          {sidebarMenu?.type === 'channels' ? (
            <div className="admin-sidebar-menu">
              <button
                onClick={() =>
                  onOpenCreateChannel({
                    teamId: defaultProjectTeamId,
                  })
                }
                type="button"
              >
                Create new channel
              </button>
              <button onClick={onOpenCreateProject} type="button">
                Create new project
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {!channelsCollapsed && (
        <>
          {defaultProjectChannels.map((channel) => {
            const isStarredChannel = starredChannelIds.has(channel.id);
            return (
              <button
                key={channel.id}
                className={[
                  'admin-sb-item group',
                  channel.unreadCount > 0 ? 'unread' : '',
                  channel.id === currentChannelId ? 'active' : '',
                ].join(' ')}
                onClick={() => onNavigateChannel(channel.id)}
                type="button"
              >
                <span className={channelHashClassName}>#</span>
                <span className="min-w-0 flex-1 truncate">{channel.label}</span>
                {renderUnreadCount(channel.unreadCount)}
                <span
                  className={[
                    'flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
                    isStarredChannel
                      ? 'ml-1 text-[color:var(--warning-text)] opacity-100'
                      : 'ml-auto text-[color:var(--tx3)] opacity-0 group-hover:opacity-100',
                  ].join(' ')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleStar('channel', channel.id);
                  }}
                >
                  {isStarredChannel ? '★' : '☆'}
                </span>
              </button>
            );
          })}
        </>
      )}
    </>
  );
};
