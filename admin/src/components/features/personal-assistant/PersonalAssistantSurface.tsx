import type { AgentRecord, ChannelRecord } from '../../../lib/api-client'
import { isPersonalAssistantChannel } from '../../../facades/personal-assistant/hooks'

type PersonalAssistantSidebarEntryProps = {
  active?: boolean
  bootstrapping?: boolean
  onClick: () => void
  unreadCount?: number
}

type PersonalAssistantConfigBannerProps = {
  agent?: AgentRecord | null
  channel?: ChannelRecord | null
}

const assistantGlyphClassName =
  'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ' +
  'bg-[rgba(124,58,237,0.18)] text-[10px] font-bold text-white'

const badgeClassName =
  'rounded bg-white/8 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ' +
  'text-[color:var(--tx3)]'

const pillClassName =
  'rounded-full border border-[rgba(124,58,237,0.18)] bg-[rgba(124,58,237,0.12)] ' +
  'px-2 py-0.5 text-[10px] font-semibold text-[#d8b4fe]'

const assistantPills = (agent?: AgentRecord | null, channel?: ChannelRecord | null) => {
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

  if (agent?.provider || agent?.model) {
    pills.push([agent.provider, agent.model].filter(Boolean).join(' / '))
  }

  return pills
}

export const PersonalAssistantSidebarEntry = ({
  active = false,
  bootstrapping = false,
  onClick,
  unreadCount = 0,
}: PersonalAssistantSidebarEntryProps) => (
  <button
    className={`admin-sb-item group ${active ? 'active' : ''}`}
    onClick={onClick}
    type="button"
  >
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
    <span className="min-w-0 flex-1 truncate text-sm font-medium text-current">
      Personal Assistant
    </span>
    <span className={badgeClassName}>PA</span>
    {bootstrapping ? (
      <span className="ml-1 h-4 w-4 animate-spin rounded-full border border-white/20 border-t-white/70" />
    ) : unreadCount > 0 ? (
      <span className="ml-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-[10px] font-bold text-white">
        {unreadCount}
      </span>
    ) : null}
  </button>
)

export const PersonalAssistantConfigBanner = ({
  agent,
  channel,
}: PersonalAssistantConfigBannerProps) => {
  if (!isPersonalAssistantChannel(channel)) {
    return null
  }

  const pills = assistantPills(agent, channel)

  return (
    <section className="mx-5 mt-3 rounded-xl border border-[rgba(124,58,237,0.18)] bg-[rgba(124,58,237,0.08)] px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[rgba(124,58,237,0.18)] text-lg">
          ⚡
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-white">
              {agent?.name ?? 'Personal Assistant'}
            </span>
            <span className={badgeClassName}>system managed</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-[color:var(--tx2)]">
            This DM stays private to you. Admin-managed settings can shape behavior,
            but the assistant still runs with your permissions.
          </p>
          {pills.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {pills.map((pill) => (
                <span className={pillClassName} key={pill}>
                  {pill}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
