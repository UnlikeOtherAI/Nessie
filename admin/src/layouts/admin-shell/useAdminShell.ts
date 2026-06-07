import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAgentRealtime, useAgents } from '../../facades/agents/hooks';
import { useChannels, useOpenDm } from '../../facades/channels/hooks';
import {
  isPersonalAssistantChannel,
  usePersonalAssistantBootstrap,
} from '../../facades/personal-assistant/hooks';
import { useProjects, useTeams } from '../../facades/projects/hooks';
import { useUsers } from '../../facades/users/hooks';
import type { ChannelRecord } from '../../lib/api-client';
import { getDmStyle } from '../../lib/avatar';
import { useAuthSession } from '../../providers/AuthSessionProvider';
import { useSidebarTree } from './useSidebarTree';
import { useStarredItems } from './useStarredItems';
import {
  DEFAULT_BOOTSTRAP_PROJECT_ID,
  type CreateChannelTarget,
  type RenameProjectTarget,
  type SidebarMenu,
  type SidebarPerson,
  type SidebarProject,
  type StarredItem,
  type VisibleStarredEntry,
} from './types';

// Route prefixes that make up the admin area. When the active route matches
// any of these, the shell swaps the channels/DMs second column for the admin
// sub-pages menu (AdminSidebarNav).
const ADMIN_ROUTE_PREFIXES = [
  '/settings',
  '/approvals',
  '/audit',
  '/tokens',
  '/policy',
  '/ops',
];

const parseChannelIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels(?:\/([^/]+))?$/);
  return match?.[1];
};

/**
 * Owns the admin shell's layout-local state, derived sidebar data, realtime
 * wiring, and navigation handlers. Composes useStarredItems and useSidebarTree.
 */
