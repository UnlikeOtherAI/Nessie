import type { AgentRecord, ChannelRecord } from '../../lib/api-client';
import { useLocation } from 'react-router-dom';
import { useScrollMemory } from '../../hooks/useScrollMemory';
import { isReactNativeWebView } from '../../lib/mobile-shell';
import { SidebarChannelsSection } from './SidebarChannelsSection';
import { SidebarDmSection } from './SidebarDmSection';
import { SidebarProjectsSection } from './SidebarProjectsSection';
import { SidebarStarredSection } from './SidebarStarredSection';
import { renderUnreadCount, sidebarAriaCurrent } from './SidebarRow';
import type {
  CreateChannelTarget,
  EditProjectTarget,
  SidebarAgentDm,
  SidebarGroupDm,
  SidebarMenu,
  SidebarPerson,
  SidebarProductAssistant,
  SidebarProject,
  StarredItem,
  VisibleStarredEntry,
} from './types';

type SidebarNavProps = {
  attentionCountByProjectId: Map<string, number>;
  activeDmChannelId?: string;
  channelsCollapsed: boolean;
  currentChannelId?: string;
  currentProjectId?: string;
  dmCollapsed: boolean;
  onNavigateAgent: (agentId: string) => void;
  onNavigateChannel: (channelId: string) => void;
  onNavigateThreads: () => void;
  onNavigateUnreadMessages: () => void;
  onNavigateDm: (userId: string) => void;
  onNavigateNewConversation: () => void;
  onNavigateProject: (projectId: string) => void;
  onOpenCreateChannel: (target?: CreateChannelTarget) => void;
  onOpenCreateProject: () => void;
  onOpenPersonalAssistant: () => void;
  onOpenEditProject: (target: EditProjectTarget) => void;
  onToggleStar: (type: StarredItem['type'], id: string) => void;
  personalAssistantAgent: AgentRecord | null;
  personalAssistantBootstrapping: boolean;
  personalAssistantChannelId?: string;
  personalAssistantUnreadCount: number;
  projectsCollapsed: boolean;
  setSidebarMenu: (updater: (current: SidebarMenu) => SidebarMenu) => void;
  sidebarAgentDms: SidebarAgentDm[];
  sidebarGroupDms: SidebarGroupDm[];
  sidebarMenu: SidebarMenu;
  sidebarProjects: SidebarProject[];
  sidebarProjectsLoaded: boolean;
  sidebarPeople: SidebarPerson[];
  sidebarProductAssistants: SidebarProductAssistant[];
  starredAgentIds: Set<string>;
  starredChannelIds: Set<string>;
  starredCollapsed: boolean;
  starredProjectIds: Set<string>;
  starredUserIds: Set<string>;
  teamIdByProjectId: Map<string, string>;
  toggleChannelsCollapsed: () => void;
  toggleDmCollapsed: () => void;
  toggleProjectsCollapsed: () => void;
  toggleStarredCollapsed: () => void;
  unreadCountByChannelId: Map<string, number>;
  visibleSidebarProjects: SidebarProject[];
  visibleStarredEntries: VisibleStarredEntry[];
  standaloneChannels: ChannelRecord[];
  threadsUnreadCount: number;
  unreadDirectMessageCount: number;
};

