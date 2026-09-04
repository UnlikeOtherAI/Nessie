import { useEffect, type ReactNode } from 'react';
import { Navigate, useOutlet } from 'react-router-dom';
import { AgentDetailDrawer } from '../components/features/agents/AgentDetailDrawer';
import { KnowledgeProvider } from '../components/features/knowledge/KnowledgeProvider';
import {
  isReactNativeWebView,
  useMobileLayout,
  useNativeLargePhoneLandscapeApp,
  useNativeIPadApp,
  useNativePhoneApp,
  useNavigationLayout,
} from '../lib/mobile-shell';
import { NotificationsProvider } from '../providers/NotificationsProvider';
import { AgentIdentityProvider } from '../providers/AgentIdentityProvider';
import { PresenceProvider } from '../providers/PresenceProvider';
import { PushSurfacePresenceHeartbeat } from '../providers/PushSurfacePresenceHeartbeat';
import { AttentionDisplayManager } from '../providers/AttentionDisplayManager';
import { ToastProvider } from '../providers/ToastProvider';
import { useAuthSession } from '../providers/AuthSessionProvider';
import { AdminSidebarNav } from './admin-shell/AdminSidebarNav';
import { AccountMenuProvider } from './admin-shell/AccountMenuContext';
import { KnowledgeSidebarNav } from './admin-shell/KnowledgeSidebarNav';
import { MobileNavDrawer } from './admin-shell/MobileNavDrawer';
import { LocalBackProvider } from './admin-shell/local-back/LocalBackContext';
import { MobileNavProvider } from './admin-shell/MobileNavContext';
import { MobileTabBar } from './admin-shell/MobileTabBar';
import { MobileWebHomeHeader } from './admin-shell/MobileWebHomeHeader';
import { PhoneNavigationViewport } from './admin-shell/PhoneNavigationViewport';
import { useKeyboardInset } from '../navigation/keyboard';
import { SeededRoute, useShellRoutes } from '../navigation/SeededRoute';
import { SHELL_MAIN_ID, SkipToContentLink } from '../navigation/SkipToContentLink';
import {
  isPhoneTabRoot,
  phoneTabRootHasContextualList,
} from './admin-shell/phone-navigation';
import { PhoneNavigationProvider } from './admin-shell/PhoneNavigationProvider';
import { NativeIPadToolbarBridge } from './admin-shell/NativeIPadToolbarBridge';
import { NativePhoneCreationBridge } from './admin-shell/NativePhoneCreationBridge';
import { NativeSearchOverlay } from './admin-shell/NativeSearchOverlay';
import { ProjectsSidebarNav } from './admin-shell/ProjectsSidebarNav';
import { ResizableSidebar } from './admin-shell/ResizableSidebar';
import { SidebarDialogs } from './admin-shell/SidebarDialogs';
import { SidebarNav } from './admin-shell/SidebarNav';
import { SidebarRail } from './admin-shell/SidebarRail';
import { TopBar } from './admin-shell/TopBar';
import { TransientMenuProvider } from './admin-shell/TransientMenuContext';
import { useRecordRecentChannelVisits } from './admin-shell/topbar-navigation';
import { UserMenuTrigger } from './admin-shell/UserMenuTrigger';
import { useAdminShell } from './admin-shell/useAdminShell';
import { TeamSwitcher } from './admin-shell/TeamSwitcher';
import { useAttentionSummary } from '../facades/alerts/hooks';
import { useThreadActivity, useThreadActivityEvents } from '../facades/threads/activity-hooks';
import { useUnreadDirectMessages } from '../facades/threads/unread-direct-messages';
import { useFocusMode } from '../providers/FocusModeProvider';

import { ShellActionsProvider } from './admin-shell/ShellActionsContext';
import type { AdminShellOutletContext } from './admin-shell/types';
export type { AdminShellOutletContext } from './admin-shell/types';

