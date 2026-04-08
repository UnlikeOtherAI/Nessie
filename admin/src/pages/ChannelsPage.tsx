import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAgents, useBindAgent, useCreateAgent } from '../facades/agents/hooks'
import { useChannels, useCreateChannel } from '../facades/channels/hooks'
import { useSendMessage } from '../facades/messages/hooks'
import { useThreadMessages, useThreadStream } from '../facades/threads/hooks'
import { useTools } from '../facades/tools/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

const fieldClass = [
  'w-full rounded-2xl border border-[color:var(--line)]',
  'bg-white/80 px-4 py-3 text-sm text-[color:var(--ink)]',
  'outline-none transition focus:border-[color:var(--accent)]',
  'focus:ring-2 focus:ring-[color:var(--accent-soft)]',
].join(' ')

const primaryButtonClass = [
  'rounded-2xl bg-[color:var(--accent)] px-4 py-3 text-sm',
  'font-medium text-white',
].join(' ')

const streamCardClass = [
  'rounded-2xl border border-dashed border-[color:var(--accent)]/30',
  'bg-[color:var(--accent-soft)] p-4',
].join(' ')

const emptyStateClass = [
  'rounded-2xl border border-dashed border-[color:var(--line)]',
  'bg-white/50 p-6 text-sm text-[color:var(--muted)]',
].join(' ')

const statusClass = (status: string) => {
  if (status === 'executing') return 'bg-[color:var(--executing)]'
  if (status === 'thinking') return 'bg-[color:var(--thinking)]'
  if (status === 'error') return 'bg-[color:var(--danger)]'
  return 'bg-[color:var(--muted)]'
}

