import type { AppDetailRecord } from '@nessie/schemas'
import { AppAgentAccessList } from './AppAgentAccessList'
import { AppCapabilityList } from './AppCapabilityList'
import { AppConnectionsList } from './AppConnectionsList'
import { AppOverviewTab } from './AppOverviewTab'
import { appDetailTabs, type AppDetailTab } from './app-detail-view'

type AppDetailTabsProps = {
  activeTab: AppDetailTab
  app: AppDetailRecord
  onSelectTab: (tab: AppDetailTab) => void
}

// Inline text tabs, matching the agent detail page — the same decision was made
// there and won: a durable object with durable substates is a page with tabs,
// not a drawer, so every substate stays linkable.
export const AppDetailTabs = ({ activeTab, app, onSelectTab }: AppDetailTabsProps) => {
  const tabs = appDetailTabs(app)

  return (
    <div className="grid gap-5">
      <div
        className="flex gap-4 overflow-x-auto border-b border-[color:var(--sep)]"
        role="tablist"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTab
          return (
            <button
              aria-selected={active}
              className={[
                'shrink-0 whitespace-nowrap border-b-2 pb-2 pt-1',
                'transition-colors duration-[var(--duration-fast)]',
                active
                  ? 'border-[color:var(--accent)] text-[color:var(--tx)]'
                  : 'border-transparent text-[color:var(--tx3)] hover:text-[color:var(--tx2)]',
              ].join(' ')}
              data-testid={`app-detail-tab-${tab.id}`}
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              role="tab"
              type="button"
            >
              {/* The type scale lives on this span: the unlayered `font:
                  inherit` control reset makes `text-sm` inert on a button. */}
              <span className="text-sm font-medium">{tab.label}</span>
              {tab.count !== null ? (
                <span className="ml-1 text-sm text-[color:var(--tx3)]">({tab.count})</span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div role="tabpanel">
        {activeTab === 'overview' ? <AppOverviewTab app={app} /> : null}
        {activeTab === 'capabilities' ? <AppCapabilityList app={app} /> : null}
        {activeTab === 'accounts' ? <AppConnectionsList app={app} /> : null}
        {activeTab === 'agents' ? <AppAgentAccessList app={app} /> : null}
      </div>
    </div>
  )
}
