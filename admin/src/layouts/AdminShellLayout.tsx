import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AgentActivityPanel } from '../components/features/agents/AgentActivityPanel';
import { AgentDetailDrawer } from '../components/features/agents/AgentDetailDrawer';
import { PresenceDot } from '../components/primitives/PresenceDot';
import { CreateChannelDialog } from '../components/shared/CreateChannelDialog';
import { useAgentRealtime, useAgents } from '../facades/agents/hooks';
import { useChannels, useOpenDm } from '../facades/channels/hooks';
import { useUsers } from '../facades/users/hooks';
import type { AgentRecord } from '../lib/api-client';
import { getCookie, setCookie } from '../lib/storage';
import { useAuthSession } from '../providers/AuthSessionProvider';

const parseChannelIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels(?:\/([^/]+))?$/);
  return match?.[1];
};

const dmGradients = [
  'linear-gradient(135deg,#6d28d9,#4f46e5)',
  'linear-gradient(135deg,#1d4ed8,#0284c7)',
  'linear-gradient(135deg,#047857,#065f46)',
  'linear-gradient(135deg,#9333ea,#7c3aed)',
] as const;

const railUserButtonClassName = [
  'relative mb-1 flex h-8 w-8 items-center justify-center rounded-full',
  'text-[11px] font-bold text-white',
].join(' ');

const statusIndicatorClassName =
  'absolute bottom-0 right-0 rounded-full border-2 border-[color:var(--rail)] bg-green-500 p-[3px]';

const channelHashClassName =
  'w-[14px] flex-shrink-0 text-center text-base leading-none text-[color:var(--tx3)]';

const unreadCountClassName =
  'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ' +
  'bg-[color:var(--accent)] text-[10px] font-bold text-white';

const getDmStyle = (index: number) => ({
  background: dmGradients[index % dmGradients.length],
});

const renderUnreadCount = (count: number) =>
  count > 0 ? <span className={unreadCountClassName}>{count}</span> : null;

export type AdminShellOutletContext = {
  onCreateChannel: () => void;
  onSelectAgent: (agentId: string) => void;
  scopedAgents: AgentRecord[];
};

