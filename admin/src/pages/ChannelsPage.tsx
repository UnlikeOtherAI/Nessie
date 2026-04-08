import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChannelRow } from '../components/shared/ChannelRow'
import { Composer } from '../components/shared/Composer'
import { MessageBubble } from '../components/shared/MessageBubble'
import { PageHeader } from '../components/shared/PageHeader'
import { RailButton } from '../components/shared/RailButton'
import { SidebarSection } from '../components/shared/SidebarSection'
import { StatusPill } from '../components/shared/StatusPill'
import { ToolRow } from '../components/shared/ToolRow'
import { UnreadBadge } from '../components/shared/UnreadBadge'
import {
  useAgents,
  useBindAgent,
  useCreateAgent,
} from '../facades/agents/hooks'
import { useChannels, useCreateChannel } from '../facades/channels/hooks'
import { useSendMessage } from '../facades/messages/hooks'
import { useThreadMessages, useThreadStream } from '../facades/threads/hooks'
import { useTools } from '../facades/tools/hooks'
import { useCreateUser, useUsers } from '../facades/users/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

const fieldClass = [
  'w-full rounded-2xl border border-[color:var(--line)]',
  'bg-white/80 px-4 py-3 text-sm text-[color:var(--ink)]',
  'outline-none transition focus:border-[color:var(--accent)]',
  'focus:ring-2 focus:ring-[color:var(--accent-soft)]',
].join(' ')

const primaryButtonClass = [
  'rounded-2xl bg-[color:var(--accent)] px-4 py-3 text-sm',
  'font-medium text-white transition hover:opacity-90',
].join(' ')

const cardClass = 'glass-panel rounded-[2rem] p-5'

