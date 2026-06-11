import { Navigate, Outlet } from 'react-router-dom';
import { AgentDetailDrawer } from '../components/features/agents/AgentDetailDrawer';
import { KnowledgeProvider } from '../components/features/knowledge/KnowledgeProvider';
import { isDesktopApp } from '../lib/desktop';
import { NotificationsProvider } from '../providers/NotificationsProvider';
import { AdminSidebarNav } from './admin-shell/AdminSidebarNav';
import { AgentsSidebarNav } from './admin-shell/AgentsSidebarNav';
import { KnowledgeSidebarNav } from './admin-shell/KnowledgeSidebarNav';
import { ProjectsSidebarNav } from './admin-shell/ProjectsSidebarNav';
import { SidebarDialogs } from './admin-shell/SidebarDialogs';
import { SidebarNav } from './admin-shell/SidebarNav';
import { SidebarRail } from './admin-shell/SidebarRail';
import { useAdminShell } from './admin-shell/useAdminShell';

export type { AdminShellOutletContext } from './admin-shell/types';

export const AdminShellLayout = () => {
  const shell = useAdminShell();
  const { me, sessionState } = shell;

  if (sessionState === 'bootstrap') {
    return <Navigate to="/bootstrap" replace />;
  }

  if (sessionState === 'loading') {
    return (
      <main
        className={[
          'flex min-h-screen items-center justify-center bg-[color:var(--main)]',
          'px-6 py-10 text-[color:var(--tx)]',
        ].join(' ')}
      >
        <div className="admin-card w-full max-w-xl p-8">Loading workspace...</div>
      </main>
    );
  }

  if (sessionState !== 'authenticated' || !me) {
    return <Navigate to="/login" replace />;
  }

  const mainContent = (
    <main className="min-w-0 flex-1 overflow-hidden bg-[color:var(--main)]">
      <Outlet
        context={{
          onCreateChannel: shell.openCreateChannel,
          onSelectAgent: shell.selectAgent,
          scopedAgents: shell.scopedAgents,
        }}
      />
    </main>
  );

  return (
    <NotificationsProvider>
      <div className={`admin-shell${isDesktopApp() ? ' pt-[28px]' : ''}`}>
        <SidebarRail
          displayName={me.user.displayName}
          isAdminRoute={shell.isAdminRoute}
          isAgentsRoute={shell.isAgentsRoute}
          onLogout={shell.logoutAndRedirect}
          pathname={shell.pathname}
        />

        {shell.isKnowledgeRoute ? (
          <KnowledgeProvider>
            <KnowledgeSidebarNav />
            {mainContent}
          </KnowledgeProvider>
        ) : (
          <>
            {shell.isAgentsRoute && <AgentsSidebarNav pathname={shell.pathname} />}

            {shell.isProjectsRoute && (
              <ProjectsSidebarNav isOwner={shell.isOwner} pathname={shell.pathname} />
            )}

            {shell.isAdminRoute && (
              <AdminSidebarNav
                isOwner={shell.isOwner}
                isSuperAdmin={shell.isSuperAdmin}
                pathname={shell.pathname}
              />
            )}

            {!shell.isAgentsRoute && !shell.isAdminRoute && !shell.isProjectsRoute && (
          <SidebarNav
            activeDmChannelId={shell.activeDmChannelId}
            channelsCollapsed={shell.channelsCollapsed}
            currentChannelId={shell.currentChannelId}
            currentProjectId={shell.currentProjectId}
            defaultProjectChannels={shell.defaultProjectChannels}
            defaultProjectTeamId={shell.defaultProjectTeamId}
            dmCollapsed={shell.dmCollapsed}
            isOwner={shell.isOwner}
            onNavigateChannel={shell.navigateToChannel}
            onNavigateDm={shell.navigateToDm}
            onNavigateHome={shell.navigateHome}
            onNavigateProject={shell.navigateToProject}
            onNavigateSettings={shell.navigateToSettings}
            onOpenCreateChannel={shell.openCreateChannel}
            onOpenCreateProject={shell.openCreateProject}
            onOpenPersonalAssistant={() => void shell.openPersonalAssistant()}
            onOpenRenameProject={shell.openRenameProject}
            onSelectAgent={shell.selectAgent}
            onToggleStar={shell.toggleStar}
            personalAssistantBootstrapping={shell.personalAssistantBootstrapping}
            personalAssistantChannelId={shell.personalAssistantChannelId}
            personalAssistantUnreadCount={shell.personalAssistantUnreadCount}
            projectsCollapsed={shell.projectsCollapsed}
            realtime={shell.realtime}
            scopedAgents={shell.scopedAgents}
            selectedAgentId={shell.selectedAgentId}
            setSidebarMenu={shell.setSidebarMenu}
            sidebarMenu={shell.sidebarMenu}
            sidebarPeople={shell.sidebarPeople}
            starredChannelIds={shell.starredChannelIds}
            starredCollapsed={shell.starredCollapsed}
            starredProjectIds={shell.starredProjectIds}
            starredUserIds={shell.starredUserIds}
            teamIdByProjectId={shell.teamIdByProjectId}
            toggleChannelsCollapsed={shell.toggleChannelsCollapsed}
            toggleDmCollapsed={shell.toggleDmCollapsed}
            toggleProjectsCollapsed={shell.toggleProjectsCollapsed}
            toggleStarredCollapsed={shell.toggleStarredCollapsed}
            unreadCountByChannelId={shell.unreadCountByChannelId}
            visibleSidebarProjects={shell.visibleSidebarProjects}
            visibleStarredEntries={shell.visibleStarredEntries}
          />
            )}

            {mainContent}
          </>
        )}
      </div>

      <SidebarDialogs
        createChannelTarget={shell.createChannelTarget}
        createProjectOpen={shell.createProjectOpen}
        onCloseCreateChannel={shell.closeCreateChannel}
        onCloseCreateProject={shell.closeCreateProject}
        onCloseRenameProject={shell.closeRenameProject}
        renameProjectTarget={shell.renameProjectTarget}
      />

      <AgentDetailDrawer
        agent={shell.selectedAgent}
        onClose={shell.closeAgentDrawer}
        onSelectAgent={shell.selectAgent}
      />
    </NotificationsProvider>
  );
};
