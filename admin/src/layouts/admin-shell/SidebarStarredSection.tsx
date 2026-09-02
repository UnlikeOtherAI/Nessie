import type { ChannelRecord } from '../../lib/api-client';
import { UserAvatar } from '../../components/primitives/UserAvatar';
import { UserStatusEmoji } from '../../components/primitives/UserStatusEmoji';
import { ProjectAvatar } from '../../components/primitives/ProjectAvatar';
import { AgentAvatar } from '../../components/shared/AgentAvatar';
import { prewarmRowHandlers, usePrewarm } from '../../navigation/prewarm';
import { useAuthSession } from '../../providers/AuthSessionProvider';
import { usePresenceLookup } from '../../providers/PresenceProvider';
import { isReactNativeWebView } from '../../lib/mobile-shell';
import {
  channelHashClassName,
  projectSelectionClassName,
  renderUnreadCount,
  sidebarAriaCurrent,
} from './SidebarRow';
import { GroupDmSidebarLabel } from './GroupDmSidebarLabel';
import { SidebarMenuSection } from './SidebarMenuSection';
import type { StarredItem, VisibleStarredEntry } from './types';

type SidebarStarredSectionProps = {
  activeDmChannelId?: string;
  currentChannelId?: string;
  currentProjectId?: string;
  entries: VisibleStarredEntry[];
  onNavigateAgent: (agentId: string) => void;
  onNavigateChannel: (channelId: string) => void;
  onNavigateDm: (userId: string) => void;
  onNavigateProject: (projectId: string) => void;
  onToggleStar: (type: StarredItem['type'], id: string) => void;
  personalAssistantChannelId?: string;
  starredCollapsed: boolean;
  toggleStarredCollapsed: () => void;
  unreadCountByChannelId: Map<string, number>;
};

export const SidebarStarredSection = ({
  activeDmChannelId,
  currentChannelId,
  currentProjectId,
  entries,
  onNavigateAgent,
  onNavigateChannel,
  onNavigateDm,
  onNavigateProject,
  onToggleStar,
  personalAssistantChannelId,
  starredCollapsed,
  toggleStarredCollapsed,
  unreadCountByChannelId,
}: SidebarStarredSectionProps) => {
  const { token } = useAuthSession();
  const prewarm = usePrewarm();
  const getPresence = usePresenceLookup();
  const nativeTouchShell = isReactNativeWebView();
  if (entries.length === 0) {
    return null;
  }

  return (
    <SidebarMenuSection
      id="sidebar-nav-starred"
      isCollapsed={starredCollapsed}
      onToggle={toggleStarredCollapsed}
      title="Starred"
      titleIcon={
        <svg
          className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--warning-text)]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      }
    >
      {entries.map((item) => {
        if (item.type === 'agent') {
          const { agent } = item;
          const isActivePersonalAssistant = agent.agentKind === 'personal_assistant'
            && personalAssistantChannelId === currentChannelId;
          return (
            <button
              aria-current={sidebarAriaCurrent(isActivePersonalAssistant)}
              key={`starred-agent-${agent.id}`}
              className={`admin-sb-item group ${isActivePersonalAssistant ? 'active' : ''}`}
              onClick={() => onNavigateAgent(agent.id)}
              type="button"
              {...prewarmRowHandlers(prewarm, `/agents/${agent.id}`)}
            >
              <AgentAvatar agent={agent} size="xs" token={token} />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              <span
                className="sidebar-row-star ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-[color:var(--warning-text)]"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStar('agent', agent.id);
                }}
              >
                ★
              </span>
            </button>
          );
        }
        if (item.type === 'channel') {
          const { channel } = item;
          return (
            <button
              aria-current={sidebarAriaCurrent(channel.id === currentChannelId)}
              key={`starred-ch-${channel.id}`}
              className={`admin-sb-item group ${channel.unreadCount > 0 ? 'unread' : ''} ${channel.id === currentChannelId ? 'active' : ''}`}
              onClick={() => onNavigateChannel(channel.id)}
              type="button"
              {...prewarmRowHandlers(prewarm, `/channels/${channel.id}`)}
            >
              <span className={channelHashClassName}>#</span>
              <GroupDmSidebarLabel label={channel.label} />
              {renderUnreadCount(channel.unreadCount)}
              <span
                className="sidebar-row-star ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-[color:var(--warning-text)]"
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
                aria-current={sidebarAriaCurrent(
                  projectSelectionClassName(project.id, currentProjectId, currentChannelId) === 'active',
                )}
                className={[
                  'admin-sb-item sidebar-project-tile group',
                  unreadCount > 0 ? 'unread' : '',
                  projectSelectionClassName(project.id, currentProjectId, currentChannelId),
                ].join(' ')}
                onClick={() => onNavigateProject(project.id)}
                type="button"
                {...prewarmRowHandlers(prewarm, `/projects/${project.id}`)}
              >
                <ProjectAvatar
                  avatarAttachmentId={project.avatarAttachmentId}
                  avatarEmoji={project.avatarEmoji}
                  size={18}
                  token={token}
                />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {renderUnreadCount(unreadCount)}
                {item.starred ? (
                  <span
                    className="sidebar-row-star ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-[color:var(--warning-text)]"
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
                  aria-current={sidebarAriaCurrent(channel.id === currentChannelId)}
                  key={`starred-prj-${project.id}-ch-${channel.id}`}
                  className={[
                    'admin-sb-item sidebar-child group',
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
                    className="sidebar-row-star ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-[color:var(--warning-text)]"
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
        const personUnreadCount = person.dmChannelId
          ? unreadCountByChannelId.get(person.dmChannelId) ?? 0
          : 0;
        const presence = getPresence(person.id);
        return (
          <button
            aria-current={sidebarAriaCurrent(
              Boolean(person.dmChannelId && activeDmChannelId === person.dmChannelId),
            )}
            key={`starred-usr-${person.id}`}
            className={`admin-sb-item group ${personUnreadCount > 0 ? 'unread' : ''} ${person.dmChannelId && activeDmChannelId === person.dmChannelId ? 'active' : ''}`}
            onClick={() => onNavigateDm(person.id)}
            type="button"
            {...(person.dmChannelId
              ? prewarmRowHandlers(prewarm, `/channels/${person.dmChannelId}`)
              : {})}
          >
            <UserAvatar
              avatarAttachmentId={person.avatarAttachmentId ?? undefined}
              avatarUrl={person.avatarUrl ?? undefined}
              displayName={person.label}
              presenceRingWidth={nativeTouchShell ? 3 : undefined}
              ringColor={nativeTouchShell ? 'var(--sb)' : undefined}
              showPresence={nativeTouchShell}
              showStatus={false}
              size={nativeTouchShell ? 24 : 18}
              token={token}
              userId={person.id}
            />
            <span className="min-w-0 flex flex-1 items-center gap-1 overflow-hidden">
              <span className="truncate">{person.label}</span>
              <UserStatusEmoji
                statusEmoji={presence?.statusEmoji}
                statusLabel={presence?.statusLabel}
              />
            </span>
            {renderUnreadCount(personUnreadCount)}
            <span
              className="sidebar-row-star ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-[color:var(--warning-text)]"
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
    </SidebarMenuSection>
  );
};