export const ChannelsPage = () => {
  const navigate = useNavigate()
  const { channelId } = useParams()
  const { me } = useAuthSession()
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
  const { data: tools = [] } = useTools()

  const activeChannel = channels.find((channel) => channel.id === channelId) ?? channels[0] ?? null
  const { data: threadMessages = [] } = useThreadMessages(activeChannel?.defaultThreadId)
  const { pendingMessages } = useThreadStream(activeChannel?.defaultThreadId)

  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: users = [] } = useUsers(isOwner)

  const createChannel = useCreateChannel()
  const createAgent = useCreateAgent()
  const bindAgent = useBindAgent()
  const createUser = useCreateUser()
  const sendMessage = useSendMessage(activeChannel?.defaultThreadId)

  const [channelLabel, setChannelLabel] = useState('')
  const [channelVisibility, setChannelVisibility] = useState<'public' | 'protected' | 'private'>(
    'public',
  )
  const [agentName, setAgentName] = useState('')
  const [agentRole, setAgentRole] = useState('assistant')
  const [agentPrompt, setAgentPrompt] = useState('')
  const [bindTargetChannelId, setBindTargetChannelId] = useState('')
  const [message, setMessage] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [userDisplayName, setUserDisplayName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [userRole, setUserRole] = useState('member')

  useEffect(() => {
    if (!channelId && activeChannel) {
      void navigate(`/channels/${activeChannel.id}`, { replace: true })
    }
  }, [activeChannel, channelId, navigate])

  useEffect(() => {
    if (!bindTargetChannelId && activeChannel) {
      setBindTargetChannelId(activeChannel.id)
    }
  }, [activeChannel, bindTargetChannelId])

  useEffect(() => {
    const scopedAgents = activeChannel
      ? agents.filter((agent) => agent.channelIds.includes(activeChannel.id))
      : agents
    if (!selectedAgentId && scopedAgents[0]) {
      setSelectedAgentId(scopedAgents[0].id)
    }
  }, [activeChannel, agents, selectedAgentId])

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId)

  const createChannelSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const created = await createChannel.mutateAsync({
      label: channelLabel,
      visibility: channelVisibility,
    })
    setChannelLabel('')
    void navigate(`/channels/${created.id}`)
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
      channelIds: activeChannel ? [activeChannel.id] : undefined,
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

  const sendMessageSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeChannel || !message.trim()) {
      return
    }

    await sendMessage.mutateAsync({ content: message.trim(), agentId: selectedAgent?.id })
    setMessage('')
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
      <aside className={cardClass}>
        <div className="grid gap-4">
          <RailButton
            icon={
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            label="Workspace settings"
            to="/settings"
          />

          <SidebarSection title="Channels">
            <div className="grid gap-2">
              {channels.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  active={channel.id === activeChannel?.id}
                  channel={channel}
                  onClick={() => void navigate(`/channels/${channel.id}`)}
                />
              ))}
            </div>
          </SidebarSection>

          <SidebarSection title="Create channel">
            <form className="grid gap-3" onSubmit={createChannelSubmit}>
              <input
                className={fieldClass}
                onChange={(event) => setChannelLabel(event.target.value)}
                placeholder="Channel label"
                value={channelLabel}
              />
              <select
                className={fieldClass}
                onChange={(event) =>
                  setChannelVisibility(event.target.value as typeof channelVisibility)
                }
                value={channelVisibility}
              >
                <option value="public">Public</option>
                <option value="protected">Protected</option>
                <option value="private">Private</option>
              </select>
              <button className={primaryButtonClass} type="submit">
                Create channel
              </button>
            </form>
          </SidebarSection>

          {isOwner ? (
            <SidebarSection
              action={activeChannel ? <StatusPill>{activeChannel.label}</StatusPill> : undefined}
              title="Users"
            >
              <div className="grid gap-2">
                {users.map((user) => (
                  <div
                    key={user.id}
                    className="rounded-2xl border border-[color:var(--line)] bg-white/70 px-4 py-3"
                  >
                    <div className="font-medium">{user.displayName}</div>
                    <div className="mt-1 text-xs text-[color:var(--muted)]">{user.email}</div>
                  </div>
                ))}
              </div>
            </SidebarSection>
          ) : null}
        </div>
      </aside>

      <section className="grid gap-6">
        <PageHeader
          actions={
            <div className="grid gap-2 text-right text-sm text-[color:var(--muted)]">
              <div>{agents.length} agents</div>
              <div>{tools.length} safe tools</div>
              <div className="flex items-center justify-end gap-2">
                <span>Streaming</span>
                <UnreadBadge count={pendingMessages.length} />
              </div>
            </div>
          }
          eyebrow="Workspace"
          subtitle={
            activeChannel
              ? [
                  `Channel visibility is ${activeChannel.visibility}.`,
                  'Agent activity now lives in the persistent shell while',
                  'thread replies stream over SSE.',
                ].join(' ')
              : 'Create a channel to start the collaboration surface.'
          }
          title={activeChannel ? activeChannel.label : 'No channel selected'}
        />

        <section className={cardClass}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">Thread</h2>
              <div className="mt-1 text-xs uppercase tracking-[0.18em] text-[color:var(--muted)]">
                {activeChannel?.defaultThreadId ?? 'No thread'}
              </div>
            </div>
            {selectedAgent ? <StatusPill>{selectedAgent.name}</StatusPill> : null}
          </div>

          <div className="mt-5 grid gap-3">
            {threadMessages.map((entry) => (
              <MessageBubble
                key={entry.id}
                content={entry.content}
                role={entry.role}
                timestamp={entry.createdAt}
              />
            ))}
            {pendingMessages.map((entry) => (
              <MessageBubble
                key={entry.runId}
                content={entry.content || '...'}
                role="assistant"
                streaming
              />
            ))}
            {threadMessages.length === 0 && pendingMessages.length === 0 ? (
              <div
                className={[
                  'rounded-2xl border border-dashed border-[color:var(--line)]',
                  'bg-white/50 p-6 text-sm text-[color:var(--muted)]',
                ].join(' ')}
              >
                No messages yet. Send one to start the thread.
              </div>
            ) : null}
          </div>

          <div className="mt-6">
            <Composer buttonLabel="Send" onSubmit={sendMessageSubmit}>
              <textarea
                className={`${fieldClass} min-h-28`}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Write a message"
                value={message}
              />
            </Composer>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className={cardClass}>
            <SidebarSection title="Create agent">
              <form className="grid gap-3" onSubmit={createAgentSubmit}>
                <input
                  className={fieldClass}
                  onChange={(event) => setAgentName(event.target.value)}
                  placeholder="Agent name"
                  value={agentName}
                />
                <input
                  className={fieldClass}
                  onChange={(event) => setAgentRole(event.target.value)}
                  placeholder="Role"
                  value={agentRole}
                />
                <textarea
                  className={`${fieldClass} min-h-28`}
                  onChange={(event) => setAgentPrompt(event.target.value)}
                  placeholder="System prompt"
                  value={agentPrompt}
                />
                <button className={primaryButtonClass} type="submit">
                  Create agent
                </button>
              </form>
            </SidebarSection>
          </div>

          <div className={cardClass}>
            <SidebarSection title="Bind agent">
              <form className="grid gap-3" onSubmit={bindAgentSubmit}>
                <select
                  className={fieldClass}
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
                  className={fieldClass}
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
                <button className={primaryButtonClass} type="submit">
                  Bind agent
                </button>
              </form>
            </SidebarSection>
          </div>

          {isOwner ? (
            <div className={cardClass}>
              <SidebarSection title="Add user">
                <form className="grid gap-3" onSubmit={createUserSubmit}>
                  <input
                    className={fieldClass}
                    onChange={(event) => setUserDisplayName(event.target.value)}
                    placeholder="Display name"
                    value={userDisplayName}
                  />
                  <input
                    className={fieldClass}
                    onChange={(event) => setUserEmail(event.target.value)}
                    placeholder="Email"
                    type="email"
                    value={userEmail}
                  />
                  <input
                    className={fieldClass}
                    onChange={(event) => setUserPassword(event.target.value)}
                    placeholder="Temporary password"
                    type="password"
                    value={userPassword}
                  />
                  <select
                    className={fieldClass}
                    onChange={(event) => setUserRole(event.target.value)}
                    value={userRole}
                  >
                    <option value="member">Member</option>
                    <option value="owner">Owner</option>
                  </select>
                  <button className={primaryButtonClass} type="submit">
                    Add user
                  </button>
                </form>
              </SidebarSection>
            </div>
          ) : null}

          <div className={cardClass}>
            <SidebarSection title="Tools">
              <div className="grid gap-3">
                {tools.map((tool) => (
                  <ToolRow key={tool.id} tool={tool} />
                ))}
              </div>
            </SidebarSection>
          </div>
        </section>
      </section>
    </div>
  )
}
