import type { AgentRecord, ChannelRecord } from '../../lib/api-client';
import { isReactNativeWebView } from '../../lib/mobile-shell';
import { SidebarChannelsSection } from './SidebarChannelsSection';
import { SidebarDmSection } from './SidebarDmSection';
import { SidebarProjectsSection } from './SidebarProjectsSection';
import { SidebarStarredSection } from './SidebarStarredSection';
import { renderUnreadCount } from './SidebarRow';
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
};

export const SidebarNav = (props: SidebarNavProps) => {
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
  } = props;
  const nativeTouchShell = isReactNativeWebView();

  return (
    <aside
      className={[
        'admin-sidebar-nav flex h-full w-full flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
        nativeTouchShell ? 'touch-sidebar' : '',
      ].join(' ')}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
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

        <button className="admin-sb-item group" onClick={onNavigateThreads} type="button">
          <span className="sidebar-row-symbol w-[14px] flex-shrink-0 text-center text-base leading-none text-[color:var(--tx3)]">◌</span>
          <span>Threads</span>
          {renderUnreadCount(threadsUnreadCount)}
        </button>

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
