import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AgentActivityPanel } from '../components/features/agents/AgentActivityPanel'
import { AgentDetailDrawer } from '../components/features/agents/AgentDetailDrawer'
import { AppShell } from '../components/shared/AppShell'
import { Avatar } from '../components/primitives/Avatar'
import { ChannelRow } from '../components/shared/ChannelRow'
import { PresenceDot } from '../components/primitives/PresenceDot'
import { RailButton } from '../components/shared/RailButton'
import { SidebarSection } from '../components/shared/SidebarSection'
import { useAgentRealtime, useAgents } from '../facades/agents/hooks'
import { useChannels } from '../facades/channels/hooks'
import { useTools } from '../facades/tools/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

const parseChannelIdFromPath = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/channels(?:\/([^/]+))?$/)
  return match?.[1]
}

const railBrandLinkClass = [
  'mb-4 flex items-center justify-center rounded-[1.5rem]',
  'bg-[color:var(--accent)]/12 px-3 py-4 text-sm font-semibold',
  'text-[color:var(--accent)]',
].join(' ')

const railActionPath =
  'M12 6V4m0 16v-2m6-6h2M4 12H2m14.95 4.95 1.41 1.41' +
  'M5.64 5.64 4.22 4.22m12.73-0.01-1.41 1.42M5.64 18.36l-1.42 1.42'

const signOutButtonClass = [
  'mt-3 w-full rounded-2xl border border-[color:var(--line)]',
  'bg-white px-3 py-2 text-sm font-medium',
].join(' ')

export const AdminShellLayout = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { logout, me, sessionState } = useAuthSession()
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
  const { data: tools = [] } = useTools()
  const currentChannelId = parseChannelIdFromPath(location.pathname)
  const realtime = useAgentRealtime({
    channelId: currentChannelId,
    threadId: currentChannelId
      ? channels.find((channel) => channel.id === currentChannelId)?.defaultThreadId
      : undefined,
  })
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)

  const scopedAgents = useMemo(
    () =>
      currentChannelId
        ? agents.filter((agent) => agent.channelIds.includes(currentChannelId))
        : agents,
    [agents, currentChannelId],
  )

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  )

  useEffect(() => {
    if (scopedAgents.length === 0) {
      setSelectedAgentId(null)
      return
    }

    if (!selectedAgentId || !scopedAgents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(scopedAgents[0]?.id ?? null)
    }
  }, [scopedAgents, selectedAgentId])

  if (sessionState === 'bootstrap') {
    return <Navigate to="/bootstrap" replace />
  }

  if (sessionState === 'loading') {
    return (
      <main className="min-h-screen px-6 py-10">
        <div className="mx-auto max-w-5xl glass-panel rounded-[2rem] p-8">Loading workspace...</div>
      </main>
    )
  }

  if (sessionState !== 'authenticated' || !me) {
    return <Navigate to="/login" replace />
  }

  return (
    <>
      <AppShell
        activity={
          <AgentActivityPanel
            agents={scopedAgents}
            onSelectAgent={setSelectedAgentId}
            realtime={realtime}
            selectedAgentId={selectedAgentId}
          />
        }
        rail={
          <>
            <Link
              className={railBrandLinkClass}
              to="/channels"
            >
              Nessie
            </Link>
            <RailButton
              icon={
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path d="M8 12h8M8 8h8M8 16h5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M4 5h16v14H4z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              }
              label="Channels"
              to="/channels"
            />
            <RailButton
              icon={
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path d={railActionPath} strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx="12" cy="12" r="4" />
                </svg>
              }
              label="Settings"
              to="/settings"
            />
            <div className="mt-auto rounded-[1.5rem] border border-[color:var(--line)] bg-white/70 p-3">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Avatar label={me.user.displayName} size="sm" />
                  <span className="absolute -bottom-1 -right-1 rounded-full border border-white bg-white p-[2px]">
                    <PresenceDot active />
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{me.user.displayName}</div>
                  <div className="truncate text-xs text-[color:var(--muted)]">{me.user.email}</div>
                </div>
              </div>
              <button
                className={signOutButtonClass}
                onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
                type="button"
              >
                Sign out
              </button>
            </div>
          </>
        }
      >
        <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="grid gap-4">
            <SidebarSection title="Channels">
              {channels.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  active={channel.id === currentChannelId}
                  channel={channel}
                  onClick={() => void navigate(`/channels/${channel.id}`)}
                />
              ))}
            </SidebarSection>
            <SidebarSection title="Workspace">
              <div className="rounded-[1.35rem] border border-[color:var(--line)] bg-white/75 p-4 text-sm leading-6">
                <div className="font-medium">{me.context.organizationId}</div>
                <div className="mt-2 text-[color:var(--muted)]">
                  {scopedAgents.length} agents and {tools.length} tools in this workspace.
                </div>
              </div>
            </SidebarSection>
          </aside>
          <div className="min-w-0">
            <Outlet />
          </div>
        </div>
      </AppShell>

      <AgentDetailDrawer
        agent={selectedAgent}
        onClose={() => setSelectedAgentId(null)}
        onSelectAgent={setSelectedAgentId}
      />
    </>
  )
}
