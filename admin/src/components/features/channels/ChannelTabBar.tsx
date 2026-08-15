import type { ChannelTab } from './channel-helpers'

interface ChannelTabBarProps {
  visibleActiveTab: ChannelTab
  showAgentsTab: boolean
  showAutomationsTab: boolean
  onSelectTab: (tab: ChannelTab) => void
}

export const ChannelTabBar = ({
  visibleActiveTab,
  showAgentsTab,
  showAutomationsTab,
  onSelectTab,
}: ChannelTabBarProps) => (
  <div className="flex h-9 items-center border-b border-[color:var(--sep)] px-3">
    <button
      className={`admin-tab ${visibleActiveTab === 'messages' ? 'active' : ''}`}
      onClick={() => onSelectTab('messages')}
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
          d={[
            'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8',
            'a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72',
            'C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
          ].join(' ')}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Messages
    </button>
    <button
      className={`admin-tab ${visibleActiveTab === 'files' ? 'active' : ''}`}
      onClick={() => onSelectTab('files')}
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
          d="M15.172 7 8.586 13.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656L5.757 10.757a6 6 0 108.486 8.486L20.5 13"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Files
    </button>
    {showAutomationsTab ? (
      <button
        className={`admin-tab ${visibleActiveTab === 'automations' ? 'active' : ''}`}
        data-testid="channel-tab-automations"
        onClick={() => onSelectTab('automations')}
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
            d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Automations
      </button>
    ) : null}
    {showAgentsTab ? (
      <button
        className={`admin-tab ${visibleActiveTab === 'agents' ? 'active' : ''}`}
        onClick={() => onSelectTab('agents')}
        type="button"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="8" r="4" />
          <path
            d="M4 20c0-4 3.582-7 8-7s8 3 8 7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Agents
      </button>
    ) : null}
  </div>
)