export const AdminShellLayout = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout, me, sessionState, token } = useAuthSession();
  const { data: channels = [] } = useChannels();
  const { data: agents = [] } = useAgents();
  const isOwner = me?.user.roleIds.includes('owner') ?? false;
  const { data: users = [] } = useUsers(isOwner);
  const isAgentsRoute = location.pathname.startsWith('/agents');
  const currentChannelId = parseChannelIdFromPath(location.pathname);
  const realtime = useAgentRealtime({
    channelId: currentChannelId,
    threadId: currentChannelId
      ? channels.find((channel) => channel.id === currentChannelId)?.defaultThreadId
      : undefined,
  });
  const openDm = useOpenDm();
  const activeDmChannel = currentChannelId
    ? channels.find((c) => c.id === currentChannelId && c.type === 'dm')
    : undefined;
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [channelsCollapsed, setChannelsCollapsed] = useState(
    () => getCookie('channelsCollapsed') === '1',
  );
  const [starredCollapsed, setStarredCollapsed] = useState(
    () => getCookie('starredCollapsed') === '1',
  );
  const [dmCollapsed, setDmCollapsed] = useState(() => getCookie('dmCollapsed') === '1');
  const [starred, setStarred] = useState<Array<{ type: 'channel' | 'user'; id: string }>>(
    () => me?.user.preferences?.starred ?? [],
  );
  const unreadCountByChannelId = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel.unreadCount])),
    [channels],
  );

  const openCreateChannel = useCallback(() => setCreateChannelOpen(true), []);
  const closeCreateChannel = useCallback(() => setCreateChannelOpen(false), []);

  const toggleChannelsCollapsed = useCallback(() => {
    setChannelsCollapsed((prev) => {
      const next = !prev;
      setCookie('channelsCollapsed', next ? '1' : '0');
      return next;
    });
  }, []);

  const toggleStarredCollapsed = useCallback(() => {
    setStarredCollapsed((prev) => {
      const next = !prev;
      setCookie('starredCollapsed', next ? '1' : '0');
      return next;
    });
  }, []);

  const toggleDmCollapsed = useCallback(() => {
    setDmCollapsed((prev) => {
      const next = !prev;
      setCookie('dmCollapsed', next ? '1' : '0');
      return next;
    });
  }, []);

  useEffect(() => {
    setStarred(me?.user.preferences?.starred ?? []);
  }, [me?.user.preferences?.starred]);

  const toggleStar = useCallback((type: 'channel' | 'user', id: string) => {
    setStarred((prev) => {
      const exists = prev.some((s) => s.type === type && s.id === id);
      const next = exists
        ? prev.filter((s) => !(s.type === type && s.id === id))
        : [...prev, { type, id }];
      if (token) {
        const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
        void fetch(`${baseUrl}/api/auth/me/preferences`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ starred: next }),
        });
      }
      return next;
    });
  }, [token]);

  const scopedAgents = agents;

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const selectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
  };

  const closeAgentDrawer = () => {
    setSelectedAgentId(null);
  };

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

  const sidebarPeople = useMemo(() => {
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

  return (
    <>
      <div className="admin-shell">
        <aside
          className={[
            'flex h-full w-[65px] flex-col items-center overflow-hidden',
            'bg-[color:var(--rail)] px-2 py-2',
          ].join(' ')}
        >
          <Link
            className="mb-4 flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl"
            style={{ background: 'linear-gradient(135deg,#5b21b6,#7c3aed)' }}
            to="/channels"
          >
            <svg
              fill="none"
              height="22"
              stroke="white"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="22"
            >
              <path
                d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"
                fill="rgba(255,255,255,0.15)"
              />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" x2="9.01" y1="9" y2="9" />
              <line x1="15" x2="15.01" y1="9" y2="9" />
            </svg>
          </Link>

          <Link
            className={`admin-rail-btn ${location.pathname.startsWith('/channels') ? 'active' : ''}`}
            to="/channels"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <path
                d={[
                  'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8',
                  'a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72',
                  'C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
                ].join(' ')}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="admin-rail-btn-label">Channels</span>
          </Link>

          <Link
            className={`admin-rail-btn ${isAgentsRoute ? 'active' : ''}`}
            to="/agents"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="8" r="4" />
              <path
                d="M4 20c0-4 3.582-7 8-7s8 3 8 7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="19" cy="13" r="2.5" style={{ stroke: '#a78bfa' }} />
            </svg>
            <span className="admin-rail-btn-label">Agents</span>
          </Link>

          <div className="my-2 h-px w-8 bg-white/15" />

          <Link
            className={`admin-rail-btn ${location.pathname.startsWith('/settings') ? 'active' : ''}`}
            to="/settings"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <path
                d={[
                  'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0',
                  'a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37',
                  'a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35',
                  'a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37',
                  'a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0',
                  'a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37',
                  'a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35',
                  'a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37',
                  ' .996.608 2.296.07 2.572-1.065z',
                ].join(' ')}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="admin-rail-btn-label">Admin</span>
          </Link>

          {isOwner && (
            <>
              <Link
                className={`admin-rail-btn ${location.pathname === '/approvals' ? 'active' : ''}`}
                to="/approvals"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="admin-rail-btn-label">Approvals</span>
              </Link>

              <Link
                className={`admin-rail-btn ${location.pathname === '/audit' ? 'active' : ''}`}
                to="/audit"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                >
                  <path
                    d={[
                      'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2',
                      '0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2',
                      'a2 2 0 012 2',
                    ].join(' ')}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="admin-rail-btn-label">Audit</span>
              </Link>

              <Link
                className={[
                  'admin-rail-btn',
                  location.pathname === '/tokens' ? 'active' : '',
                ].join(' ')}
                to="/tokens"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                >
                  <path
                    d={[
                      'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343',
                      '2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1',
                      'c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
                    ].join(' ')}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="admin-rail-btn-label">Tokens</span>
              </Link>

              <Link
                className={[
                  'admin-rail-btn',
                  location.pathname === '/policy' ? 'active' : '',
                ].join(' ')}
                to="/policy"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                >
                  <path
                    d={[
                      'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112',
                      '2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0',
                      '5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042',
                      '-.133-2.052-.382-3.016z',
                    ].join(' ')}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="admin-rail-btn-label">Policy</span>
              </Link>
            </>
          )}

          <div className="flex-1" />

          <button
            className={railUserButtonClassName}
            onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
            style={{ background: '#7c3aed' }}
            type="button"
          >
            <span>{me.user.displayName.slice(0, 2).toUpperCase()}</span>
            <span className={statusIndicatorClassName}>
              <PresenceDot active />
            </span>
          </button>
        </aside>

        {isAgentsRoute && (
          <aside
            className={[
              'hidden h-full w-[220px] flex-col overflow-hidden',
              'border-r border-[color:var(--sep)] bg-[color:var(--sb)] md:flex',
            ].join(' ')}
          >
            <div className="flex h-[50px] items-center px-4">
              <span className="text-[15px] font-bold text-white">Agents</span>
            </div>
            <nav className="flex flex-1 flex-col gap-0.5 px-2 py-1">
              {[
                {
                  path: '/agents',
                  label: 'Agents',
                  exact: true,
                  icon: (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 20c0-4 3.582-7 8-7s8 3 8 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ),
                },
                {
                  path: '/agents/triggers',
                  label: 'Triggers',
                  icon: (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path d="M12 4v6" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M12 16v4" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M20 12h-4" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M8 12H4" strokeLinecap="round" strokeLinejoin="round" />
                      <circle cx="12" cy="12" r="3.5" />
                    </svg>
                  ),
                },
                {
                  path: '/agents/workflows',
                  label: 'Workflows',
                  icon: (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                      <rect height="4" rx="1" width="6" x="4" y="4" />
                      <rect height="4" rx="1" width="6" x="14" y="10" />
                      <rect height="4" rx="1" width="6" x="4" y="16" />
                      <path d="M10 6h2a2 2 0 012 2v4" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M14 12h-2a2 2 0 00-2 2v4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ),
                },
                {
                  path: '/agents/tools',
                  label: 'Tools',
                  icon: (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path d="M14.7 6.3a4 4 0 105 5l-6.9 6.9a2 2 0 11-2.8-2.8l6.9-6.9a4 4 0 00-2.2-2.2z" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M7 17l-1.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ),
                },
                {
                  path: '/agents/activity',
                  label: 'Activity',
                  icon: (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ),
                },
              ].map((item) => {
                const isActive = item.exact
                  ? location.pathname === item.path
                  : location.pathname.startsWith(item.path);
                return (
                  <Link
                    key={item.path}
                    className={[
                      'admin-sb-item flex items-center gap-2.5 px-3 py-2 text-[13px]',
                      isActive ? 'active' : '',
                    ].join(' ')}
                    to={item.path}
                  >
                    {item.icon}
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </aside>
        )}

        {!isAgentsRoute && (
          <aside
            className={[
              'hidden h-full w-[260px] flex-col overflow-hidden',
              'border-r border-[color:var(--sep)] bg-[color:var(--sb)] md:flex',
            ].join(' ')}
          >
            <div className="flex h-[50px] items-center justify-between px-4">
              <button
                className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-white/10"
                onClick={() => void navigate('/channels')}
                type="button"
              >
                <span className="text-[17px] font-black tracking-[-0.01em] text-white">Nessie</span>
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
                className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-white/10"
                onClick={() => void navigate('/settings')}
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
              {starred.length > 0 && (
                <>
                  <button
                    className="admin-sec-hdr"
                    onClick={toggleStarredCollapsed}
                    type="button"
                  >
                    <svg
                      className={[
                        'h-3 w-3 text-[color:var(--tx3)] transition-transform',
                        starredCollapsed ? '-rotate-90' : '',
                      ].join(' ')}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      viewBox="0 0 24 24"
                    >
                      <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <svg
                      className="h-3.5 w-3.5 flex-shrink-0 text-yellow-400"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                    Starred
                  </button>
                  {!starredCollapsed &&
                    starred.map((item) => {
                      if (item.type === 'channel') {
                        const channel = channels.find((c) => c.id === item.id);
                        if (!channel) return null;
                        return (
                          <button
                            key={`starred-ch-${item.id}`}
                            className={`admin-sb-item group ${channel.id === currentChannelId ? 'active' : ''}`}
                            onClick={() => void navigate(`/channels/${channel.id}`)}
                            type="button"
                          >
                            <span className={channelHashClassName}>#</span>
                            <span className="min-w-0 flex-1 truncate">{channel.label}</span>
                            {renderUnreadCount(channel.unreadCount)}
                            <span
                              className="ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-yellow-400"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleStar('channel', item.id);
                              }}
                            >
                              ★
                            </span>
                          </button>
                        );
                      }
                      const person = sidebarPeople.find((p) => p.id === item.id);
                      if (!person) return null;
                      return (
                        <button
                          key={`starred-usr-${item.id}`}
                          className={`admin-sb-item group ${person.dmChannelId && activeDmChannel?.id === person.dmChannelId ? 'active' : ''}`}
                          onClick={() => navigateToDm(item.id)}
                          type="button"
                        >
                          <div className="h-4 w-4 flex-shrink-0 rounded" style={person.style} />
                          <span className="min-w-0 flex-1 truncate text-sm">{person.label}</span>
                          {renderUnreadCount(
                            person.dmChannelId
                              ? unreadCountByChannelId.get(person.dmChannelId) ?? 0
                              : 0,
                          )}
                          <span
                            className="ml-1 flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none text-yellow-400"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleStar('user', item.id);
                            }}
                          >
                            ★
                          </span>
                        </button>
                      );
                    })}
                </>
              )}

              <button
                className="admin-sec-hdr"
                onClick={toggleChannelsCollapsed}
                type="button"
              >
                <svg
                  className={[
                    'h-3 w-3 text-[color:var(--tx3)] transition-transform',
                    channelsCollapsed ? '-rotate-90' : '',
                  ].join(' ')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  viewBox="0 0 24 24"
                >
                  <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Channels
              </button>

              {!channelsCollapsed && (
                <>
                  {channels.filter((c) => c.type !== 'dm').map((channel) => {
                    const isStarredChannel = starred.some(
                      (s) => s.type === 'channel' && s.id === channel.id,
                    );
                    return (
                      <button
                        key={channel.id}
                        className={`admin-sb-item group ${channel.id === currentChannelId ? 'active' : ''}`}
                        onClick={() => void navigate(`/channels/${channel.id}`)}
                        type="button"
                      >
                        <span className={channelHashClassName}>#</span>
                        <span className="min-w-0 flex-1 truncate">{channel.label}</span>
                        {renderUnreadCount(channel.unreadCount)}
                        <span
                          className={[
                            'flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
                            isStarredChannel
                              ? 'ml-1 text-yellow-400 opacity-100'
                              : 'ml-auto text-[color:var(--tx3)] opacity-0 group-hover:opacity-100',
                          ].join(' ')}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleStar('channel', channel.id);
                          }}
                        >
                          {isStarredChannel ? '★' : '☆'}
                        </span>
                      </button>
                    );
                  })}

                  <button
                    className="admin-sb-item text-[color:var(--tx3)]"
                    onClick={openCreateChannel}
                    type="button"
                  >
                    <svg
                      className="h-4 w-4 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <path d="M12 4v16m8-8H4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Create channel
                  </button>
                </>
              )}

              <button
                className="admin-sec-hdr mt-2"
                onClick={toggleDmCollapsed}
                type="button"
              >
                <svg
                  className={[
                    'h-3 w-3 text-[color:var(--tx3)] transition-transform',
                    dmCollapsed ? '-rotate-90' : '',
                  ].join(' ')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  viewBox="0 0 24 24"
                >
                  <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Direct messages
              </button>

              {!dmCollapsed && (
                <>
                  {sidebarPeople.map((person) => {
                    const isStarredUser = starred.some(
                      (s) => s.type === 'user' && s.id === person.id,
                    );
                    const unreadCount = person.dmChannelId
                      ? unreadCountByChannelId.get(person.dmChannelId) ?? 0
                      : 0;
                    return (
                      <button
                        key={person.id}
                        className={`admin-sb-item group ${person.dmChannelId && activeDmChannel?.id === person.dmChannelId ? 'active' : ''}`}
                        onClick={() => navigateToDm(person.id)}
                        type="button"
                      >
                        <div className="h-4 w-4 flex-shrink-0 rounded" style={person.style} />
                        <span className="min-w-0 flex-1 truncate text-sm">{person.label}</span>
                        {renderUnreadCount(unreadCount)}
                        <span
                          className={[
                            'flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
                            isStarredUser
                              ? 'ml-1 text-yellow-400 opacity-100'
                              : 'ml-auto text-[color:var(--tx3)] opacity-0 group-hover:opacity-100',
                          ].join(' ')}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleStar('user', person.id);
                          }}
                        >
                          {isStarredUser ? '★' : '☆'}
                        </span>
                      </button>
                    );
                  })}

                  <button
                    className="admin-sb-item text-[color:var(--tx3)]"
                    onClick={() => void navigate('/settings#users')}
                    type="button"
                  >
                    <svg
                      className="h-4 w-4 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <path d="M12 4v16m8-8H4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {isOwner ? 'Invite people' : 'Workspace profile'}
                  </button>
                </>
              )}

              <AgentActivityPanel
                agents={scopedAgents}
                currentChannelId={currentChannelId}
                onSelectAgent={selectAgent}
                realtime={realtime}
                selectedAgentId={selectedAgentId}
              />
            </div>
          </aside>
        )}

        <main className="min-w-0 flex-1 overflow-hidden bg-[color:var(--main)]">
          <Outlet context={{ onCreateChannel: openCreateChannel, onSelectAgent: selectAgent, scopedAgents }} />
        </main>
      </div>

      <CreateChannelDialog onClose={closeCreateChannel} open={createChannelOpen} />

      <AgentDetailDrawer
        agent={selectedAgent}
        onClose={closeAgentDrawer}
        onSelectAgent={selectAgent}
      />
    </>
  );
};
