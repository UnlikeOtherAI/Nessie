import type { AgentRecord, ChannelRecord } from '../../lib/api-client';
import { SidebarChannelsSection } from './SidebarChannelsSection';
import { SidebarDmSection } from './SidebarDmSection';
import { SidebarProjectsSection } from './SidebarProjectsSection';
import { SidebarStarredSection } from './SidebarStarredSection';
import type {
  CreateChannelTarget,
  RenameProjectTarget,
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
  defaultProjectChannels: ChannelRecord[];
  defaultProjectTeamId?: string;
  dmCollapsed: boolean;
  onNavigateAgent: (agentId: string) => void;
  onNavigateChannel: (channelId: string) => void;
  onNavigateDm: (userId: string) => void;
  onNavigateNewConversation: () => void;
  onNavigateProject: (projectId: string) => void;
  onOpenCreateChannel: (target?: CreateChannelTarget) => void;
  onOpenCreateProject: () => void;
  onOpenPersonalAssistant: () => void;
  onOpenRenameProject: (target: RenameProjectTarget) => void;
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
};

export const SidebarNav = (props: SidebarNavProps) => {
  const {
    attentionCountByProjectId,
    activeDmChannelId,
    channelsCollapsed,
    currentChannelId,
    currentProjectId,
    defaultProjectChannels,
    defaultProjectTeamId,
    dmCollapsed,
    onNavigateAgent,
    onNavigateChannel,
    onNavigateDm,
    onNavigateNewConversation,
    onNavigateProject,
    onOpenCreateChannel,
    onOpenCreateProject,
    onOpenPersonalAssistant,
    onOpenRenameProject,
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
  } = props;

  return (
    <aside
      className={[
        'flex h-full w-full flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
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

      <SidebarProjectsSection
        attentionCountByProjectId={attentionCountByProjectId}
          currentChannelId={currentChannelId}
          currentProjectId={currentProjectId}
          onNavigateChannel={onNavigateChannel}
          onNavigateProject={onNavigateProject}
          onOpenCreateChannel={onOpenCreateChannel}
          onOpenCreateProject={onOpenCreateProject}
          onOpenRenameProject={onOpenRenameProject}
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
          defaultProjectChannels={defaultProjectChannels}
          defaultProjectTeamId={defaultProjectTeamId}
          onNavigateChannel={onNavigateChannel}
          onOpenCreateChannel={onOpenCreateChannel}
          onToggleStar={onToggleStar}
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
