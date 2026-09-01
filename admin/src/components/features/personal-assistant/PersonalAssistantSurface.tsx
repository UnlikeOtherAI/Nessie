import type {
  AgentRecord,
  ChannelRecord,
  PersonalAssistantConfigSummary,
} from '../../../lib/api-client'
import { isPersonalAssistantChannel } from '../../../facades/personal-assistant/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Pill } from '../../primitives/Pill'
import { AgentAvatar } from '../../shared/AgentAvatar'

type PersonalAssistantSidebarEntryProps = {
  active?: boolean
  agent?: AgentRecord | null
  bootstrapping?: boolean
  onClick: () => void
  onToggleStar: () => void
  starred?: boolean
  token: string | null
  unreadCount?: number
}

type PersonalAssistantConfigBannerProps = {
  agent?: AgentRecord | null
  channel?: ChannelRecord | null
  configSummary?: PersonalAssistantConfigSummary
}

const assistantGlyphClassName =
  'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ' +
  'bg-[var(--accent-soft)] text-[10px] font-bold text-[var(--thinking)]'

const assistantPills = (
  agent?: AgentRecord | null,
  channel?: ChannelRecord | null,
  configSummary?: PersonalAssistantConfigSummary,
) => {
  const pills: Array<string> = []

  if (agent?.systemManaged) {
    pills.push('System managed')
  }

  if (agent?.surfacePolicy) {
    pills.push(agent.surfacePolicy === 'dm_only' ? 'DM only' : 'Shared surface')
  } else if (isPersonalAssistantChannel(channel)) {
    pills.push('DM only')
  }

  if (agent?.delegationMode) {
    pills.push(
      agent.delegationMode === 'act_as_requesting_user' ? 'Acts as user' : 'No delegation',
    )
  }

  const providerModel = [agent?.provider, agent?.model]
    .filter(Boolean)
    .join(' / ')
    || [configSummary?.provider, configSummary?.model].filter(Boolean).join(' / ')

  if (providerModel) {
    pills.push(providerModel)
  }

  return pills
}

export const PersonalAssistantSidebarEntry = ({
  active = false,
  agent,
  bootstrapping = false,
  onClick,
  onToggleStar,
  starred = false,
  token,
  unreadCount = 0,
}: PersonalAssistantSidebarEntryProps) => {
  return (
    <button
      className={`admin-sb-item group ${unreadCount > 0 ? 'unread' : ''} ${active ? 'active' : ''}`}
      onClick={onClick}
      type="button"
    >
      {agent ? (
        <AgentAvatar agent={agent} size="xs" token={token} />
      ) : (
        <div className={assistantGlyphClassName}>
          <svg
            fill="none"
            height="10"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="10"
          >
            <path d="M12 3v5" />
            <path d="M9 8h6" />
            <path d="M8 11a4 4 0 018 0v4a4 4 0 01-8 0z" />
          </svg>
        </div>
      )}
      <span className="min-w-0 flex-1 truncate text-current">
        Personal Assistant
      </span>
      {bootstrapping ? (
        <span className="ml-1 h-4 w-4 animate-spin rounded-full border border-[var(--overlay-strong)] border-t-[var(--on-accent)]" />
      ) : unreadCount > 0 ? (
        <span className="ml-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-[10px] font-bold text-[var(--on-accent)]">
          {unreadCount}
        </span>
      ) : null}
      {agent ? (
        <span
          className={[
            'sidebar-row-star flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
            starred
              ? 'ml-1 text-[color:var(--warning-text)] opacity-100'
              : 'ml-auto text-[color:var(--tx3)] opacity-0 group-hover:opacity-100',
          ].join(' ')}
          onClick={(event) => {
            event.stopPropagation()
            onToggleStar()
          }}
        >
          {starred ? '★' : '☆'}
        </span>
      ) : null}
    </button>
  )
}

export const PersonalAssistantConfigBanner = ({
  agent,
  channel,
  configSummary,
}: PersonalAssistantConfigBannerProps) => {
  const { token } = useAuthSession()

  if (!isPersonalAssistantChannel(channel)) {
    return null
  }

  const pills = assistantPills(agent, channel, configSummary)

  return (
    <section className="mx-5 mt-3 rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3">
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size="md" token={token} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--tx)]">
              {agent?.name ?? 'Personal Assistant'}
            </span>
            <Pill radius="chip" size="sm" tone="muted">
              system managed
            </Pill>
          </div>
          <p className="mt-1 text-xs leading-5 text-[color:var(--tx2)]">
            This DM stays private to you. Admin-managed settings can shape behavior,
            but the assistant still runs with your permissions.
          </p>
          {pills.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {pills.map((pill) => (
                <Pill
                  className="border border-[var(--accent)] font-semibold"
                  key={pill}
                  radius="capsule"
                  size="sm"
                  tone="accent"
                  uppercase={false}
                >
                  {pill}
                </Pill>
              ))}
            </div>
          )}
          {configSummary ? (
            <div className="mt-3 grid gap-2 text-xs leading-5 text-[color:var(--tx2)]">
              <div>
                <span className="font-semibold text-[var(--tx)]">Prompt preview:</span>{' '}
                {configSummary.systemPromptPreview?.trim() || 'No custom system prompt configured.'}
              </div>
              <div>
                <span className="font-semibold text-[var(--tx)]">Enabled tools:</span>{' '}
                {configSummary.toolIds.length > 0 ? configSummary.toolIds.join(', ') : 'No tool overrides enabled.'}
              </div>
              <div>
                <span className="font-semibold text-[var(--tx)]">Config updated:</span>{' '}
                {new Date(configSummary.updatedAt).toLocaleString()}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
