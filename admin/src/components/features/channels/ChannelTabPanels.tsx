import type { AgentRecord, ChannelRecord, PersonalAssistantStateResponse } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { PersonalAssistantConfigBanner } from '../personal-assistant/PersonalAssistantSurface'
import { ChannelAutomationsPanel } from './ChannelAutomationsPanel'
import type { ChannelTab } from './channel-helpers'

interface ChannelTabPanelsProps {
  visibleActiveTab: ChannelTab
  isConversationSurface: boolean
  isPersonalAssistantConversation: boolean
  activeChannel: ChannelRecord | null
  boundAgents: AgentRecord[]
  personalAssistantAgent: AgentRecord | null
  personalAssistantChannel: ChannelRecord | null
  personalAssistantState: PersonalAssistantStateResponse | null | undefined
  onSelectAgent: (agentId: string) => void
  onCreateAgent: () => void
}

const PanelAgentAvatar = ({
  agent,
  className = '',
}: {
  agent: AgentRecord
  className?: string
}) => {
  const { token } = useAuthSession()
  return <AgentAvatar agent={agent} className={className} token={token} />
}

export const ChannelTabPanels = ({
  visibleActiveTab,
  isConversationSurface,
  isPersonalAssistantConversation,
  activeChannel,
  boundAgents,
  personalAssistantAgent,
  personalAssistantChannel,
  personalAssistantState,
  onSelectAgent,
  onCreateAgent,
}: ChannelTabPanelsProps) => (
  <>
    {visibleActiveTab === 'automations' && activeChannel ? (
      <ChannelAutomationsPanel channelId={activeChannel.id} />
    ) : null}
    {visibleActiveTab === 'files' ? (
      <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="admin-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                Conversation files
              </div>
              <p className="mt-2 text-sm leading-6 text-[color:var(--tx2)]">
                Files shared in this {isConversationSurface ? 'conversation' : 'channel'} will
                live here instead of getting mixed into runs or agent controls.
              </p>
            </div>
            <span className="rounded-full border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-1 text-xs font-semibold text-[color:var(--tx3)]">
              Upload backend next
            </span>
          </div>

          <div className="mt-5 rounded-xl border border-dashed border-[color:var(--sep)] bg-[var(--scrim-weak)] p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--overlay-weak)] text-[color:var(--tx2)]">
              <svg
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  d="M15.172 7 8.586 13.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656L5.757 10.757a6 6 0 108.486 8.486L20.5 13"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="mt-4 text-sm font-semibold text-[var(--tx)]">No files yet</div>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[color:var(--tx3)]">
              Attachment upload is the next backend step. Once it lands, files attached to
              messages and added directly to this surface will be searchable and manageable
              from this tab.
            </p>
          </div>
        </section>

        <aside className="admin-card p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
            Scope
          </div>
          <div className="mt-4 grid gap-3 text-sm">
            <div className="rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3">
              <div className="text-[color:var(--tx3)]">Surface</div>
              <div className="mt-1 font-semibold text-[var(--tx)]">
                {isConversationSurface ? 'Conversation' : 'Channel'}
              </div>
            </div>
            <div className="rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3">
              <div className="text-[color:var(--tx3)]">Owner</div>
              <div className="mt-1 font-semibold text-[var(--tx)]">
                {isPersonalAssistantConversation
                  ? 'Personal Assistant DM'
                  : activeChannel?.label ?? 'Current channel'}
              </div>
            </div>
            <div className="rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3 text-[color:var(--tx2)]">
              This tab is intentionally visible on every channel so file management has one
              predictable home.
            </div>
          </div>
        </aside>
      </div>
    ) : null}

    {visibleActiveTab === 'agents' ? (
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        {isPersonalAssistantConversation ? (
          <div className="lg:col-span-2">
            <PersonalAssistantConfigBanner
              agent={personalAssistantAgent}
              channel={personalAssistantChannel}
              configSummary={personalAssistantState?.configSummary}
            />
          </div>
        ) : null}

        {boundAgents.length > 0 ? (
          boundAgents.map((agent) => (
            <article key={agent.id} className="admin-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <PanelAgentAvatar agent={agent} />
                  <div>
                    <div className="font-semibold text-[var(--tx)]">{agent.name}</div>
                    <div className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                      {agent.role}
                    </div>
                  </div>
                </div>
                <button
                  className="admin-button admin-button-secondary"
                  onClick={() => onSelectAgent(agent.id)}
                  type="button"
                >
                  Open activity
                </button>
              </div>
              <div className="mt-4 text-sm leading-6 text-[color:var(--tx2)]">
                {agent.systemPrompt ?? 'No system prompt configured for this agent yet.'}
              </div>
              <div className="mt-4 flex items-center justify-between text-xs text-[color:var(--tx3)]">
                <span>Status: {agent.status}</span>
                <span>{agent.channelIds.length} channel bindings</span>
              </div>
            </article>
          ))
        ) : (
          <div className="admin-card p-4 text-sm text-[color:var(--tx3)]">
            No agents are bound to this channel yet. Use the admin page to create or
            bind one.
          </div>
        )}

        <div className="admin-card p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
            Manage agents
          </div>
          <p className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
            Create new agents, bind them to channels, and inspect tool access from the
            admin route.
          </p>
          <button
            className="admin-button admin-button-primary mt-4"
            onClick={onCreateAgent}
            type="button"
          >
            Create agent
          </button>
        </div>
      </div>
    ) : null}
  </>
)