export const SidebarNav = (props: SidebarNavProps) => {
  const { pathname } = useLocation();
  const {
    attentionCountByProjectId,
    activeDmChannelId,
    channelsCollapsed,
    currentChannelId,
    currentProjectId,
    dmCollapsed,
    onNavigateAgent,
    onNavigateChannel,
    onNavigateThreads,
    onNavigateUnreadMessages,
    onNavigateDm,
    onNavigateNewConversation,
    onNavigateProject,
    onOpenCreateChannel,
    onOpenCreateProject,
    onOpenPersonalAssistant,
    onOpenEditProject,
    onToggleStar,
    personalAssistantAgent,
    personalAssistantBootstrapping,
    personalAssistantChannelId,
    personalAssistantUnreadCount,
    projectsCollapsed,
    setSidebarMenu,
    sidebarAgentDms,
    sidebarGroupDms,
    sidebarMenu,
    sidebarProjects,
    sidebarProjectsLoaded,
    sidebarPeople,
    sidebarProductAssistants,
    starredAgentIds,
    starredChannelIds,
    starredCollapsed,
    starredProjectIds,
    starredUserIds,
    teamIdByProjectId,
    toggleChannelsCollapsed,
    toggleDmCollapsed,
    toggleProjectsCollapsed,
    toggleStarredCollapsed,
    unreadCountByChannelId,
    visibleSidebarProjects,
    visibleStarredEntries,
    standaloneChannels,
    threadsUnreadCount,
    unreadDirectMessageCount,
  } = props;
  const nativeTouchShell = isReactNativeWebView();
  // This one channel-list scroller is shared across every route in the
  // section (channel A -> B never remounts it), so its remembered position
  // only needs to survive it swapping out for another section's sidebar and
  // back — a constant key, not a per-route one (docs/navigation/overview.md §4.13).
  const channelListScroll = useScrollMemory('sidebar:channel-list');

  return (
    <aside
      className={[
        'admin-sidebar-nav flex h-full w-full flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
        nativeTouchShell ? 'touch-sidebar' : '',
      ].join(' ')}
    >
      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        onScroll={channelListScroll.onScroll}
        ref={channelListScroll.ref}
      >
        <button
          aria-current={sidebarAriaCurrent(pathname === '/threads')}
          className={`admin-sb-item sidebar-threads group ${pathname === '/threads' ? 'active' : ''}`}
          onClick={onNavigateThreads}
          type="button"
        >
          <span>Threads</span>
          {renderUnreadCount(threadsUnreadCount)}
        </button>
        <button
          aria-current={sidebarAriaCurrent(pathname === '/unread-messages')}
          className={[
            'admin-sb-item sidebar-threads sidebar-unread-messages group',
            pathname === '/unread-messages' ? 'active' : '',
          ].join(' ')}
          onClick={onNavigateUnreadMessages}
          type="button"
        >
          <span>Unread messages</span>
          {renderUnreadCount(unreadDirectMessageCount)}
        </button>

        <SidebarStarredSection
          activeDmChannelId={activeDmChannelId}
          currentChannelId={currentChannelId}
          currentProjectId={currentProjectId}
          entries={visibleStarredEntries}
          onNavigateAgent={onNavigateAgent}
          onNavigateChannel={onNavigateChannel}
          onNavigateDm={onNavigateDm}
          onNavigateProject={onNavigateProject}
          onToggleStar={onToggleStar}
          personalAssistantChannelId={personalAssistantChannelId}
          starredCollapsed={starredCollapsed}
          toggleStarredCollapsed={toggleStarredCollapsed}
          unreadCountByChannelId={unreadCountByChannelId}
        />

      <SidebarProjectsSection
        attentionCountByProjectId={attentionCountByProjectId}
          currentChannelId={currentChannelId}
          currentProjectId={currentProjectId}
          onNavigateChannel={onNavigateChannel}
          onNavigateProject={onNavigateProject}
          onOpenCreateChannel={onOpenCreateChannel}
          onOpenCreateProject={onOpenCreateProject}
          onOpenEditProject={onOpenEditProject}
          onToggleStar={onToggleStar}
          projectsCollapsed={projectsCollapsed}
          setSidebarMenu={setSidebarMenu}
          sidebarMenu={sidebarMenu}
          sidebarProjects={sidebarProjects}
          sidebarProjectsLoaded={sidebarProjectsLoaded}
          starredChannelIds={starredChannelIds}
          starredProjectIds={starredProjectIds}
          teamIdByProjectId={teamIdByProjectId}
          toggleProjectsCollapsed={toggleProjectsCollapsed}
          visibleSidebarProjects={visibleSidebarProjects}
        />

        <SidebarChannelsSection
          channelsCollapsed={channelsCollapsed}
          currentChannelId={currentChannelId}
          onNavigateChannel={onNavigateChannel}
          onOpenCreateChannel={onOpenCreateChannel}
          onToggleStar={onToggleStar}
          standaloneChannels={standaloneChannels}
          starredChannelIds={starredChannelIds}
          toggleChannelsCollapsed={toggleChannelsCollapsed}
        />

        <SidebarDmSection
          activeDmChannelId={activeDmChannelId}
          currentChannelId={currentChannelId}
          dmCollapsed={dmCollapsed}
          onNavigateDm={onNavigateDm}
          onNavigateChannel={onNavigateChannel}
          onStartNewConversation={onNavigateNewConversation}
          onOpenPersonalAssistant={onOpenPersonalAssistant}
          onToggleStar={onToggleStar}
          personalAssistantAgent={personalAssistantAgent}
          personalAssistantBootstrapping={personalAssistantBootstrapping}
          personalAssistantChannelId={personalAssistantChannelId}
          personalAssistantUnreadCount={personalAssistantUnreadCount}
          sidebarAgentDms={sidebarAgentDms}
          sidebarGroupDms={sidebarGroupDms}
          sidebarPeople={sidebarPeople}
          sidebarProductAssistants={sidebarProductAssistants}
          starredAgentIds={starredAgentIds}
          starredChannelIds={starredChannelIds}
          starredUserIds={starredUserIds}
          toggleDmCollapsed={toggleDmCollapsed}
          unreadCountByChannelId={unreadCountByChannelId}
        />
      </div>
    </aside>
  );
};
