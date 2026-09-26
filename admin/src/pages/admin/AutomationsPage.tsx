import { TabBar } from '../../components/primitives/TabBar'
import type { SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useTabParam } from '../../navigation/useTabParam'
import { TaskSetsPage } from '../TaskSetsPage'
import { TriggersPage } from '../TriggersPage'
import { WorkflowsPage } from '../WorkflowsPage'

const AUTOMATION_TABS = ['triggers', 'batch-jobs', 'workflows'] as const

type AutomationTab = (typeof AUTOMATION_TABS)[number]

const TABS: ReadonlyArray<{ label: string; value: AutomationTab }> = [
  { label: 'Schedules and triggers', value: 'triggers' },
  { label: 'Batch jobs', value: 'batch-jobs' },
  { label: 'Workflows', value: 'workflows' },
]

// What one tab's list shows — its search, its filters, its selection, its
// page. A tab change is a different list, so these leave with it rather than
// narrowing the next one: `?search=` means a trigger phrase on one tab and a
// workflow phrase on another.
const TAB_OWNED_PARAMS = [
  'search', 'status', 'type', 'trigger',
  'template', 'installation', 'run', 'failedRuns', 'demonstrationDrafts',
  'cursor', 'direction', 'page',
]

/**
 * Admin › Automations: everything that runs without anybody asking — what
 * wakes an agent (Schedules and triggers), ordered work processed one item at a
 * time (Batch jobs), and multi-step workflows. One header with one strip; each
 * tab is the list page it replaced, with its own filters and links intact.
 */
export const AutomationsPage = () => {
  const [tab, selectTab] = useTabParam('tab', AUTOMATION_TABS, 'triggers', {
    clears: TAB_OWNED_PARAMS,
  })

  const host: SettingsTabHostProps = {
    eyebrow: 'Agents',
    tabs: (
      <TabBar
        ariaLabel="Automation kinds"
        items={TABS}
        onChange={selectTab}
        value={tab}
      />
    ),
    title: 'Automations',
  }

  if (tab === 'batch-jobs') return <TaskSetsPage host={host} />
  if (tab === 'workflows') return <WorkflowsPage host={host} />
  return <TriggersPage host={host} />
}
