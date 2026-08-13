import type { ChannelRecord } from '../../lib/api-client';
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
  onNavigateHome: () => void;
  onNavigateNewConversation: () => void;
  onNavigateProject: (projectId: string) => void;
  onOpenCreateChannel: (target?: CreateChannelTarget) => void;
  onOpenCreateProject: () => void;
  onOpenPersonalAssistant: () => void;
  onOpenRenameProject: (target: RenameProjectTarget) => void;
  onToggleStar: (type: StarredItem['type'], id: string) => void;
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
    onNavigateHome,
    onNavigateNewConversation,
    onNavigateProject,
    onOpenCreateChannel,
    onOpenCreateProject,
    onOpenPersonalAssistant,
    onOpenRenameProject,
    onToggleStar,
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
      <div className="flex h-[50px] items-center justify-between px-4">
        <button
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[color:var(--overlay)]"
          onClick={onNavigateHome}
          type="button"
        >
          <span className="text-[17px] font-black tracking-[-0.01em] text-[color:var(--tx)]">Nessie</span>
          <svg
            className="h-4 w-4 text-[color:var(--tx2)]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              d="M19 9l-7 7-7-7"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.5"
            />
          </svg>
        </button>

        <button
          aria-label="Start new chat"
          className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)]"
          onClick={onNavigateNewConversation}
          title="Start new chat"
          type="button"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            viewBox="0 0 24 24"
          >
            <path
              d={[
                'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5',
                'm-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
              ].join(' ')}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

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
          personalAssistantBootstrapping={personalAssistantBootstrapping}
          personalAssistantChannelId={personalAssistantChannelId}
          personalAssistantUnreadCount={personalAssistantUnreadCount}
          sidebarAgentDms={sidebarAgentDms}
          sidebarGroupDms={sidebarGroupDms}
          sidebarPeople={sidebarPeople}
          sidebarProductAssistants={sidebarProductAssistants}
          starredUserIds={starredUserIds}
          toggleDmCollapsed={toggleDmCollapsed}
          unreadCountByChannelId={unreadCountByChannelId}
        />
      </div>
    </aside>
  );
};
