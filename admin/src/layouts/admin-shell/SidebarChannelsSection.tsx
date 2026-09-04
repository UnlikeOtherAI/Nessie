import type { ChannelRecord } from '../../lib/api-client';
import { prewarmRowHandlers, usePrewarm } from '../../navigation/prewarm';
import { channelHashClassName, renderUnreadCount, sidebarAriaCurrent } from './SidebarRow';
import { GroupDmSidebarLabel } from './GroupDmSidebarLabel';
import { SidebarMenuSection } from './SidebarMenuSection';
import type { CreateChannelTarget } from './types';

type SidebarChannelsSectionProps = {
  channelsCollapsed: boolean;
  currentChannelId?: string;
  onNavigateChannel: (channelId: string) => void;
  onOpenCreateChannel: (target?: CreateChannelTarget) => void;
  onToggleStar: (type: 'channel' | 'project' | 'user', id: string) => void;
  standaloneChannels: ChannelRecord[];
  starredChannelIds: Set<string>;
  toggleChannelsCollapsed: () => void;
};

export const SidebarChannelsSection = ({
  channelsCollapsed,
  currentChannelId,
  onNavigateChannel,
  onOpenCreateChannel,
  onToggleStar,
  standaloneChannels,
  starredChannelIds,
  toggleChannelsCollapsed,
}: SidebarChannelsSectionProps) => {
  const prewarm = usePrewarm();

  return (
    <SidebarMenuSection
      action={
        <button
          aria-label="Create channel"
          className="admin-sidebar-plus"
          onClick={() => onOpenCreateChannel({ scope: 'standalone' })}
          type="button"
        >
          +
        </button>
      }
      id="sidebar-nav-channels"
      isCollapsed={channelsCollapsed}
      onToggle={toggleChannelsCollapsed}
      title="Shared channels"
    >
      {standaloneChannels.map((channel) => {
        const isStarredChannel = starredChannelIds.has(channel.id);
        return (
          <button
            aria-current={sidebarAriaCurrent(channel.id === currentChannelId)}
            key={channel.id}
            className={[
              'admin-sb-item group',
              channel.unreadCount > 0 ? 'unread' : '',
              channel.id === currentChannelId ? 'active' : '',
            ].join(' ')}
            onClick={() => onNavigateChannel(channel.id)}
            type="button"
            {...prewarmRowHandlers(prewarm, `/channels/${channel.id}`)}
          >
            <span className={channelHashClassName}>#</span>
            <GroupDmSidebarLabel label={channel.label} />
            {renderUnreadCount(channel.unreadCount)}
            <span
              className={[
                'sidebar-row-star flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
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
    </SidebarMenuSection>
  );
};
