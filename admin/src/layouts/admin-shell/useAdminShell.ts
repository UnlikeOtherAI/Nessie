import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAgentRealtime, useAgents } from '../../facades/agents/hooks';
import { useChannels } from '../../facades/channels/hooks';
import { useNavigateToDm } from '../../facades/channels/dm-navigation';
import { useFavorites, useSetFavorite } from '../../facades/favorites/hooks';
import { useProductSurfaces } from '../../facades/integrations/useProductSurfaces';
import {
  isPersonalAssistantChannel,
  usePersonalAssistant,
  usePersonalAssistantBootstrap,
} from '../../facades/personal-assistant/hooks';
import { useProjects, useTeams } from '../../facades/projects/hooks';
import { useUsers } from '../../facades/users/hooks';
import type { AgentRecord } from '../../lib/api-client';
import { newChannelComposeLocationState } from '../../lib/channel-compose-navigation';
import { parseChannelIdFromPath, parseChannelProjectIdFromPath } from '../../lib/channel-route';
import { useAuthSession } from '../../providers/AuthSessionProvider';
import { matchesAdminRoute } from './nav-items';
import { useSidebarDms } from './useSidebarDms';
import { useSidebarTree } from './useSidebarTree';
import { useStarredItems } from './useStarredItems';
import { useVisibleStarredEntries } from './useVisibleStarredEntries';
import {
  type CreateChannelTarget,
  type PreferenceStarredItem,
  type RenameProjectTarget,
  type SidebarMenu,
  type StarredItem,
} from './types';

/**
 * Owns the admin shell's layout-local state, derived sidebar data, realtime
 * wiring, and navigation handlers. Composes useStarredItems and useSidebarTree.
 */
