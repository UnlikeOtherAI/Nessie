import { useEffect } from 'react';
import { Navigate, useOutlet } from 'react-router-dom';
import { AgentDetailDrawer } from '../components/features/agents/AgentDetailDrawer';
import { KnowledgeProvider } from '../components/features/knowledge/KnowledgeProvider';
import {
  isReactNativeWebView,
  useMobileLayout,
  useNativeIPadApp,
  useNativePhoneApp,
  usePhoneLayout,
} from '../lib/mobile-shell';
import { NotificationsProvider } from '../providers/NotificationsProvider';
import { PresenceProvider } from '../providers/PresenceProvider';
import { PushSurfacePresenceHeartbeat } from '../providers/PushSurfacePresenceHeartbeat';
import { AttentionDisplayManager } from '../providers/AttentionDisplayManager';
import { ToastProvider } from '../providers/ToastProvider';
import { useAuthSession } from '../providers/AuthSessionProvider';
import { AdminSidebarNav } from './admin-shell/AdminSidebarNav';
import { AccountMenuProvider } from './admin-shell/AccountMenuContext';
import { KnowledgeSidebarNav } from './admin-shell/KnowledgeSidebarNav';
import { MobileNavDrawer } from './admin-shell/MobileNavDrawer';
import { MobileNavProvider } from './admin-shell/MobileNavContext';
import { MobileTabBar } from './admin-shell/MobileTabBar';
import { MobileWebHomeHeader } from './admin-shell/MobileWebHomeHeader';
import { PhoneNavigationViewport } from './admin-shell/PhoneNavigationViewport';
import { getPhoneNavigationScreen } from './admin-shell/phone-navigation-transition';
import { NativeIPadToolbarBridge } from './admin-shell/NativeIPadToolbarBridge';
import { NativePhoneCreationBridge } from './admin-shell/NativePhoneCreationBridge';
import { NativeSearchOverlay } from './admin-shell/NativeSearchOverlay';
import { ProjectsSidebarNav } from './admin-shell/ProjectsSidebarNav';
import { ResizableSidebar } from './admin-shell/ResizableSidebar';
import { SidebarDialogs } from './admin-shell/SidebarDialogs';
import { SidebarNav } from './admin-shell/SidebarNav';
import { SidebarRail } from './admin-shell/SidebarRail';
import { TopBar } from './admin-shell/TopBar';
import { useRecordRecentChannelVisits } from './admin-shell/topbar-navigation';
import { UserMenuTrigger } from './admin-shell/UserMenuTrigger';
import { useAdminShell } from './admin-shell/useAdminShell';
import { WorkspaceSwitcher } from './admin-shell/WorkspaceSwitcher';
import { useAttentionSummary } from '../facades/alerts/hooks';

export type { AdminShellOutletContext } from './admin-shell/types';

// A phone has room for one primary decision at a time. Its tab root therefore
// renders the tab's existing contextual navigation as the page, while tablet
// and desktop keep that navigation beside the selected detail.
const isPhoneTabRoot = (pathname: string): boolean =>
  pathname === '/channels'
  || pathname === '/projects'
  || pathname === '/knowledge-base'
  || pathname === '/settings'
  || pathname === '/search';

export const AdminShellLayout = () => {
  const { me, sessionState } = useAuthSession();

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

  return <AuthenticatedAdminShellLayout />;
};

