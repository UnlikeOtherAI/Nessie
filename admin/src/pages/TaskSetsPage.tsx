import { useNavigate } from 'react-router-dom'
import type { TaskSetRecord } from '@nessie/schemas'
import { usePagedList } from '../facades/pagination/usePagedList'
import { taskSetKeys } from '../facades/task-sets/keys'
import { taskSetCreatePath, taskSetPath } from '../navigation/task-sets'
import { DataTable } from '../components/shared/DataTable'
import { PageBody } from '../components/shared/PageBody'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import type { SettingsTabHostProps } from '../components/shared/SettingsPanel'
import {
  TaskSetStatus, taskSetProgress, taskSetTimestamp,
} from '../components/features/task-sets/presentation'

/** Batch jobs — the second tab of Automations. */
export const TaskSetsPage = ({ host }: { host?: SettingsTabHostProps }) => {
  const navigate = useNavigate()
  const rows = usePagedList<TaskSetRecord>({ path: '/api/task-sets', queryKey: taskSetKeys.list })
  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        actions={[{
          id: 'create', label: 'New task set', primary: true, priority: 100,
          onSelect: () => navigate(taskSetCreatePath()),
        }]}
        eyebrow={host?.eyebrow}
        subtitle="Process ordered work one item at a time, and keep every result."
        tabs={host?.tabs}
        title={host?.title ?? 'Batch jobs'}
      />
      <PageBody>
        <QueryState
          emptyLabel="No task sets yet. Create one here, or choose Process with Task Set in Documents."
          errorLabel="Task sets could not be loaded."
          isEmpty={rows.items.length === 0}
          loadingLabel="Loading task sets…"
          query={rows.query}
        >
          {() => <>
            <DataTable
              columns={[
                { key: 'name', header: 'Task set', render: (set) => <div>
                  <div className="font-medium">{set.name}</div>
                  <div className="text-xs text-[color:var(--tx3)]">{set.processor.model}</div>
                </div> },
                { key: 'status', header: 'Status', render: (set) => <TaskSetStatus status={set.status} /> },
                { key: 'progress', header: 'Progress', render: taskSetProgress },
                { key: 'updated', header: 'Status updated', render: (set) => taskSetTimestamp(set.statusChangedAt) },
              ]}
              expandable={false}
              label="Task sets"
              onRowClick={(set) => navigate(taskSetPath(set.id))}
              rowActionLabel={(set) => `Open ${set.name}`}
              rowKey={(set) => set.id}
              rows={rows.items}
            />
            <PaginationFooter {...rows} />
          </>}
        </QueryState>
      </PageBody>
    </section>
  )
}
