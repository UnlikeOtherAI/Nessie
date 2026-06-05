import type { AgentRecord, ChannelRecord, PersonalAssistantStateResponse } from '../../../lib/api-client'
import { AgentInfoCard } from '../agents/AgentInfoCard'
import { PersonalAssistantConfigBanner } from '../personal-assistant/PersonalAssistantSurface'
import { formatClock, getAgentGlyph, runsCardClass, type ChannelTab } from './channel-helpers'

interface ChannelTabPanelsProps {
  visibleActiveTab: ChannelTab
  isConversationSurface: boolean
  isPersonalAssistantConversation: boolean
  activeChannel: ChannelRecord | null
  boundAgents: AgentRecord[]
  scopedAgents: AgentRecord[]
  toolsCount: number
  pendingMessagesCount: number
  personalAssistantAgent: AgentRecord | null
  personalAssistantChannel: ChannelRecord | null
  personalAssistantState: PersonalAssistantStateResponse | null | undefined
  onSelectAgent: (agentId: string) => void
  onCreateAgent: () => void
}

export const ChannelTabPanels = ({
  visibleActiveTab,
  isConversationSurface,
  isPersonalAssistantConversation,
  activeChannel,
  boundAgents,
  scopedAgents,
  toolsCount,
  pendingMessagesCount,
  personalAssistantAgent,
  personalAssistantChannel,
  personalAssistantState,
  onSelectAgent,
  onCreateAgent,
}: ChannelTabPanelsProps) => (
  <>
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
            <span className="rounded-full border border-[color:var(--sep)] bg-black/10 px-3 py-1 text-xs font-semibold text-[color:var(--tx3)]">
              Upload backend next
            </span>
          </div>

          <div className="mt-5 rounded-xl border border-dashed border-[color:var(--sep)] bg-black/10 p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-white/6 text-[color:var(--tx2)]">
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
            <div className="mt-4 text-sm font-semibold text-white">No files yet</div>
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
            <div className="rounded-lg border border-[color:var(--sep)] bg-black/10 p-3">
              <div className="text-[color:var(--tx3)]">Surface</div>
              <div className="mt-1 font-semibold text-white">
                {isConversationSurface ? 'Conversation' : 'Channel'}
              </div>
            </div>
            <div className="rounded-lg border border-[color:var(--sep)] bg-black/10 p-3">
              <div className="text-[color:var(--tx3)]">Owner</div>
              <div className="mt-1 font-semibold text-white">
                {isPersonalAssistantConversation
                  ? 'Personal Assistant DM'
                  : activeChannel?.label ?? 'Current channel'}
              </div>
            </div>
            <div className="rounded-lg border border-[color:var(--sep)] bg-black/10 p-3 text-[color:var(--tx2)]">
              This tab is intentionally visible on every channel so file management has one
              predictable home.
            </div>
          </div>
        </aside>
      </div>
    ) : null}

    {visibleActiveTab === 'info' ? (
      <div className="p-5">
        {isPersonalAssistantConversation ? (
          <PersonalAssistantConfigBanner
            agent={personalAssistantAgent}
            channel={personalAssistantChannel}
            configSummary={personalAssistantState?.configSummary}
          />
        ) : boundAgents.length > 0 ? (
          <div className="grid gap-3">
            {boundAgents.map((agent) => (
              <AgentInfoCard agent={agent} key={agent.id} />
            ))}
          </div>
        ) : (
          <div className="admin-card p-4 text-sm text-[color:var(--tx3)]">
            No agents are bound to this channel.
          </div>
        )}
      </div>
    ) : null}

    {visibleActiveTab === 'runs' ? (
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        <section className="admin-card p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
            Active runs
          </div>
          <div className="mt-4 grid gap-3">
            {scopedAgents.length > 0 ? (
              scopedAgents.map((agent) => (
                <button
                  key={agent.id}
                  className={runsCardClass}
                  onClick={() => onSelectAgent(agent.id)}
                  type="button"
                >
                  <div
                    className={[
                      'mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center',
                      'rounded-md bg-[rgba(124,58,237,0.14)]',
                    ].join(' ')}
                  >
                    {getAgentGlyph(agent)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-white">
                        {agent.name}
                      </span>
                      <span
                        className={[
                          'rounded bg-white/6 px-1.5 py-0.5 text-[10px]',
                          'uppercase tracking-[0.16em] text-[color:var(--tx3)]',
                        ].join(' ')}
                      >
                        {agent.status}
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-[color:var(--tx2)]">
                      {agent.currentToolName ?? 'Idle'}
                    </div>
                    <div className="mt-2 text-xs text-[color:var(--tx3)]">
                      Last activity {formatClock(agent.lastActivityAt)}
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <div className="text-sm text-[color:var(--tx3)]">
                No agent runs in this channel yet.
              </div>
            )}
          </div>
        </section>

        <section className="admin-card p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
            Workspace signals
          </div>
          <div className="mt-4 grid gap-3 text-sm">
            <div className="admin-card p-3">
              <div className="text-[color:var(--tx3)]">Safe tools</div>
              <div className="mt-1 text-2xl font-semibold text-white">
                {toolsCount}
              </div>
            </div>
            <div className="admin-card p-3">
              <div className="text-[color:var(--tx3)]">Streaming messages</div>
              <div className="mt-1 text-2xl font-semibold text-white">
                {pendingMessagesCount}
              </div>
            </div>
            <div className="admin-card p-3">
              <div className="text-[color:var(--tx3)]">Bound agents</div>
              <div className="mt-1 text-2xl font-semibold text-white">
                {boundAgents.length}
              </div>
            </div>
          </div>
        </section>
      </div>
    ) : null}

    {visibleActiveTab === 'agents' ? (
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        {boundAgents.length > 0 ? (
          boundAgents.map((agent) => (
            <article key={agent.id} className="admin-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div
                    className={[
                      'flex h-9 w-9 items-center justify-center rounded-lg',
                      'bg-[rgba(124,58,237,0.14)] text-lg',
                    ].join(' ')}
                  >
                    {getAgentGlyph(agent)}
                  </div>
                  <div>
                    <div className="font-semibold text-white">{agent.name}</div>
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
