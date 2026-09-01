import { TabBar, type TabBarItem } from '../../primitives/TabBar'
import type { ChannelTab } from './channel-helpers'

interface ChannelTabBarProps {
  visibleActiveTab: ChannelTab
  showAgentsTab: boolean
  showAutomationsTab: boolean
  onSelectTab: (tab: ChannelTab) => void
}

const TabIcon = ({ d, round }: { d: string; round?: boolean }) => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    {round ? <circle cx="12" cy="8" r="4" /> : null}
    <path d={d} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const MESSAGES_ICON = [
  'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8',
  'a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72',
  'C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
].join(' ')

const FILES_ICON =
  'M15.172 7 8.586 13.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656L5.757 10.757a6 6 0 108.486 8.486L20.5 13'

export const ChannelTabBar = ({
  visibleActiveTab,
  showAgentsTab,
  showAutomationsTab,
  onSelectTab,
}: ChannelTabBarProps) => {
  const items: Array<TabBarItem<ChannelTab>> = [
    { icon: <TabIcon d={MESSAGES_ICON} />, label: 'Messages', value: 'messages' },
    { icon: <TabIcon d={FILES_ICON} />, label: 'Files', value: 'files' },
    ...(showAutomationsTab
      ? [
          {
            icon: <TabIcon d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />,
            label: 'Automations',
            testId: 'channel-tab-automations',
            value: 'automations' as const,
          },
        ]
      : []),
    ...(showAgentsTab
      ? [
          {
            icon: <TabIcon d="M4 20c0-4 3.582-7 8-7s8 3 8 7" round />,
            label: 'Agents',
            value: 'agents' as const,
          },
        ]
      : []),
  ]

  return (
    <div className="flex items-center border-b border-[color:var(--sep)] px-3 py-1.5">
      <TabBar
        ariaLabel="Channel sections"
        items={items}
        onChange={onSelectTab}
        value={visibleActiveTab}
      />
    </div>
  )
}
