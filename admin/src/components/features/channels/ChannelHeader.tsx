import type { AgentRecord, ChannelRecord, UserRecord } from '../../../lib/api-client'
import { agentGradient, getInitials, pickGradient } from '../../../lib/avatar'
import { getAgentGlyph, toolbarButtonClass } from './channel-helpers'

interface ChannelHeaderProps {
  activeChannel: ChannelRecord | null
  isPersonalAssistantConversation: boolean
  channelUsers: UserRecord[]
  boundAgents: AgentRecord[]
  callEligible: boolean
  activeCall: boolean
  isInCall: boolean
  onOpenMembers: () => void
  onCallButton: () => void
}

export const ChannelHeader = ({
  activeChannel,
  isPersonalAssistantConversation,
  channelUsers,
  boundAgents,
  callEligible,
  activeCall,
  isInCall,
  onOpenMembers,
  onCallButton,
}: ChannelHeaderProps) => (
  <header className="flex h-[50px] items-center border-b border-[color:var(--sep)] px-5">
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {isPersonalAssistantConversation ? (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[rgba(124,58,237,0.18)] text-[9px] font-bold text-white">
          ⚡
        </div>
      ) : activeChannel?.type === 'dm' ? (
        <div
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
          style={{ background: 'linear-gradient(135deg,#6d28d9,#4f46e5)' }}
        >
          {activeChannel.label.slice(0, 1).toUpperCase()}
        </div>
      ) : (
        <span className="flex-shrink-0 text-lg font-bold text-[color:var(--tx3)]">
          #
        </span>
      )}
      <h1 className="truncate text-[17px] font-bold text-white">
        {isPersonalAssistantConversation
          ? 'Personal Assistant'
          : activeChannel?.label ?? 'channels'}
      </h1>
      {isPersonalAssistantConversation && (
        <span className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          system managed
        </span>
      )}
    </div>

    <div className="flex flex-shrink-0 items-center gap-2">
      <button
        className={[
          'flex items-center gap-2 rounded-lg px-2 py-1',
          isPersonalAssistantConversation ? 'cursor-default opacity-90' : 'hover:bg-white/5',
        ].join(' ')}
        onClick={() => {
          if (!isPersonalAssistantConversation) {
            onOpenMembers()
          }
        }}
        title={
          isPersonalAssistantConversation
            ? 'Personal Assistant is system-managed'
            : 'View channel members'
        }
        type="button"
      >
        <div className="flex -space-x-1.5">
          {channelUsers.slice(0, 3).map((user) => (
            <div
              key={user.id}
              className={[
                'flex h-6 w-6 items-center justify-center rounded-full border-2',
                'border-[color:var(--main)] text-[8px] font-bold text-white',
              ].join(' ')}
              style={{ background: pickGradient(user.id) }}
            >
              {getInitials(user.displayName, '?')}
            </div>
          ))}
          {boundAgents.slice(0, Math.max(0, 4 - channelUsers.length)).map((agent) => (
            <div
              key={agent.id}
              className={[
                'flex h-6 w-6 items-center justify-center rounded-full border-2',
                'border-[color:var(--main)] text-[10px]',
              ].join(' ')}
              style={{ background: agentGradient }}
            >
              {getAgentGlyph(agent)}
            </div>
          ))}
        </div>
        <span className="text-sm text-[color:var(--tx2)]">
          {channelUsers.length + boundAgents.length}
        </span>
      </button>
      <button
        className={[
          'relative flex h-7 w-7 items-center justify-center rounded',
          callEligible
            ? isInCall
              ? 'text-emerald-400 hover:bg-white/10'
              : 'text-[color:var(--tx3)] hover:bg-white/10'
          : 'cursor-not-allowed text-[color:var(--tx3)] opacity-40',
        ].join(' ')}
        disabled={!callEligible}
        onClick={onCallButton}
        title={
          isPersonalAssistantConversation
            ? 'Personal Assistant does not support calls'
            : callEligible
            ? activeCall
              ? isInCall
                ? 'Toggle call overlay'
                : 'Join call'
              : 'Start a call'
            : 'You can only start a call with humans for now'
        }
        type="button"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path
            d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {activeCall && !isInCall && (
          <span className="absolute right-0.5 top-0.5 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        )}
      </button>
      <div className="mx-1 h-5 w-px bg-[color:var(--border-strong)]" />
      <button className={toolbarButtonClass} type="button">
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <button className={toolbarButtonClass} type="button">
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path
            d="M4 6h16M4 12h16M4 18h16"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  </header>
)
