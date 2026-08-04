export type IntegrationTab = {
  id: string
  label: string
}

type IntegrationTabsProps = {
  activeTab: string
  onSelect: (tabId: string) => void
  tabs: IntegrationTab[]
}

// A small shared tab strip keeps product workflows navigable without giving
// every integration a one-off interaction pattern.
export const IntegrationTabs = ({ activeTab, onSelect, tabs }: IntegrationTabsProps) => (
  <div
    aria-label="Integration sections"
    className="flex gap-1 overflow-x-auto border-b border-[var(--sep)]"
    role="tablist"
  >
    {tabs.map((tab) => (
      <button
        aria-controls={`integration-tabpanel-${tab.id}`}
        aria-selected={activeTab === tab.id}
        className={[
          'shrink-0 border-b-2 px-3 py-2 text-sm font-semibold transition',
          activeTab === tab.id
            ? 'border-[var(--accent)] text-[var(--tx)]'
            : 'border-transparent text-[var(--tx3)] hover:text-[var(--tx2)]',
        ].join(' ')}
        id={`integration-tab-${tab.id}`}
        key={tab.id}
        onClick={() => onSelect(tab.id)}
        role="tab"
        type="button"
      >
        {tab.label}
      </button>
    ))}
  </div>
)
