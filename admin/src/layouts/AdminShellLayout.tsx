import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AgentActivityPanel } from '../components/features/agents/AgentActivityPanel';
import { AgentDetailDrawer } from '../components/features/agents/AgentDetailDrawer';
import { PresenceDot } from '../components/primitives/PresenceDot';
import { CreateChannelDialog } from '../components/shared/CreateChannelDialog';
import { useAgentRealtime, useAgents } from '../facades/agents/hooks';
import { useChannels } from '../facades/channels/hooks';
import { useUsers } from '../facades/users/hooks';
import type { AgentRecord } from '../lib/api-client';
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
  'w-[14px] flex-shrink-0 text-center text-base font-bold leading-none text-[color:var(--tx3)]';

const unreadCountClassName =
  'ml-auto flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ' +
  'bg-[color:var(--accent)] text-[10px] font-bold text-white';

const getDmStyle = (index: number) => ({
  background: dmGradients[index % dmGradients.length],
});

export type AdminShellOutletContext = {
  onCreateChannel: () => void;
  onSelectAgent: (agentId: string) => void;
  scopedAgents: AgentRecord[];
};

export const AdminShellLayout = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout, me, sessionState } = useAuthSession();
  const { data: channels = [] } = useChannels();
  const { data: agents = [] } = useAgents();
  const isOwner = me?.user.roleIds.includes('owner') ?? false;
  const { data: users = [] } = useUsers(isOwner);
  const currentChannelId = parseChannelIdFromPath(location.pathname);
  const realtime = useAgentRealtime({
    channelId: currentChannelId,
    threadId: currentChannelId
      ? channels.find((channel) => channel.id === currentChannelId)?.defaultThreadId
      : undefined,
  });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);

  const openCreateChannel = useCallback(() => setCreateChannelOpen(true), []);
  const closeCreateChannel = useCallback(() => setCreateChannelOpen(false), []);

  const scopedAgents = useMemo(
    () =>
      currentChannelId
        ? agents.filter((agent) => agent.channelIds.includes(currentChannelId))
        : agents,
    [agents, currentChannelId],
  );

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

  const sidebarPeople = useMemo(() => {
    if (!me) {
      return [];
    }

    if (users.length > 0) {
      return users.slice(0, 4).map((user, index) => ({
        id: user.id,
        label: user.displayName,
        style: getDmStyle(index),
      }));
    }

    return [
      {
        id: me.user.id,
        label: me.user.displayName,
        style: getDmStyle(0),
      },
    ];
  }, [me, users]);

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

          <button
            className="admin-rail-btn"
            onClick={() => void navigate('/settings#agents')}
            type="button"
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
          </button>

          <button
            className="admin-rail-btn"
            onClick={() => void navigate('/settings#activity')}
            type="button"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="admin-rail-btn-label">Activity</span>
          </button>

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
            <div className="admin-sec-hdr">
              <svg
                className="h-3 w-3 text-[color:var(--tx3)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
              >
                <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Channels
            </div>

            {channels.map((channel) => (
              <button
                key={channel.id}
                className={`admin-sb-item ${channel.id === currentChannelId ? 'active' : ''}`}
                onClick={() => void navigate(`/channels/${channel.id}`)}
                type="button"
              >
                <span className={channelHashClassName}>#</span>
                <span className="truncate">{channel.label}</span>
                {channel.id === currentChannelId ? (
                  <span className={unreadCountClassName}>{scopedAgents.length}</span>
                ) : null}
              </button>
            ))}

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

            <AgentActivityPanel
              agents={scopedAgents}
              onSelectAgent={selectAgent}
              realtime={realtime}
              selectedAgentId={selectedAgentId}
            />

            <div className="admin-sec-hdr mt-2">
              <svg
                className="h-3 w-3 text-[color:var(--tx3)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
              >
                <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Direct messages
            </div>

            {sidebarPeople.map((person) => (
              <button
                key={person.id}
                className="admin-sb-item"
                onClick={() => void navigate('/settings#users')}
                type="button"
              >
                <div className="h-4 w-4 flex-shrink-0 rounded" style={person.style} />
                <span className="truncate text-sm">{person.label}</span>
              </button>
            ))}

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
          </div>
        </aside>

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