// Keep authenticated data hooks out of the loading tree. In particular,
// useAdminShell starts several API queries; mounting it while an expired access
// token is being restored can create competing refresh-token rotations.
const AuthenticatedAdminShellLayout = () => {
  const shell = useAdminShell();
  useRecordRecentChannelVisits();
  const attention = useAttentionSummary();
  const attentionCountByProjectId = new Map<string, number>();
  for (const [projectId, count] of Object.entries(attention.data?.assignedWork.projects ?? {})) {
    attentionCountByProjectId.set(projectId, count);
  }
  for (const [projectId, count] of Object.entries(attention.data?.knowledge.projects ?? {})) {
    attentionCountByProjectId.set(projectId, (attentionCountByProjectId.get(projectId) ?? 0) + count);
  }
  const mobileLayout = useMobileLayout();
  // Phones get the hamburger drawer; tablets (iPad) keep the secondary sidebar
  // pinned even though they are "mobile" (their native tab bar replaces the rail).
  const phoneLayout = usePhoneLayout();
  const nativeShell = isReactNativeWebView();
  const nativeIPadApp = useNativeIPadApp();
  const nativePhoneApp = useNativePhoneApp();
  const showPhoneTabRoot = phoneLayout && isPhoneTabRoot(shell.pathname);
  useEffect(() => {
    if (showPhoneTabRoot) shell.closeMobileDrawer();
  }, [shell.closeMobileDrawer, showPhoneTabRoot]);
  const isComposeRoute = shell.pathname === '/channels/new';
  // The web tab bar is only for mobile *web*; the native app draws its own
  // native glass tab bar around the WebView.
  const showWebTabBar = mobileLayout && !nativeShell && !isComposeRoute;
  const showMobileWebHomeHeader = showWebTabBar && showPhoneTabRoot;
  // Whenever a bottom tab bar is present — the web tab bar on mobile web, or the
  // native app's own tab bar on phone/iPad — drop the entire top bar. Navigation
  // lives in the bottom bar (which carries its own Search tab) and each page
  // supplies its own mobile header (hamburger + title).
  const hideTopBar = isComposeRoute || showWebTabBar || (nativeShell && (phoneLayout || nativeIPadApp));

  // Capture the matched route as a concrete element. The phone transition
  // keeps that element mounted while it leaves; retaining a live <Outlet>
  // would resolve both layers against the new route and duplicate the incoming
  // page instead of preserving the outgoing one.
  const outlet = useOutlet({
    onCreateAgent: shell.navigateToAgentDesigner,
    onCreateChannel: shell.openCreateChannel,
    onSelectAgent: shell.selectAgent,
    scopedAgents: shell.scopedAgents,
  });

  const mainContent = (
    <main className="min-w-0 flex-1 overflow-hidden bg-[color:var(--main)]">
      {outlet}
    </main>
  );

  const sidebarNavElement = (
    <SidebarNav
      attentionCountByProjectId={attentionCountByProjectId}
      activeDmChannelId={shell.activeDmChannelId}
      channelsCollapsed={shell.channelsCollapsed}
      currentChannelId={shell.currentChannelId}
      currentProjectId={shell.currentProjectId}
      defaultProjectChannels={shell.defaultProjectChannels}
      defaultProjectTeamId={shell.defaultProjectTeamId}
      dmCollapsed={shell.dmCollapsed}
      onNavigateAgent={shell.navigateToAgent}
      onNavigateChannel={shell.navigateToChannel}
      onNavigateDm={shell.navigateToDm}
      onNavigateNewConversation={shell.navigateToNewConversation}
      onNavigateProject={shell.navigateToProject}
      onOpenCreateChannel={shell.openCreateChannel}
      onOpenCreateProject={shell.openCreateProject}
      onOpenPersonalAssistant={() => void shell.openPersonalAssistant()}
      onOpenRenameProject={shell.openRenameProject}
      onToggleStar={shell.toggleStar}
      personalAssistantAgent={shell.personalAssistantAgent}
      personalAssistantBootstrapping={shell.personalAssistantBootstrapping}
      personalAssistantChannelId={shell.personalAssistantChannelId}
      personalAssistantUnreadCount={shell.personalAssistantUnreadCount}
      projectsCollapsed={shell.projectsCollapsed}
      setSidebarMenu={shell.setSidebarMenu}
      sidebarAgentDms={shell.sidebarAgentDms}
      sidebarGroupDms={shell.sidebarGroupDms}
      sidebarMenu={shell.sidebarMenu}
      sidebarPeople={shell.sidebarPeople}
      sidebarProductAssistants={shell.sidebarProductAssistants}
      starredAgentIds={shell.starredAgentIds}
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
  // KnowledgeProvider (wrapped below). Feedback and product pages have no
  // secondary column on desktop; everything else falls back to the
  // channels/DMs SidebarNav.
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
  ) : shell.isFeedbackRoute || shell.isProductPageRoute ? null : (
    sidebarNavElement
  );

  // On mobile the drawer always has content (fall back to SidebarNav) so the
  // hamburger is never a dead button.
  const drawerNavElement = secNavElement ?? sidebarNavElement;

  const phonePageContent = showPhoneTabRoot ? (
    <div
      className={[
        'flex min-w-0 flex-1 overflow-hidden bg-[color:var(--main)]',
        '[&>aside]:w-full [&>aside]:border-r-0',
      ].join(' ')}
    >
      {drawerNavElement}
    </div>
  ) : mainContent;

  const contentRegion = phoneLayout ? (
    <>
      {!showPhoneTabRoot ? (
        <MobileNavDrawer onClose={shell.closeMobileDrawer} open={shell.mobileDrawerOpen}>
          {drawerNavElement}
        </MobileNavDrawer>
      ) : null}
      {getPhoneNavigationScreen(shell.pathname) ? (
        <PhoneNavigationViewport pathname={shell.pathname}>
          {phonePageContent}
        </PhoneNavigationViewport>
      ) : phonePageContent}
    </>
  ) : (
    <>
      {secNavElement ? <ResizableSidebar>{secNavElement}</ResizableSidebar> : null}
      {mainContent}
    </>
  );

  const frameClassName = ['admin-frame', showWebTabBar ? 'has-mobile-tabbar' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <PresenceProvider>
      <AttentionDisplayManager />
      <PushSurfacePresenceHeartbeat />
      <ToastProvider>
        <NotificationsProvider>
          <AccountMenuProvider
            onLogout={shell.logoutAndRedirect}
            showHeaderAccountMenu={hideTopBar && mobileLayout && !nativeIPadApp && !nativePhoneApp}
          >
            <MobileNavProvider value={{ openDrawer: shell.openMobileDrawer }}>
              <div className={frameClassName}>
                {showMobileWebHomeHeader ? <MobileWebHomeHeader onLogout={shell.logoutAndRedirect} /> : null}
                {hideTopBar ? null : (
                  <TopBar
                    hideSearch={nativeIPadApp}
                    onLogout={shell.logoutAndRedirect}
                    showAccountMenu={mobileLayout}
                  />
                )}

                <div className="admin-shell">
                  {!mobileLayout && (
                    <SidebarRail onLogout={shell.logoutAndRedirect} pathname={shell.pathname} />
                  )}

                  {shell.isKnowledgeRoute ? (
                    <KnowledgeProvider>{contentRegion}</KnowledgeProvider>
                  ) : (
                    contentRegion
                  )}
                </div>
              </div>

              {showWebTabBar && <MobileTabBar />}
              {(nativeIPadApp || nativePhoneApp) && <WorkspaceSwitcher variant="native-bridge" />}
              {(nativeIPadApp || nativePhoneApp) && !isComposeRoute && <NativeIPadToolbarBridge />}
              {(nativeIPadApp || nativePhoneApp) ? (
                <UserMenuTrigger nativeShellBridge onLogout={shell.logoutAndRedirect} placement="topbar" />
              ) : null}
              {nativePhoneApp ? (
                <NativePhoneCreationBridge
                  onCreateChannel={shell.openCreateChannel}
                  onCreateMessage={shell.navigateToNewConversation}
                  onCreateProject={shell.openCreateProject}
                />
              ) : null}
              {nativeIPadApp && <NativeSearchOverlay />}

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
          </AccountMenuProvider>
        </NotificationsProvider>
      </ToastProvider>
    </PresenceProvider>
  );
};