export const useAdminShell = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout, me, sessionState, token } = useAuthSession();
  const { data: channels = [] } = useChannels();
  const { data: projects = [] } = useProjects();
  const { data: teams = [] } = useTeams();
  const { data: agents = [] } = useAgents();
  const isOwner = me?.user.roleIds.includes('owner') ?? false;
  const isSuperAdmin = me?.user.superAdmin ?? false;
  const { data: users = [] } = useUsers(isOwner);
  const isAgentsRoute = location.pathname.startsWith('/agents');
  const isAdminRoute = ADMIN_ROUTE_PREFIXES.some(
    (prefix) => location.pathname === prefix || location.pathname.startsWith(`${prefix}/`),
  );
  const currentChannelId = parseChannelIdFromPath(location.pathname);
  const personalAssistantChannel = useMemo(
    () => channels.find(isPersonalAssistantChannel) ?? null,
    [channels],
  );
  const realtime = useAgentRealtime({
    channelId: currentChannelId,
    channelIds: personalAssistantChannel ? [personalAssistantChannel.id] : [],
    threadId: currentChannelId
      ? channels.find((channel) => channel.id === currentChannelId)?.defaultThreadId
      : undefined,
  });
  const openDm = useOpenDm();
  const activeDmChannel = currentChannelId
      ? channels.find((c) => c.id === currentChannelId && c.type === 'dm')
    : undefined;
  const personalAssistantBootstrap = usePersonalAssistantBootstrap();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [createChannelTarget, setCreateChannelTarget] = useState<CreateChannelTarget | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [renameProjectTarget, setRenameProjectTarget] = useState<RenameProjectTarget | null>(null);
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenu>(null);
  const initialStarred = useMemo<StarredItem[]>(
    () => me?.user.preferences?.starred ?? [],
    [me?.user.preferences?.starred],
  );
  const {
    channelsCollapsed,
    dmCollapsed,
    projectsCollapsed,
    starred,
    starredChannelIds,
    starredCollapsed,
    starredProjectIds,
    starredUserIds,
    toggleChannelsCollapsed,
    toggleDmCollapsed,
    toggleProjectsCollapsed,
    toggleStar,
    toggleStarredCollapsed,
  } = useStarredItems({ initialStarred, token });

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
    () => standardChannels.find((channel) => channel.id === currentChannelId)?.projectId,
    [currentChannelId, standardChannels],
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

  const navigateToProject = useCallback((projectId: string) => {
    const firstChannel = standardChannels.find((channel) => channel.projectId === projectId);
    void navigate(firstChannel ? `/channels/${firstChannel.id}` : '/channels');
  }, [navigate, standardChannels]);

  const scopedAgents = agents;

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const selectAgent = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
  }, []);

  const closeAgentDrawer = useCallback(() => {
    setSelectedAgentId(null);
  }, []);

  const navigateToDm = useCallback((userId: string) => {
    const targetUser = users.find((u) => u.id === userId);
    if (targetUser) {
      const dmChannel = channels.find(
        (c) => c.type === 'dm' && targetUser.channelIds.includes(c.id),
      );
      if (dmChannel) {
        void navigate(`/channels/${dmChannel.id}`);
        return;
      }
    }
    openDm.mutate(userId, {
      onSuccess: (channel) => {
        void navigate(`/channels/${channel.id}`);
      },
    });
  }, [channels, navigate, openDm, users]);

  const navigateToChannel = useCallback((channelId: string) => {
    void navigate(`/channels/${channelId}`);
  }, [navigate]);

  const navigateHome = useCallback(() => {
    void navigate('/channels');
  }, [navigate]);

  const navigateToSettings = useCallback((subPage?: string) => {
    void navigate(subPage ? `/settings/${subPage}` : '/settings');
  }, [navigate]);

  const logoutAndRedirect = useCallback(() => {
    void logout().then(() => navigate('/login', { replace: true }));
  }, [logout, navigate]);

  const sidebarPeople = useMemo<SidebarPerson[]>(() => {
    if (!me) {
      return [];
    }

    const otherUsers = users.filter((u) => u.id !== me.user.id);

    if (otherUsers.length > 0) {
      return otherUsers.slice(0, 4).map((user, index) => ({
        id: user.id,
        label: user.displayName,
        style: getDmStyle(index),
        dmChannelId: channels.find((c) => c.type === 'dm' && user.channelIds.includes(c.id))?.id,
      }));
    }

    return [
      {
        id: me.user.id,
        label: me.user.displayName,
        style: getDmStyle(0),
        dmChannelId: undefined,
      },
    ];
  }, [me, users, channels]);

  const visibleStarredEntries = useMemo<VisibleStarredEntry[]>(() => {
    const entries: VisibleStarredEntry[] = [];
    const projectEntryById = new Map<string, Extract<VisibleStarredEntry, { type: 'project' }>>();

    const addProjectEntry = (
      project: SidebarProject,
      channelsToShow: ChannelRecord[],
      starredProject: boolean,
    ) => {
      const existing = projectEntryById.get(project.id);
      if (existing) {
        if (starredProject) {
          existing.channels = channelsToShow;
          existing.starred = true;
          return;
        }

        const existingChannelIds = new Set(existing.channels.map((channel) => channel.id));
        existing.channels = [
          ...existing.channels,
          ...channelsToShow.filter((channel) => !existingChannelIds.has(channel.id)),
        ];
        return;
      }

      const entry: Extract<VisibleStarredEntry, { type: 'project' }> = {
        channels: channelsToShow,
        project,
        starred: starredProject,
        type: 'project',
      };
      projectEntryById.set(project.id, entry);
      entries.push(entry);
    };

    for (const item of starred) {
      if (item.type === 'project') {
        if (item.id === DEFAULT_BOOTSTRAP_PROJECT_ID) continue;
        const project = projectById.get(item.id);
        if (project) {
          addProjectEntry(project, project.channels, true);
        }
        continue;
      }

      if (item.type === 'channel') {
        const channel = channelById.get(item.id);
        if (!channel) continue;

        if (channel.projectId === DEFAULT_BOOTSTRAP_PROJECT_ID) {
          entries.push({ channel, type: 'channel' });
          continue;
        }

        if (starredProjectIds.has(channel.projectId)) continue;

        const project = projectById.get(channel.projectId);
        if (project) {
          addProjectEntry(project, [channel], false);
        }
        continue;
      }

      const person = sidebarPeople.find((candidate) => candidate.id === item.id);
      if (person) {
        entries.push({ person, type: 'user' });
      }
    }

    return entries;
  }, [channelById, projectById, sidebarPeople, starred, starredProjectIds]);

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

  useEffect(() => {
    setSelectedAgentId(null);
  }, [currentChannelId]);

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
    isOwner,
    isSuperAdmin,
    logoutAndRedirect,
    me,
    navigateHome,
    navigateToChannel,
    navigateToDm,
    navigateToProject,
    navigateToSettings,
    openCreateChannel,
    openCreateProject,
    openPersonalAssistant,
    openRenameProject,
    pathname: location.pathname,
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
    sidebarPeople,
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