// A phone has room for one primary decision at a time. Its tab root therefore
// renders the tab's existing contextual navigation as the page, while tablet
// and desktop keep that navigation beside the selected detail. The root set
// lives in phone-navigation (isPhoneTabRoot) next to the transition screen
// model and Back destinations so the three cannot drift.

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
        <div className="admin-card w-full max-w-xl p-8">Loading team...</div>
      </main>
    );
  }

  if (sessionState !== 'authenticated' || !me) {
    return <Navigate to="/login" replace />;
  }

  return (
    <LocalBackProvider>
      {/* One persistent provider for the whole authenticated shell: its
          route-history ledger, the shared Back doorway, the web tab bar, and
          the native phone bridge must never fork per-route state. */}
      <PhoneNavigationProvider>
        <AuthenticatedAdminShellLayout />
      </PhoneNavigationProvider>
    </LocalBackProvider>
  );
};

// Keep authenticated data hooks out of the loading tree. In particular,
// useAdminShell starts several API queries; mounting it while an expired access
// token is being restored can create competing refresh-token rotations.
const AuthenticatedAdminShellLayout = () => {
  const { focusModeEnabled } = useFocusMode();
  // Overlays are portalled to the document (components/overlays/OverlayPortal.tsx),
  // so `.focus-mode > .admin-shell` — which is what repaints the work surface
  // monochrome — no longer reaches them. Mirror the mode onto the body so an
  // open dialog stays with the surface it was opened from.
  useEffect(() => {
    document.body.classList.toggle('overlays-focus-mode', focusModeEnabled);
    return () => document.body.classList.remove('overlays-focus-mode');
  }, [focusModeEnabled]);
  const shell = useAdminShell();
  useRecordRecentChannelVisits();
  // One listener for the whole shell — every composer reads --keyboard-inset
  // rather than each mounting its own visualViewport watcher.
  useKeyboardInset();
  const attention = useAttentionSummary();
  const threadActivity = useThreadActivity();
  const unreadDirectMessages = useUnreadDirectMessages();
  useThreadActivityEvents();
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
  const navigationLayout = useNavigationLayout();
  const shellRoutes = useShellRoutes(AdminShellLayout);
  const phoneLayout = navigationLayout === 'single';
  const nativeShell = isReactNativeWebView();
  const nativeIPadApp = useNativeIPadApp();
  const nativeLargePhoneLandscape = useNativeLargePhoneLandscapeApp();
  const nativePhoneApp = useNativePhoneApp();
  const showPhoneTabRoot = phoneLayout && isPhoneTabRoot(shell.pathname);
  useEffect(() => {
    if (showPhoneTabRoot) shell.closeMobileDrawer();
  }, [shell.closeMobileDrawer, showPhoneTabRoot]);

  const isComposeRoute = shell.pathname === '/channels/new';
  // The web tab bar is only for mobile *web*; the native app draws its own
  // native glass tab bar around the WebView.
  const showWebTabBar = mobileLayout && !nativeShell && !isComposeRoute;
  const showNativePhoneTabBar = nativePhoneApp && !isComposeRoute;
  const showMobileWebHomeHeader = showWebTabBar && showPhoneTabRoot;
  // Whenever a bottom tab bar is present — the web tab bar on mobile web, or the
  // native app's own tab bar on phone/iPad — drop the entire top bar. Navigation
  // lives in the bottom bar (which carries its own Search tab) and each page
  // supplies its own mobile header (hamburger + title).
  const hideTopBar = isComposeRoute || showWebTabBar || (nativeShell && (nativePhoneApp || nativeIPadApp));

  // Capture the matched route as a concrete element. The phone transition
  // keeps that element mounted while it leaves; retaining a live <Outlet>
  // would resolve both layers against the new route and duplicate the incoming
  // page instead of preserving the outgoing one.
  const outlet = useOutlet();
  // The shell's actions reach every page — routed or seeded — as one context.
  const shellActions: AdminShellOutletContext = {
    onCreateAgent: shell.navigateToAgentDesigner,
    onCreateChannel: shell.openCreateChannel,
    onSelectAgent: shell.selectAgent,
  };

  const sidebarNavElement = (
    <SidebarNav
      attentionCountByProjectId={attentionCountByProjectId}
      activeDmChannelId={shell.activeDmChannelId}
      channelsCollapsed={shell.channelsCollapsed}
      currentChannelId={shell.currentChannelId}
      currentProjectId={shell.currentProjectId}
      dmCollapsed={shell.dmCollapsed}
      onNavigateAgent={shell.navigateToAgent}
      onNavigateChannel={shell.navigateToChannel}
      onNavigateThreads={shell.navigateToThreads}
      onNavigateUnreadMessages={shell.navigateToUnreadMessages}
      onNavigateDm={shell.navigateToDm}
      onNavigateNewConversation={shell.navigateToNewConversation}
      onNavigateProject={shell.navigateToProject}
      onOpenCreateChannel={shell.openCreateChannel}
      onOpenCreateProject={shell.openCreateProject}
      onOpenPersonalAssistant={() => void shell.openPersonalAssistant()}
      onOpenEditProject={shell.openEditProject}
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
      sidebarProjects={shell.sidebarProjects}
      sidebarProjectsLoaded={shell.sidebarProjectsLoaded}
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
      standaloneChannels={shell.standaloneChannels}
      threadsUnreadCount={threadActivity.data?.unreadTotal ?? 0}
      unreadDirectMessageCount={unreadDirectMessages.data?.length ?? 0}
    />
  );

  // The contextual secondary nav for the active section. Knowledge needs the
  // KnowledgeProvider (wrapped below). Feedback has no
  // secondary column on desktop; everything else falls back to the
  // channels/DMs SidebarNav.
  const secNavElement = shell.isKnowledgeRoute ? (
    <KnowledgeSidebarNav />
  ) : shell.isProjectsRoute ? (
    <ProjectsSidebarNav isOwner={shell.isOwner} pathname={shell.pathname} />
  ) : shell.isAdminRoute ? (
    <AdminSidebarNav
      canManageOrganization={shell.canManageOrganization}
      isAdmin={shell.isAdmin}
      isOwner={shell.isOwner}
      isSuperAdmin={shell.isSuperAdmin}
      isUoaSession={shell.isUoaSession}
      pathname={shell.pathname}
    />
  ) : shell.isFeedbackRoute ? null : (
    sidebarNavElement
  );

  // On mobile the drawer always has content (fall back to SidebarNav) so the
  // hamburger is never a dead button.
  const drawerNavElement = secNavElement ?? sidebarNavElement;

  // The section's contextual list as a phone page: the root screen, and
  // what a cold start seeds beneath a section's details.
  const rootListElement = (
    <div
      className={[
        'flex h-full min-w-0 flex-1 overflow-clip bg-[color:var(--main)]',
        '[&>aside]:w-full [&>aside]:border-r-0',
      ].join(' ')}
    >
      {drawerNavElement}
    </div>
  );

  // A cold start seeds the screens beneath the landed route
  // (docs/navigation/overview.md §8): a root's page on a phone is the section's list;
  // anything else is the route table's page for that pathname.
  const seedScreen = (pathname: string): ReactNode =>
    isPhoneTabRoot(pathname) && phoneTabRootHasContextualList(pathname)
      ? rootListElement
      : <SeededRoute pathname={pathname} routes={shellRoutes} />;

  // On `split` the pinned list column is the section's root, and the detail
  // column is its own navigation stack: a detail → nested push slides inside
  // this column with the detail retained beneath, exactly as on a phone.
  const mainContent = phoneLayout ? (
    <main
      className="min-w-0 flex-1 overflow-clip bg-[color:var(--main)]"
      id={SHELL_MAIN_ID}
      tabIndex={-1}
    >
      {outlet}
    </main>
  ) : (
    <main
      className="flex min-w-0 flex-1 overflow-clip bg-[color:var(--main)]"
      id={SHELL_MAIN_ID}
      tabIndex={-1}
    >
      <PhoneNavigationViewport layout="split" pathname={shell.pathname} seed={seedScreen}>
        {outlet}
      </PhoneNavigationViewport>
    </main>
  );


  // Root content is the section's contextual list when one exists; /search
  // and /dashboards are full outlet pages with no secondary sidebar, so their
  // root page is the outlet itself rather than the channels fallback.
  const rootHasContextualList = phoneTabRootHasContextualList(shell.pathname);
  const phonePageContent = showPhoneTabRoot && rootHasContextualList
    ? rootListElement
    : mainContent;

  const contentRegion = phoneLayout ? (
    <>
      {!showPhoneTabRoot ? (
        <MobileNavDrawer onClose={shell.closeMobileDrawer} open={shell.mobileDrawerOpen}>
          {drawerNavElement}
        </MobileNavDrawer>
      ) : null}
      {/*
        The surface registry is total, so every route a phone can stand on
        classifies and the viewport is mounted unconditionally. It used to be
        conditional because unclassified routes (/threads, /alerts, /feedback,
        /channels/new) would have made the stack throw; those now have rows,
        and rendering them outside the stack was itself the defect — they lost
        every retained screen beneath them.
      */}
      <PhoneNavigationViewport pathname={shell.pathname} seed={seedScreen}>
        {phonePageContent}
      </PhoneNavigationViewport>
    </>
  ) : (
    <>
      {secNavElement ? (
        <ResizableSidebar fixed={nativeLargePhoneLandscape}>{secNavElement}</ResizableSidebar>
      ) : null}
      {mainContent}
    </>
  );

  const frameClassName = [
    'admin-frame',
    focusModeEnabled ? 'focus-mode' : '',
    showWebTabBar ? 'has-mobile-tabbar' : '',
    showNativePhoneTabBar ? 'has-native-phone-tabbar' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <AgentIdentityProvider>
    <PresenceProvider>
      <AttentionDisplayManager />
      <PushSurfacePresenceHeartbeat />
      <ToastProvider>
        <NotificationsProvider>
          <TransientMenuProvider>
            <AccountMenuProvider
              onLogout={shell.logoutAndRedirect}
              showHeaderAccountMenu={hideTopBar && mobileLayout && !nativeIPadApp && !nativePhoneApp}
            >
              <MobileNavProvider value={{ openDrawer: shell.openMobileDrawer }}>
                <SkipToContentLink />
                <div className={frameClassName} data-navigation={navigationLayout}>
                  {showMobileWebHomeHeader ? <MobileWebHomeHeader onLogout={shell.logoutAndRedirect} /> : null}
                  {hideTopBar ? null : (
                    <TopBar
                      hideSearch={nativeIPadApp}
                      onLogout={shell.logoutAndRedirect}
                      showAccountMenu={mobileLayout}
                    />
                  )}

                  <ShellActionsProvider value={shellActions}>
                  <div className="admin-shell">
                    {!mobileLayout && (
                      <SidebarRail
                        onCreateAgent={() => void shell.openAgentDesignerChat()}
                        onCreateChannel={() => shell.openCreateChannel()}
                        onCreateMessage={shell.navigateToNewConversation}
                        onCreateProject={shell.openCreateProject}
                        onLogout={shell.logoutAndRedirect}
                        pathname={shell.pathname}
                      />
                    )}

                    {shell.isKnowledgeRoute ? (
                      <KnowledgeProvider>{contentRegion}</KnowledgeProvider>
                    ) : (
                      contentRegion
                    )}
                  </div>
                  </ShellActionsProvider>
                </div>

                {showWebTabBar && <MobileTabBar />}
                {(nativeIPadApp || nativePhoneApp) && <TeamSwitcher variant="native-bridge" />}
                {(nativeIPadApp || nativePhoneApp) && !isComposeRoute && <NativeIPadToolbarBridge />}
                {(nativeIPadApp || nativePhoneApp) ? (
                  <UserMenuTrigger
                    nativeShellBridge
                    onLogout={shell.logoutAndRedirect}
                    placement="topbar"
                  />
                ) : null}
                {nativePhoneApp ? (
                  <NativePhoneCreationBridge
                    onCreateAgent={() => void shell.openAgentDesignerChat()}
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
                  editProjectTarget={shell.editProjectTarget}
                  onCloseEditProject={shell.closeEditProject}
                />

                <AgentDetailDrawer
                  agent={shell.selectedAgent}
                  onClose={shell.closeAgentDrawer}
                  onSelectAgent={shell.selectAgent}
                />
              </MobileNavProvider>
            </AccountMenuProvider>
          </TransientMenuProvider>
        </NotificationsProvider>
      </ToastProvider>
    </PresenceProvider>
    </AgentIdentityProvider>
  );
};
