import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useAgents, useBindAgent, useCreateAgent } from '../../facades/agents/hooks'
import { useChannels } from '../../facades/channels/hooks'
import type { AdminShellOutletContext } from '../../layouts/AdminShellLayout'
import { hoverCardClass, sectionTitleClass, SettingsPanel } from './settings-shared'

export const SettingsAgentsPage = () => {
  const { onSelectAgent } = useOutletContext<AdminShellOutletContext>()
  const { data: agents = [] } = useAgents()
  const { data: channels = [] } = useChannels()
  const createAgent = useCreateAgent()
  const bindAgent = useBindAgent()

  const [agentName, setAgentName] = useState('')
  const [agentRole, setAgentRole] = useState('assistant')
  const [agentPrompt, setAgentPrompt] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [bindTargetChannelId, setBindTargetChannelId] = useState('')

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

  return (
    <SettingsPanel eyebrow="Workspace" title="Agents">
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="admin-card p-4">
          <div className={sectionTitleClass}>Agents & bindings</div>
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
                  <div className="text-xs text-[color:var(--tx3)]">{agent.status}</div>
                </div>
                <div className="mt-2 text-sm text-[color:var(--tx2)]">
                  {agent.channelLabels.join(', ') || 'No channel bindings yet.'}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="admin-card p-4">
          <div className={sectionTitleClass}>Create & bind</div>
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
      </div>
    </SettingsPanel>
  )
}
