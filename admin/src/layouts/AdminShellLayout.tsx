import { Navigate, Outlet } from 'react-router-dom';
import { AgentDetailDrawer } from '../components/features/agents/AgentDetailDrawer';
import { KnowledgeProvider } from '../components/features/knowledge/KnowledgeProvider';
import { isDesktopApp } from '../lib/desktop';
import { isReactNativeWebView, useMobileLayout, usePhoneLayout } from '../lib/mobile-shell';
import { NotificationsProvider } from '../providers/NotificationsProvider';
import { AdminSidebarNav } from './admin-shell/AdminSidebarNav';
import { KnowledgeSidebarNav } from './admin-shell/KnowledgeSidebarNav';
import { MobileNavDrawer } from './admin-shell/MobileNavDrawer';
import { MobileNavProvider } from './admin-shell/MobileNavContext';
import { MobileTabBar } from './admin-shell/MobileTabBar';
import { ProjectsSidebarNav } from './admin-shell/ProjectsSidebarNav';
import { SidebarDialogs } from './admin-shell/SidebarDialogs';
import { SidebarNav } from './admin-shell/SidebarNav';
import { SidebarRail } from './admin-shell/SidebarRail';
import { useAdminShell } from './admin-shell/useAdminShell';

export type { AdminShellOutletContext } from './admin-shell/types';

export const AdminShellLayout = () => {
  const shell = useAdminShell();
  const { me, sessionState } = shell;
  const mobileLayout = useMobileLayout();
  // Phones get the hamburger drawer; tablets (iPad) keep the secondary sidebar
  // pinned even though they are "mobile" (their native tab bar replaces the rail).
  const phoneLayout = usePhoneLayout();
  const nativeShell = isReactNativeWebView();
  // The web tab bar is only for mobile *web*; the native app draws its own
  // native glass tab bar around the WebView.
  const showWebTabBar = mobileLayout && !nativeShell;

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

  const sidebarNavElement = (
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
  );

  // The contextual secondary nav for the active section. Knowledge needs the
  // KnowledgeProvider (wrapped below). Feedback has no secondary column on
  // desktop; everything else falls back to the channels/DMs SidebarNav.
  const secNavElement = shell.isKnowledgeRoute ? (
    <KnowledgeSidebarNav />
  ) : shell.isProjectsRoute ? (
    <ProjectsSidebarNav isOwner={shell.isOwner} pathname={shell.pathname} />
  ) : shell.isAdminRoute ? (
    <AdminSidebarNav
      isOwner={shell.isOwner}
      isSuperAdmin={shell.isSuperAdmin}
      pathname={shell.pathname}
    />
  ) : shell.isFeedbackRoute ? null : (
    sidebarNavElement
  );

  // On mobile the drawer always has content (fall back to SidebarNav) so the
  // hamburger is never a dead button.
  const drawerNavElement = secNavElement ?? sidebarNavElement;

  const contentRegion = phoneLayout ? (
    <>
      <MobileNavDrawer onClose={shell.closeMobileDrawer} open={shell.mobileDrawerOpen}>
        {drawerNavElement}
      </MobileNavDrawer>
      {mainContent}
    </>
  ) : (
    <>
      {secNavElement}
      {mainContent}
    </>
  );

  const shellClassName = [
    'admin-shell',
    isDesktopApp() ? 'pt-[28px]' : '',
    showWebTabBar ? 'has-mobile-tabbar' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <NotificationsProvider>
      <MobileNavProvider value={{ openDrawer: shell.openMobileDrawer }}>
        <div className={shellClassName}>
          {!mobileLayout && (
            <SidebarRail onLogout={shell.logoutAndRedirect} pathname={shell.pathname} />
          )}

          {shell.isKnowledgeRoute ? (
            <KnowledgeProvider>{contentRegion}</KnowledgeProvider>
          ) : (
            contentRegion
          )}
        </div>

        {showWebTabBar && <MobileTabBar />}

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
      </MobileNavProvider>
    </NotificationsProvider>
  );
};