export const ChannelsPage = () => {
  const navigate = useNavigate()
  const { channelId } = useParams()
  const { sessionState } = useAuthSession()
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
  const { data: tools = [] } = useTools()
  const createChannel = useCreateChannel()
  const createAgent = useCreateAgent()
  const bindAgent = useBindAgent()

  const activeChannel =
    channels.find((channel) => channel.id === channelId) ?? channels[0] ?? null

  const { data: threadMessages = [] } = useThreadMessages(activeChannel?.defaultThreadId)
  const { pendingMessages } = useThreadStream(activeChannel?.defaultThreadId)
  const sendMessage = useSendMessage(activeChannel?.defaultThreadId)

  const [channelLabel, setChannelLabel] = useState('')
  const [channelVisibility, setChannelVisibility] = useState<
    'public' | 'protected' | 'private'
  >('public')
  const [agentName, setAgentName] = useState('')
  const [agentRole, setAgentRole] = useState('assistant')
  const [agentPrompt, setAgentPrompt] = useState('')
  const [message, setMessage] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [bindTargetChannelId, setBindTargetChannelId] = useState('')

  useEffect(() => {
    if (sessionState === 'unauthenticated') {
      void navigate('/login', { replace: true })
    }
  }, [navigate, sessionState])

  useEffect(() => {
    if (!channelId && activeChannel) {
      void navigate(`/channels/${activeChannel.id}`, { replace: true })
    }
  }, [activeChannel, channelId, navigate])

  useEffect(() => {
    if (!selectedAgentId && agents[0]) {
      setSelectedAgentId(agents[0].id)
    }
  }, [agents, selectedAgentId])

  useEffect(() => {
    if (!bindTargetChannelId && activeChannel) {
      setBindTargetChannelId(activeChannel.id)
    }
  }, [activeChannel, bindTargetChannelId])

  if (sessionState === 'unauthenticated') {
    return <Navigate to="/login" replace />
  }

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
    await createAgent.mutateAsync({
      name: agentName,
      role: agentRole,
      systemPrompt: agentPrompt || undefined,
    })
    setAgentName('')
    setAgentRole('assistant')
    setAgentPrompt('')
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

  const sendMessageSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeChannel || !message.trim()) {
      return
    }

    await sendMessage.mutateAsync({ content: message.trim() })
    setMessage('')
  }

  return (
    <main className="min-h-screen px-6 py-6">
      <div className="mx-auto grid max-w-[1600px] gap-6 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
        <aside className="glass-panel rounded-[2rem] p-5">
          <div className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">
            Channels
          </div>
          <div className="mt-4 grid gap-2">
            {channels.map((channel) => (
              <button
                key={channel.id}
                className={`rounded-2xl border px-4 py-3 text-left transition ${
                  channel.id === activeChannel?.id
                    ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]'
                    : 'border-[color:var(--line)] bg-white/70 hover:bg-white'
                }`}
                onClick={() => void navigate(`/channels/${channel.id}`)}
                type="button"
              >
                <div className="font-medium">{channel.label}</div>
                <div className="text-xs text-[color:var(--muted)]">{channel.visibility}</div>
              </button>
            ))}
          </div>

          <form className="mt-6 grid gap-3" onSubmit={createChannelSubmit}>
            <div className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">
              Create channel
            </div>
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
              Create
            </button>
          </form>
        </aside>

        <section className="grid gap-6">
          <header className="glass-panel rounded-[2rem] p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">
                  Workspace
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                  {activeChannel ? activeChannel.label : 'No channel selected'}
                </h1>
                <p className="mt-2 text-sm text-[color:var(--muted)]">
                  {activeChannel
                    ? activeChannel.visibility
                    : 'Create a channel to start the conversation surface.'}
                </p>
              </div>
              <div className="grid gap-2 text-right text-sm text-[color:var(--muted)]">
                <div>{agents.length} agents</div>
                <div>{tools.length} tools</div>
                <div>{threadMessages.length + pendingMessages.length} messages</div>
              </div>
            </div>
          </header>

          <section className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
            <div className="glass-panel rounded-[2rem] p-6">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-xl font-semibold">Thread</h2>
                <div className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">
                  {activeChannel?.defaultThreadId ?? 'No thread'}
                </div>
              </div>

              <div className="mt-5 grid gap-3">
                {threadMessages.map((entry) => (
                  <article
                    key={entry.id}
                    className="rounded-2xl border border-[color:var(--line)] bg-white/75 p-4"
                  >
                    <div className="flex items-center justify-between gap-3 text-xs text-[color:var(--muted)]">
                      <span>{entry.role}</span>
                      <span>{new Date(entry.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{entry.content}</p>
                  </article>
                ))}

                {pendingMessages.map((entry) => (
                  <article key={entry.runId} className={streamCardClass}>
                    <div className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
                      Streaming
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                      {entry.content || '...'}
                    </p>
                  </article>
                ))}

                {threadMessages.length === 0 && pendingMessages.length === 0 ? (
                  <div className={emptyStateClass}>
                    No messages yet. Send one to start the thread.
                  </div>
                ) : null}
              </div>

              <form className="mt-6 flex gap-3" onSubmit={sendMessageSubmit}>
                <input
                  className={`${fieldClass} flex-1`}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Write a message to the active channel"
                  value={message}
                />
                <button className={primaryButtonClass} type="submit">
                  Send
                </button>
              </form>
            </div>

            <div className="grid gap-6">
              <section className="glass-panel rounded-[2rem] p-6">
                <h2 className="text-xl font-semibold">Agents</h2>
                <div className="mt-4 grid gap-3">
                  {agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="rounded-2xl border border-[color:var(--line)] bg-white/75 p-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium">{agent.name}</div>
                          <div className="text-xs text-[color:var(--muted)]">{agent.role}</div>
                        </div>
                        <span className={`h-3 w-3 rounded-full ${statusClass(agent.status)}`} />
                      </div>
                      <div className="mt-2 text-xs text-[color:var(--muted)]">
                        {agent.channelIds.includes(activeChannel?.id ?? '')
                          ? 'Bound to this channel'
                          : 'Unbound here'}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="glass-panel rounded-[2rem] p-6">
                <h2 className="text-xl font-semibold">Create agent</h2>
                <form className="mt-4 grid gap-3" onSubmit={createAgentSubmit}>
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
              </section>

              <section className="glass-panel rounded-[2rem] p-6">
                <h2 className="text-xl font-semibold">Bind agent</h2>
                <form className="mt-4 grid gap-3" onSubmit={bindAgentSubmit}>
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
                    Bind
                  </button>
                </form>
              </section>
            </div>
          </section>
        </section>
      </div>
    </main>
  )
}
