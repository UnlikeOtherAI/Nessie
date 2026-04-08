import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { useAgents, useBindAgent, useCreateAgent } from '../facades/agents/hooks'
import { useChannels } from '../facades/channels/hooks'
import { useTools } from '../facades/tools/hooks'
import { useCreateUser, useUsers } from '../facades/users/hooks'
import type { AdminShellOutletContext } from '../layouts/AdminShellLayout'
import { useAuthSession } from '../providers/AuthSessionProvider'

const sectionTitleClass =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const hoverCardClass = [
  'admin-card p-3 text-left',
  'hover:bg-[color:var(--main-hover)]',
].join(' ')

export const SettingsPage = () => {
  const navigate = useNavigate()
  const { me, logout } = useAuthSession()
  const { onCreateChannel, onSelectAgent } = useOutletContext<AdminShellOutletContext>()
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
  const { data: tools = [] } = useTools()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: users = [] } = useUsers(isOwner)
  const createAgent = useCreateAgent()
  const bindAgent = useBindAgent()
  const createUser = useCreateUser()

  const [agentName, setAgentName] = useState('')
  const [agentRole, setAgentRole] = useState('assistant')
  const [agentPrompt, setAgentPrompt] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [bindTargetChannelId, setBindTargetChannelId] = useState('')
  const [userDisplayName, setUserDisplayName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [userRole, setUserRole] = useState('member')

  useEffect(() => {
    if (!selectedAgentId && agents[0]) {
      setSelectedAgentId(agents[0].id)
    }

    if (!bindTargetChannelId && channels[0]) {
      setBindTargetChannelId(channels[0].id)
    }
  }, [agents, bindTargetChannelId, channels, selectedAgentId])

  const agentBindings = useMemo(
    () =>
      agents.map((agent) => ({
        ...agent,
        channelLabels: channels
          .filter((channel) => agent.channelIds.includes(channel.id))
          .map((channel) => channel.label),
      })),
    [agents, channels],
  )

  if (!me) {
    return null
  }

  const createAgentSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const created = await createAgent.mutateAsync({
      name: agentName,
      role: agentRole,
      systemPrompt: agentPrompt || undefined,
    })
    setAgentName('')
    setAgentRole('assistant')
    setAgentPrompt('')
    setSelectedAgentId(created.id)
  }

  const bindAgentSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedAgentId || !bindTargetChannelId) {
      return
    }

    await bindAgent.mutateAsync({
      agentId: selectedAgentId,
      channelId: bindTargetChannelId,
    })
  }

  const createUserSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await createUser.mutateAsync({
      channelIds: bindTargetChannelId ? [bindTargetChannelId] : undefined,
      displayName: userDisplayName,
      email: userEmail,
      password: userPassword,
      role: userRole,
    })
    setUserDisplayName('')
    setUserEmail('')
    setUserPassword('')
    setUserRole('member')
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header
        className={[
          'flex h-[50px] items-center justify-between',
          'border-b border-[color:var(--sep)] px-5',
        ].join(' ')}
      >
        <div>
          <div className={sectionTitleClass}>Admin</div>
          <h1 className="mt-1 text-[17px] font-bold text-white">
            Workspace controls
          </h1>
        </div>
        <button
          className="admin-button admin-button-secondary"
          onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
          type="button"
        >
          Sign out
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid gap-4 xl:grid-cols-2">
          <section className="admin-card p-4">
            <div className={sectionTitleClass}>Profile</div>
            <div className="mt-4 text-2xl font-semibold text-white">
              {me.user.displayName}
            </div>
            <div className="mt-1 text-sm text-[color:var(--tx2)]">
              {me.user.email}
            </div>
            <div className="mt-4 grid gap-2 text-sm text-[color:var(--tx2)]">
              <div>Organization: {me.context.organizationId}</div>
              <div>Project: {me.context.projectId}</div>
              <div>Team: {me.context.teamId}</div>
              <div>
                Provider: {me.auth.providerId} ({me.auth.providerType})
              </div>
            </div>
          </section>

          <section className="admin-card p-4" id="activity">
            <div className={sectionTitleClass}>Session</div>
            <div className="mt-4 grid gap-3 text-sm text-[color:var(--tx2)]">
              <div className="admin-card p-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  Session ID
                </div>
                <div className="mt-1 break-all font-mono text-xs text-white">
                  {me.session.sessionId}
                </div>
              </div>
              <div className="admin-card p-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  Issued
                </div>
                <div className="mt-1">
                  {new Date(me.session.issuedAt).toLocaleString()}
                </div>
              </div>
              <div className="admin-card p-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  Auto redirect
                </div>
                <div className="mt-1">
                  {me.auth.autoRedirectToSso ? 'Enabled' : 'Disabled'}
                </div>
              </div>
            </div>
          </section>

          <section className="admin-card p-4" id="channels">
            <div className={sectionTitleClass}>Channels</div>
            <div className="mt-4 grid gap-2">
              {channels.map((channel) => (
                <button
                  key={channel.id}
                  className={[
                    'admin-card flex items-center justify-between p-3 text-left',
                    'hover:bg-[color:var(--main-hover)]',
                  ].join(' ')}
                  onClick={() => void navigate(`/channels/${channel.id}`)}
                  type="button"
                >
                  <div>
                    <div className="font-semibold text-white">#{channel.label}</div>
                    <div className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                      {channel.visibility}
                    </div>
                  </div>
                  <div className="text-xs text-[color:var(--tx3)]">{channel.id}</div>
                </button>
              ))}
            </div>

            <button
              className="admin-button admin-button-primary mt-4 justify-self-start"
              onClick={onCreateChannel}
              type="button"
            >
              Create channel
            </button>
          </section>

          <section className="admin-card p-4" id="agents">
            <div className={sectionTitleClass}>Agents</div>
            <div className="mt-4 grid gap-2">
              {agentBindings.map((agent) => (
                <button
                  key={agent.id}
                  className={hoverCardClass}
                  onClick={() => onSelectAgent(agent.id)}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-white">{agent.name}</div>
                      <div className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                        {agent.role}
                      </div>
                    </div>
                    <div className="text-xs text-[color:var(--tx3)]">
                      {agent.status}
                    </div>
                  </div>
                  <div className="mt-2 text-sm text-[color:var(--tx2)]">
                    {agent.channelLabels.join(', ') || 'No channel bindings yet.'}
                  </div>
                </button>
              ))}
            </div>

            <form className="mt-4 grid gap-3" onSubmit={createAgentSubmit}>
              <input
                className="admin-input"
                onChange={(event) => setAgentName(event.target.value)}
                placeholder="Agent name"
                value={agentName}
              />
              <input
                className="admin-input"
                onChange={(event) => setAgentRole(event.target.value)}
                placeholder="Role"
                value={agentRole}
              />
              <textarea
                className="admin-input min-h-28 resize-y"
                onChange={(event) => setAgentPrompt(event.target.value)}
                placeholder="System prompt"
                value={agentPrompt}
              />
              <button
                className="admin-button admin-button-primary justify-self-start"
                type="submit"
              >
                Create agent
              </button>
            </form>

            <form
              className="mt-4 grid gap-3 border-t border-[color:var(--sep)] pt-4"
              onSubmit={bindAgentSubmit}
            >
              <select
                className="admin-input"
                onChange={(event) => setSelectedAgentId(event.target.value)}
                value={selectedAgentId}
              >
                <option value="">Select agent</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <select
                className="admin-input"
                onChange={(event) => setBindTargetChannelId(event.target.value)}
                value={bindTargetChannelId}
              >
                <option value="">Select channel</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.label}
                  </option>
                ))}
              </select>
              <button
                className="admin-button admin-button-secondary justify-self-start"
                type="submit"
              >
                Bind agent
              </button>
            </form>
          </section>

          {isOwner ? (
            <section className="admin-card p-4" id="users">
              <div className={sectionTitleClass}>Users</div>
              <div className="mt-4 grid gap-2">
                {users.map((user) => (
                  <div key={user.id} className="admin-card p-3">
                    <div className="font-semibold text-white">
                      {user.displayName}
                    </div>
                    <div className="mt-1 text-sm text-[color:var(--tx2)]">
                      {user.email}
                    </div>
                    <div className="mt-2 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                      {user.role}
                    </div>
                  </div>
                ))}
              </div>
              <form className="mt-4 grid gap-3" onSubmit={createUserSubmit}>
                <input
                  className="admin-input"
                  onChange={(event) => setUserDisplayName(event.target.value)}
                  placeholder="Display name"
                  value={userDisplayName}
                />
                <input
                  className="admin-input"
                  onChange={(event) => setUserEmail(event.target.value)}
                  placeholder="Email"
                  type="email"
                  value={userEmail}
                />
                <input
                  className="admin-input"
                  onChange={(event) => setUserPassword(event.target.value)}
                  placeholder="Password"
                  type="password"
                  value={userPassword}
                />
                <select
                  className="admin-input"
                  onChange={(event) => setUserRole(event.target.value)}
                  value={userRole}
                >
                  <option value="member">Member</option>
                  <option value="owner">Owner</option>
                </select>
                <button
                  className="admin-button admin-button-primary justify-self-start"
                  type="submit"
                >
                  Add user
                </button>
              </form>
            </section>
          ) : null}

          <section className="admin-card p-4">
            <div className={sectionTitleClass}>Tools</div>
            <div className="mt-4 grid gap-2">
              {tools.map((tool) => (
                <div key={tool.id} className="admin-card p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold text-white">{tool.label}</div>
                    <span
                      className={[
                        'rounded bg-white/6 px-1.5 py-0.5 text-[10px]',
                        'uppercase tracking-[0.16em] text-[color:var(--tx3)]',
                      ].join(' ')}
                    >
                      {tool.safe ? 'safe' : 'restricted'}
                    </span>
                  </div>
                  <div className="mt-2 text-sm text-[color:var(--tx2)]">
                    {tool.description}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  )
}
