import { useMemo } from 'react'
import type { AppDetailRecord } from '@nessie/schemas'
import { TabBar, type TabBarItem } from '../../primitives/TabBar'
import { AppAgentAccessList } from './AppAgentAccessList'
import { AppCapabilityList } from './AppCapabilityList'
import { AppConnectionsList } from './AppConnectionsList'
import { AppOverviewTab } from './AppOverviewTab'
import { appDetailTabs, type AppDetailTab } from './app-detail-view'

type AppDetailTabsProps = {
  activeTab: AppDetailTab
  app: AppDetailRecord
  onConnectAnother: () => void
  onSelectTab: (tab: AppDetailTab) => void
}

/** Wires each tab to its panel: `app-detail-tab-*` ↔ `app-detail-tabpanel-*`. */
const TAB_ID_PREFIX = 'app-detail'

/**
 * Tabs rather than a drawer — the agent detail page settled the same question
 * the same way: a durable object with durable substates is a page whose every
 * substate stays linkable.
 *
 * The strip itself is the admin's one `TabBar`, so this page cannot drift from
 * the rest on shape, counts, or keyboard behaviour: a hand-rolled `role="tab"`
 * row looks right and is unusable without a mouse, because roving tabindex and
 * arrow/Home/End navigation are what a screen reader and keyboard expect of
 * anything announcing itself as a tablist.
 */
export const AppDetailTabs = ({
  activeTab,
  app,
  onConnectAnother,
  onSelectTab,
}: AppDetailTabsProps) => {
  // Memoised because `TabBar` observes its items to keep the sliding pill under
  // the selected one; a fresh array every render would re-subscribe each paint.
  const items = useMemo<ReadonlyArray<TabBarItem<AppDetailTab>>>(
    () =>
      appDetailTabs(app).map((tab) => ({
        // `null` is this view's "no number to show"; `TabBar` spells that
        // `undefined`, and `0` is a real count it renders.
        count: tab.count ?? undefined,
        label: tab.label,
        testId: `app-detail-tab-${tab.id}`,
        value: tab.id,
      })),
    [app],
  )

  return (
    <div className="grid gap-5">
      <div className="flex items-center">
        <TabBar
          ariaLabel="App sections"
          idPrefix={TAB_ID_PREFIX}
          items={items}
          onChange={onSelectTab}
          value={activeTab}
        />
      </div>

      <div
        aria-labelledby={`${TAB_ID_PREFIX}-tab-${activeTab}`}
        id={`${TAB_ID_PREFIX}-tabpanel-${activeTab}`}
        role="tabpanel"
      >
        {activeTab === 'overview' ? <AppOverviewTab app={app} /> : null}
        {activeTab === 'capabilities' ? <AppCapabilityList app={app} /> : null}
        {activeTab === 'accounts' ? (
          <AppConnectionsList app={app} onConnectAnother={onConnectAnother} />
        ) : null}
        {activeTab === 'agents' ? <AppAgentAccessList app={app} /> : null}
      </div>
    </div>
  )
}