export const useAdminShell = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout, me, sessionState } = useAuthSession();
  const { data: channels = [] } = useChannels();
  const { data: projects = [] } = useProjects();
  const { data: teams = [] } = useTeams();
  const { data: agents = [] } = useAgents();
  const { data: favorites = [] } = useFavorites();
  const setFavorite = useSetFavorite();
  const isAdmin = me?.user.roleIds.includes('admin') ?? false;
  const isOwner = me?.user.roleIds.includes('owner') ?? false;
  const isSuperAdmin = me?.user.superAdmin ?? false;
  const { data: users = [] } = useUsers(isOwner);
  const isAgentsRoute = location.pathname.startsWith('/agents');
  const isKnowledgeRoute = location.pathname.startsWith('/knowledge-base');
  const isProjectsRoute = location.pathname.startsWith('/projects');
  const isFeedbackRoute = location.pathname.startsWith('/feedback');
  const isAdminRoute = matchesAdminRoute(location.pathname);
  const productSurfaces = useProductSurfaces();
  // A live product `nav_page` route (e.g. DeepSignal's /signals). These pages
  // host their own full-width content and take no channels/DM secondary nav.
  const isProductPageRoute = productSurfaces.navPages.some(
    (page) => location.pathname === page.route
      || location.pathname.startsWith(`${page.route}/`),
  );
  const currentChannelId = parseChannelIdFromPath(location.pathname);
  const currentChannelsProjectId = parseChannelProjectIdFromPath(location.pathname);
  const personalAssistantChannel = useMemo(
    () => channels.find(isPersonalAssistantChannel) ?? null,
    [channels],
  );
  const hasAgentFavorite = useMemo(
    () => favorites.some((favorite) => favorite.targetType === 'agent'),
    [favorites],
  );
  const { data: personalAssistantState } = usePersonalAssistant(
    Boolean(personalAssistantChannel || hasAgentFavorite),
  );
  const realtime = useAgentRealtime({
    channelId: currentChannelId,
    channelIds: personalAssistantChannel ? [personalAssistantChannel.id] : [],
    threadId: currentChannelId
      ? channels.find((channel) => channel.id === currentChannelId)?.defaultThreadId
      : undefined,
  });
  const activeDmChannel = currentChannelId
      ? channels.find((c) => c.id === currentChannelId && c.type === 'dm')
    : undefined;
  const personalAssistantBootstrap = usePersonalAssistantBootstrap();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [createChannelTarget, setCreateChannelTarget] = useState<CreateChannelTarget | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [renameProjectTarget, setRenameProjectTarget] = useState<RenameProjectTarget | null>(null);
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenu>(null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const initialStarred = useMemo<PreferenceStarredItem[]>(
    () => me?.user.preferences?.starred ?? [],
    [me?.user.preferences?.starred],
  );
  const {
    channelsCollapsed,
    dmCollapsed,
    projectsCollapsed,
    starredCollapsed,
    starred: preferenceStarred,
    toggleChannelsCollapsed,
    toggleDmCollapsed,
    toggleProjectsCollapsed,
    toggleStar: togglePreferenceStar,
    toggleStarredCollapsed,
  } = useStarredItems({ initialStarred });

  const favoriteStarred = useMemo<StarredItem[]>(
    () =>
      favorites.map((favorite) => ({
        id: favorite.targetId,
        type: favorite.targetType,
      })),
    [favorites],
  );

  const starred = useMemo<StarredItem[]>(() => {
    const entries: StarredItem[] = [];
    const seen = new Set<string>();
    const append = (item: StarredItem): void => {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      entries.push(item);
    };

    preferenceStarred.forEach(append);
    favoriteStarred.forEach(append);
    return entries;
  }, [favoriteStarred, preferenceStarred]);

  const favoriteKeys = useMemo(
    () => new Set(favorites.map((favorite) => `${favorite.targetType}:${favorite.targetId}`)),
    [favorites],
  );
  const preferenceKeys = useMemo(
    () => new Set(preferenceStarred.map((item) => `${item.type}:${item.id}`)),
    [preferenceStarred],
  );
  const starredChannelIds = useMemo(
    () => new Set(starred.filter((item) => item.type === 'channel').map((item) => item.id)),
    [starred],
  );
  const starredAgentIds = useMemo(
    () => new Set(starred.filter((item) => item.type === 'agent').map((item) => item.id)),
    [starred],
  );
  const starredProjectIds = useMemo(
    () => new Set(starred.filter((item) => item.type === 'project').map((item) => item.id)),
    [starred],
  );
  const starredUserIds = useMemo(
    () => new Set(starred.filter((item) => item.type === 'user').map((item) => item.id)),
    [starred],
  );

  const toggleStar = useCallback((type: StarredItem['type'], id: string) => {
    if (type === 'project') {
      togglePreferenceStar(type, id);
      return;
    }

    const key = `${type}:${id}`;
    const favoriteExists = favoriteKeys.has(key);
    const preferenceExists = preferenceKeys.has(key);
    if (type !== 'agent' && preferenceExists) {
      togglePreferenceStar(type, id);
    }
    if (favoriteExists) {
      setFavorite.mutate({ favorite: false, targetId: id, targetType: type });
      return;
    }
    if (!preferenceExists) {
      setFavorite.mutate({ favorite: true, targetId: id, targetType: type });
    }
  }, [favoriteKeys, preferenceKeys, setFavorite, togglePreferenceStar]);

  const unreadCountByChannelId = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel.unreadCount])),
    [channels],
  );

  const {
    channelById,
    defaultProjectChannels,
    defaultProjectTeamId,
    projectById,
    standardChannels,
    teamIdByProjectId,
    visibleSidebarProjects,
  } = useSidebarTree({
    channels,
    projects,
    starredChannelIds,
    starredProjectIds,
    teams,
  });

  const currentProjectId = useMemo(
    () =>
      currentChannelsProjectId
      ?? standardChannels.find((channel) => channel.id === currentChannelId)?.projectId,
    [currentChannelId, currentChannelsProjectId, standardChannels],
  );

  const openCreateChannel = useCallback((target?: CreateChannelTarget) => {
    setSidebarMenu(null);
    setCreateChannelTarget(target ?? {});
  }, []);
  const closeCreateChannel = useCallback(() => setCreateChannelTarget(null), []);
  const openCreateProject = useCallback(() => {
    setSidebarMenu(null);
    setCreateProjectOpen(true);
  }, []);
  const closeCreateProject = useCallback(() => setCreateProjectOpen(false), []);
  const openRenameProject = useCallback((target: RenameProjectTarget) => {
    setSidebarMenu(null);
    setRenameProjectTarget(target);
  }, []);
  const closeRenameProject = useCallback(() => setRenameProjectTarget(null), []);
  const openMobileDrawer = useCallback(() => setMobileDrawerOpen(true), []);
  const closeMobileDrawer = useCallback(() => setMobileDrawerOpen(false), []);

  const navigateToProject = useCallback((projectId: string) => {
    void navigate(`/channels/projects/${projectId}`);
  }, [navigate]);

  const scopedAgents = agents;

  // The general agent list and the PA-state request resolve independently.
  // Prefer the purpose-built PA state, but retain the managed agent record from
  // the general list so the Direct-messages entry never falls back to its glyph
  // while its starred counterpart already has an uploaded/generated avatar.
  const personalAssistantAgent = useMemo(
    () => personalAssistantState?.agent
      ?? agents.find((agent) => agent.agentKind === 'personal_assistant')
      ?? null,
    [agents, personalAssistantState?.agent],
  );

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const agentById = useMemo(() => {
    const byId = new Map<string, AgentRecord>();
    agents.forEach((agent) => byId.set(agent.id, agent));
    if (personalAssistantAgent) {
      byId.set(personalAssistantAgent.id, personalAssistantAgent);
    }
    return byId;
  }, [agents, personalAssistantAgent]);

  const selectAgent = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
  }, []);

  const closeAgentDrawer = useCallback(() => {
    setSelectedAgentId(null);
  }, []);

  const navigateToDm = useNavigateToDm();

  const navigateToChannel = useCallback((channelId: string) => {
    void navigate(`/channels/${channelId}`);
  }, [navigate]);

  const navigateToNewConversation = useCallback(() => {
    setSidebarMenu(null);
    void navigate('/channels/new', {
      state: newChannelComposeLocationState(`${location.pathname}${location.search}${location.hash}`),
    });
  }, [location.hash, location.pathname, location.search, navigate]);

  const navigateToSettings = useCallback((subPage?: string) => {
    void navigate(subPage ? `/settings/${subPage}` : '/settings');
  }, [navigate]);

  const navigateToAgentDesigner = useCallback(() => {
    void navigate('/agents/designer');
  }, [navigate]);

  const logoutAndRedirect = useCallback(() => {
    void logout().then(() => navigate('/login', { replace: true }));
  }, [logout, navigate]);

  const { sidebarAgentDms, sidebarGroupDms, sidebarPeople, sidebarProductAssistants } = useSidebarDms({
    agents,
    channels,
    chatAssistants: productSurfaces.chatAssistants,
    me,
    users,
  });

  const visibleStarredEntries = useVisibleStarredEntries({
    agentById,
    channelById,
    projectById,
    sidebarPeople,
    starred,
    starredProjectIds,
  });

  const openPersonalAssistant = useCallback(async () => {
    if (personalAssistantChannel) {
      void navigate(`/channels/${personalAssistantChannel.id}`);
      return;
    }

    try {
      const response = await personalAssistantBootstrap.mutateAsync();
      void navigate(`/channels/${response.channel.id}`);
    } catch {
      // The backend can still be bootstrapped independently; keep the rail stable.
    }
  }, [navigate, personalAssistantBootstrap, personalAssistantChannel]);

  const navigateToAgent = useCallback((agentId: string) => {
    const agent = agentById.get(agentId);
    if (agent?.agentKind === 'personal_assistant') {
      void openPersonalAssistant();
      return;
    }
    setSelectedAgentId(agentId);
  }, [agentById, openPersonalAssistant]);

  useEffect(() => {
    setSelectedAgentId(null);
  }, [currentChannelId]);

  // Close the mobile nav drawer whenever the route changes (navigating from
  // inside the drawer should dismiss it).
  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (scopedAgents.length === 0 || !currentChannelId) {
      setSelectedAgentId(null);
      return;
    }

    if (selectedAgentId && !scopedAgents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(null);
    }
  }, [currentChannelId, scopedAgents, selectedAgentId]);

  return {
    activeDmChannelId: activeDmChannel?.id,
    channelsCollapsed,
    closeAgentDrawer,
    closeCreateChannel,
    closeCreateProject,
    closeRenameProject,
    createChannelTarget,
    createProjectOpen,
    currentChannelId,
    currentProjectId,
    defaultProjectChannels,
    defaultProjectTeamId,
    dmCollapsed,
    isAdminRoute,
    isAgentsRoute,
    isFeedbackRoute,
    isKnowledgeRoute,
    isProductPageRoute,
    isProjectsRoute,
    isOwner,
    isAdmin,
    isSuperAdmin,
    logoutAndRedirect,
    me,
    mobileDrawerOpen,
    openMobileDrawer,
    closeMobileDrawer,
    navigateToAgent,
    navigateToChannel,
    navigateToDm,
    navigateToAgentDesigner,
    navigateToNewConversation,
    navigateToProject,
    navigateToSettings,
    openCreateChannel,
    openCreateProject,
    openPersonalAssistant,
    openRenameProject,
    pathname: location.pathname,
    personalAssistantAgent,
    personalAssistantBootstrapping: personalAssistantBootstrap.isPending,
    personalAssistantChannelId: personalAssistantChannel?.id,
    personalAssistantUnreadCount: personalAssistantChannel?.unreadCount ?? 0,
    projectsCollapsed,
    realtime,
    renameProjectTarget,
    scopedAgents,
    selectAgent,
    selectedAgent,
    selectedAgentId,
    sessionState,
    setSidebarMenu,
    sidebarMenu,
    sidebarAgentDms,
    sidebarGroupDms,
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
    toggleStar,
    toggleStarredCollapsed,
    unreadCountByChannelId,
    visibleSidebarProjects,
    visibleStarredEntries,
  };
};
